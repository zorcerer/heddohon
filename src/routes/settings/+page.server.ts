import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { config } from '$lib/server/config';
import { destroyAllSessions, endSessions, listSessions } from '$lib/server/auth';
import { getSettings, saveSettings } from '$lib/server/settings';
import { cacheStats, clearCache } from '$lib/server/covercache';
import { filledBy, fillStatus } from '$lib/server/coverfill';
import {
	linkDiscord,
	linkedIntegrations,
	linkListenBrainz,
	offeredIntegrations,
	unlinkIntegration,
	type LinkFailure
} from '$lib/server/integrations';
import { backendFor, UpstreamError, type ScrobblerService } from '$lib/server/backends';
import { linkStateDigest } from '$lib/server/crypto';
import { log, reason } from '$lib/server/log';
import { describeShares, revokeAllShares, revokeShare } from '$lib/server/shares';
import { clearHistory, importPlays, recentPlays } from '$lib/server/history';
import { getProfile } from '$lib/server/listening';
import { pluginHeard, pluginOffered, requestImport } from '$lib/server/plugin';

/**
 * How long the import action waits for the Navidrome plugin to send the whole
 * scrobble history before it answers that the import is still arriving. The
 * plugin starts within 15 seconds and sends 1000 plays a request.
 */
const IMPORT_WAIT_MS = 45_000;

/**
 * A ListenBrainz user token as issued: a UUID, 36 characters. Up to 128 of the
 * same alphabet are allowed in case the format grows. It is passed to the
 * music server as a JSON string and nowhere else.
 */
const LISTENBRAINZ_TOKEN = /^[A-Za-z0-9-]{1,128}$/;
const SERVICES: ScrobblerService[] = ['lastfm', 'listenbrainz'];

/**
 * The failure an action returns for an upstream error. A rejected credential
 * ends every session for the account, as `library()` does for page loads.
 */
async function scrobblerFailure(locals: App.Locals, err: unknown, step: string) {
	if (err instanceof UpstreamError && err.kind === 'auth' && locals.session) {
		await destroyAllSessions(locals.session.account.id);
		return fail(401, { scrobblerError: 'Your music server credentials are no longer valid. Sign in again.' });
	}
	log.warn('scrobbler-failed', { step, detail: reason(err) });
	if (err instanceof UpstreamError && err.status === 429) {
		return fail(429, { scrobblerError: 'The music server is limiting sign-ins. Try again in a minute.' });
	}
	return fail(502, { scrobblerError: 'The music server did not complete that. Try again.' });
}

export const load: PageServerLoad = async ({ locals }) => {
	const session = locals.session!;
	const cfg = config();

	/*
	 * Streamed: it is two calls to Navidrome's own API, with a sign-in there
	 * first when no session token is held, and nothing else on the page depends
	 * on it. Null where the server cannot link either service, or the status
	 * could not be read.
	 */
	const scrobblers = backendFor(session.account.backend).scrobblers;
	const scrobblerLinks = scrobblers
		? scrobblers.status(session.credential).catch((err) => {
				log.warn('scrobbler-failed', { step: 'status', detail: reason(err) });
				return null;
			})
		: Promise.resolve(null);

	// Independent reads, started together. Awaited in turn, the page waited for
	// the sum of a directory scan, two upstream calls and two database reads.
	const offered = offeredIntegrations();
	const [coverCache, coverFillKeeper, isAdmin, settings, sessions, shares, history, linked, upstream, profile] = await Promise.all([
		cacheStats(),
		filledBy(session.account.backend),
		/*
		 * Read here, not stored at sign-in: only this page shows it, and an
		 * account promoted on the music server since does not have to sign in
		 * again. Null where the server does not answer, which changes nothing
		 * the page allows.
		 */
		backendFor(session.account.backend).isAdmin(session.credential),
		// Read again, not taken from `locals`: after the save action this load
		// runs in the same request, and `locals` holds the settings from before.
		getSettings(session.account.id),
		listSessions(session),
		describeShares(session),
		recentPlays(session.account.id, 0, 0),
		linkedIntegrations(session.account.id),
		// Waited for only where it decides what the page offers, below.
		offered.listenbrainz && scrobblers ? scrobblerLinks : null,
		// What the account shows the others here, where that is offered; see `listening.ts`.
		cfg.listeners && cfg.remoteControl ? getProfile(session.account.id) : null
	]);

	/*
	 * ListenBrainz is one setting for an account. Where the music server links
	 * it itself (Navidrome, under Scrobbling) this server's own is not offered:
	 * the page showed two token fields for one service, and both linked would
	 * send each play twice. An account that linked it here before keeps the
	 * row, to unlink it.
	 */
	const viaMusicServer = upstream?.listenbrainz.available === true;

	return {
		coverCache,
		coverFill: fillStatus(session.account.id),
		// Whether the fill is repeated daily, by this administrator or another.
		coverFillDaily: coverFillKeeper !== null,
		isAdmin,
		settings,
		account: session.account,
		serverLabel:
			cfg.upstreams.find((upstream) => upstream.kind === session.account.backend)?.label ?? '',
		sessionExpiresAt: session.expiresAt,
		sessionMaxHours: cfg.sessionMaxHours,
		sessions,
		shares,
		scrobblerLinks,
		// Which of a Discord channel and ListenBrainz this account is offered, and
		// the name of what it has linked. Never the webhook or the token.
		integrations: {
			offered: { ...offered, listenbrainz: offered.listenbrainz && (!viaMusicServer || linked.listenbrainz !== null) },
			linked,
			viaMusicServer
		},
		historyCount: history.total,
		/*
		 * Where the Navidrome plugin's endpoint is on for this account: whether
		 * the plugin has been heard from in the last minute. Null where it is
		 * off, and the page says nothing of it.
		 */
		plugin: pluginOffered(session.account.backend) ? { heard: pluginHeard() } : null,
		// As the `listeners` event carries it, which replaces it once the stream is open.
		profile: profile && { id: profile.handle, name: profile.name, shown: profile.shown, avatar: profile.avatarAt }
	};
};

export const actions: Actions = {
	save: async ({ locals, request }) => {
		const session = locals.session;
		if (!session) return fail(401, { error: 'Not signed in' });

		const form = await request.formData();
		const bool = (name: string) => form.get(name) === 'on';

		const settings = await saveSettings(session.account.id, {
			theme: form.get('theme'),
			transition: form.get('transition'),
			crossfadeSeconds: Number(form.get('crossfadeSeconds')),
			crossfadeWithinAlbum: bool('crossfadeWithinAlbum'),
			gridSize: form.get('gridSize'),
			uiScale: form.get('uiScale'),
			font: form.get('font'),
			defaultAlbumSort: form.get('defaultAlbumSort'),
			normalizeVolume: bool('normalizeVolume'),
			aurora: form.get('aurora'),
			reportPlayback: bool('reportPlayback'),
			showQualityBadge: bool('showQualityBadge'),
			preloadNext: bool('preloadNext'),
			transcode: bool('transcode'),
			transcodeCodec: form.get('transcodeCodec'),
			transcodeBitrateKbps: Number(form.get('transcodeBitrateKbps'))
		});

		return { saved: true, settings };
	},

	/**
	 * Signs out one of the account's other sessions, by the handle the list
	 * shows. This browser signs out through `/logout`, which also clears its
	 * cookie.
	 */
	endSession: async ({ locals, request }) => {
		const session = locals.session;
		if (!session) return fail(401, { error: 'Not signed in' });
		const handle = (await request.formData()).get('handle');
		if (typeof handle !== 'string' || !/^[0-9a-f]{16}$/.test(handle) || handle === session.handle) {
			return fail(400, { sessionError: 'That session cannot be signed out from here.' });
		}
		if ((await endSessions(session, [handle])) === 0) {
			return fail(404, { sessionError: 'That session had already ended.' });
		}
		return { endedSessions: 1 };
	},

	/** Signs out every session of the account but this one. */
	endOtherSessions: async ({ locals }) => {
		const session = locals.session;
		if (!session) return fail(401, { error: 'Not signed in' });
		return { endedSessions: await endSessions(session, 'others') };
	},

	/** Withdraws one of this account's own links. See `revokeShare`. */
	revokeShare: async ({ locals, request }) => {
		const session = locals.session;
		if (!session) return fail(401, { error: 'Not signed in' });
		const id = (await request.formData()).get('id');
		if (typeof id !== 'string' || id.length > 64 || !await revokeShare(session.account.id, id)) {
			return fail(404, { shareError: 'That link was already gone.' });
		}
		return { revoked: true };
	},

	/**
	 * Withdraws every link the account holds. Signing out does not do this: a
	 * link plays through the stored credential, not through a session.
	 */
	revokeAllShares: async ({ locals }) => {
		const session = locals.session;
		if (!session) return fail(401, { error: 'Not signed in' });
		return { revoked: true, revokedAll: await revokeAllShares(session.account.id) };
	},

	/**
	 * Hands a ListenBrainz token to the music server, which checks it against
	 * ListenBrainz and stores it. Heddohon keeps nothing.
	 */
	linkListenBrainz: async ({ locals, request }) => {
		const session = locals.session;
		if (!session) return fail(401, { error: 'Not signed in' });
		const scrobblers = backendFor(session.account.backend).scrobblers;
		if (!scrobblers) return fail(404, { scrobblerError: 'This music server cannot link ListenBrainz.' });
		const token = String((await request.formData()).get('token') ?? '').trim();
		if (!LISTENBRAINZ_TOKEN.test(token)) {
			return fail(400, { scrobblerError: 'That is not a ListenBrainz token. Copy it from your ListenBrainz settings.' });
		}
		// The other way round from `linkIntegration`: this server already sends them.
		if ((await linkedIntegrations(session.account.id)).listenbrainz) {
			return fail(409, {
				scrobblerError:
					'ListenBrainz is already linked under “Your plays, elsewhere”. Unlink it there first: with both, each play would be sent twice.'
			});
		}
		try {
			if (!(await scrobblers.linkListenBrainz(session.credential, token))) {
				return fail(400, { scrobblerError: 'ListenBrainz did not accept that token.' });
			}
		} catch (err) {
			return scrobblerFailure(locals, err, 'listenbrainz-link');
		}
		log.info('scrobbler-linked', { service: 'listenbrainz' });
		return { scrobblerLinked: 'listenbrainz' as const };
	},

	unlinkScrobbler: async ({ locals, request }) => {
		const session = locals.session;
		if (!session) return fail(401, { error: 'Not signed in' });
		const scrobblers = backendFor(session.account.backend).scrobblers;
		const service = (await request.formData()).get('service') as ScrobblerService;
		if (!scrobblers || !SERVICES.includes(service)) return fail(400, { scrobblerError: 'Unknown service.' });
		try {
			await scrobblers.unlink(session.credential, service);
		} catch (err) {
			return scrobblerFailure(locals, err, `${service}-unlink`);
		}
		log.info('scrobbler-unlinked', { service });
		return { scrobblerUnlinked: service };
	},

	/**
	 * Returns the last.fm approval page to send the browser to. That page sends
	 * the browser back to `/settings/lastfm` with a token, which that route
	 * hands to the music server.
	 *
	 * Returned for the page to navigate to, not as a redirect: a 303 from a
	 * form post to another origin is refused by `form-action 'self'`, and
	 * `goto` in the enhanced form refuses external URLs.
	 *
	 * `state` ties the return to this account: a callback that arrives with
	 * another session, or with a link token this account was not given, is
	 * refused there before anything reaches the music server.
	 */
	startLastfm: async ({ locals, url }) => {
		const session = locals.session;
		if (!session) return fail(401, { error: 'Not signed in' });
		const scrobblers = backendFor(session.account.backend).scrobblers;
		if (!scrobblers) return fail(404, { scrobblerError: 'This music server cannot link Last.fm.' });
		let start;
		try {
			start = await scrobblers.startLastfm(session.credential);
		} catch (err) {
			return scrobblerFailure(locals, err, 'lastfm-start');
		}
		if (!start) return fail(404, { scrobblerError: 'Last.fm is turned off on this music server.' });

		const callback = new URL('/settings/lastfm', url.origin);
		callback.searchParams.set('uid', start.linkToken);
		callback.searchParams.set('state', linkStateDigest(`${session.account.id}\u0000${start.linkToken}`));
		const approval = new URL('https://www.last.fm/api/auth/');
		approval.searchParams.set('api_key', start.apiKey);
		approval.searchParams.set('cb', callback.toString());
		return { lastfmUrl: approval.toString() };
	},

	/**
	 * Links a Discord channel (a webhook address) or ListenBrainz (a user
	 * token) for the account's plays; see `integrations.ts`. The value is
	 * checked with the service, sealed, and not sent back.
	 */
	linkIntegration: async ({ locals, request }) => {
		const session = locals.session;
		if (!session) return fail(401, { error: 'Not signed in' });
		const form = await request.formData();
		const kind = form.get('kind');
		const value = String(form.get('value') ?? '').trim();
		if ((kind !== 'discord' && kind !== 'listenbrainz') || value.length === 0 || value.length > 300) {
			return fail(400, { integrationError: 'That cannot be linked.' });
		}
		// Where Navidrome links ListenBrainz itself, that is the one place for
		// it; see `load`.
		const scrobblers = backendFor(session.account.backend).scrobblers;
		if (kind === 'listenbrainz' && scrobblers) {
			const upstream = await scrobblers.status(session.credential).catch(() => null);
			if (upstream?.listenbrainz.available) {
				return fail(409, {
					integrationError: 'ListenBrainz is linked under Scrobbling on this server, where the music server sends each play.'
				});
			}
		}
		const result =
			kind === 'discord'
				? await linkDiscord(session.account.id, value)
				: await linkListenBrainz(session.account.id, value);
		if (typeof result !== 'string') return { integrationLinked: kind };
		const service = kind === 'discord' ? 'Discord' : 'ListenBrainz';
		const messages: Record<LinkFailure, [number, string]> = {
			off: [404, `${service} is not turned on for this server.`],
			malformed: [
				400,
				kind === 'discord'
					? 'That is not a Discord webhook address. Copy it from the channel under Integrations, Webhooks.'
					: 'That is not a ListenBrainz token. Copy it from your ListenBrainz settings.'
			],
			refused: [400, kind === 'discord' ? 'Discord has no webhook at that address.' : 'ListenBrainz did not accept that token.'],
			unreachable: [502, `${service} did not answer. Try again.`],
			throttled: [429, 'That is several attempts in a row. Try again in a few minutes.']
		};
		const [status, integrationError] = messages[result];
		return fail(status, { integrationError });
	},

	unlinkIntegration: async ({ locals, request }) => {
		const session = locals.session;
		if (!session) return fail(401, { error: 'Not signed in' });
		const kind = (await request.formData()).get('kind');
		if (kind !== 'discord' && kind !== 'listenbrainz') return fail(400, { integrationError: 'Unknown service.' });
		await unlinkIntegration(session.account.id, kind);
		return { integrationUnlinked: kind };
	},

	/**
	 * Empties the cover cache. Not per account: the cache holds the music
	 * server's artwork, the same bytes for everyone signed in to it. Any
	 * account can clear it, and each cover is then fetched upstream once more.
	 */
	clearCovers: async ({ locals }) => {
		if (!locals.session) return fail(401, { error: 'Not signed in' });
		await clearCache();
		return { cleared: true, coverCache: await cacheStats() };
	},

	clearHistory: async ({ locals }) => {
		if (!locals.session) return fail(401, { error: 'Not signed in' });
		await clearHistory(locals.session.account.id);
		return { historyCleared: true };
	},

	/**
	 * Brings the music server's last play of each song into the history, once.
	 * See `importPlays` for what is skipped. On Navidrome the read walks the
	 * whole library, 500 songs a request.
	 */
	importHistory: async ({ locals }) => {
		const session = locals.session;
		if (!session) return fail(401, { error: 'Not signed in' });
		const backend = backendFor(session.account.backend);
		const { historyDays } = await getSettings(session.account.id);
		const read = () => backend.getPlayedSongs(session.credential);
		let result;
		try {
			/*
			 * With the Navidrome plugin running, every play Navidrome kept and
			 * not only the last of each song. The plugin is asked at its next
			 * poll, up to 15 seconds away, and this waits for the last page.
			 */
			if (pluginOffered(session.account.backend) && pluginHeard()) {
				const asked = await requestImport(session.account, read, historyDays);
				if (asked === 'busy') {
					return fail(503, { historyImportError: 'Other accounts are importing. Try again in a few minutes.' });
				}
				if (asked === null) return fail(409, { historyImportError: 'An import is already running for this account.' });
				const outcome = await Promise.race([
					asked,
					new Promise<null>((resolve) => setTimeout(() => resolve(null), IMPORT_WAIT_MS).unref())
				]);
				// Still arriving: it goes on without this request.
				if (outcome === null) return { historyImportPending: true };
				if (outcome === 'failed') {
					return fail(502, {
						historyImportError:
							'Navidrome did not send the history. Its Heddohon plugin has to be allowed your user, under Plugins in Navidrome.'
					});
				}
				return { historyImported: outcome, historyImportFull: true };
			}
			result = await importPlays(session.account.id, read, historyDays);
		} catch (err) {
			if (err instanceof UpstreamError && err.kind === 'auth') {
				await destroyAllSessions(session.account.id);
				return fail(401, { historyImportError: 'Your music server credentials are no longer valid. Sign in again.' });
			}
			log.warn('history-import-failed', { detail: reason(err) });
			return fail(502, { historyImportError: 'The music server did not answer. Try again.' });
		}
		if (!result) return fail(409, { historyImportError: 'An import is already running for this account.' });
		log.info('history-imported', { found: result.found, imported: result.imported });
		return { historyImported: result };
	}
};
