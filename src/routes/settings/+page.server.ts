import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { config } from '$lib/server/config';
import { destroyAllSessions, endSessions, listSessions } from '$lib/server/auth';
import { getSettings, saveSettings } from '$lib/server/settings';
import { cacheStats, clearCache } from '$lib/server/covercache';
import { filledBy, fillStatus } from '$lib/server/coverfill';
import { backendFor, UpstreamError, type ScrobblerService } from '$lib/server/backends';
import { linkStateDigest } from '$lib/server/crypto';
import { log, reason } from '$lib/server/log';
import { describeShares, revokeAllShares, revokeShare } from '$lib/server/shares';
import { clearHistory, importPlays, recentPlays } from '$lib/server/history';

/**
 * A ListenBrainz user token as ListenBrainz issues it: a UUID, 36 characters.
 * Allowed up to 128 of the same alphabet in case the format grows; it is
 * passed to the music server as a JSON string and nowhere else.
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
	 * Streamed rather than awaited: it is two calls to Navidrome's own API,
	 * with a sign-in there first when no session token is held, and nothing
	 * else on the page depends on it. Null where the server cannot link either
	 * service, or the status could not be read.
	 */
	const scrobblers = backendFor(session.account.backend).scrobblers;
	const scrobblerLinks = scrobblers
		? scrobblers.status(session.credential).catch((err) => {
				log.warn('scrobbler-failed', { step: 'status', detail: reason(err) });
				return null;
			})
		: Promise.resolve(null);

	// Independent reads, started together. They were awaited one after
	// another, so the page waited for the sum of a directory scan, two upstream
	// calls and two database reads rather than for the slowest of them.
	const [coverCache, coverFillKeeper, isAdmin, settings, sessions, shares, history] = await Promise.all([
		cacheStats(),
		filledBy(session.account.backend),
		/*
		 * Read here rather than stored at sign-in: this is the only page that
		 * shows it, it costs one upstream request where a login costs none, and
		 * an account promoted on the music server this morning should not have to
		 * sign in again for the page to say so. Null where the server does not
		 * answer, which changes nothing about what the page allows.
		 */
		backendFor(session.account.backend).isAdmin(session.credential),
		// Read again rather than taken from `locals`: after the save action
		// this load runs in the same request, and `locals` still holds the
		// settings from before the save.
		getSettings(session.account.id),
		listSessions(session),
		describeShares(session),
		recentPlays(session.account.id, 0, 0)
	]);

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
		historyCount: history.total
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
	 * Empties the cover cache.
	 *
	 * Deliberately not per account: the cache holds the music server's artwork,
	 * which is the same bytes for everyone signed in to it, and a per-account
	 * copy of the same sleeve would be the thing this exists to avoid. Anyone
	 * with an account can clear it, and the cost of that is that the next
	 * request for each cover goes upstream again.
	 */
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
	 * Hands a ListenBrainz token to the music server. It is checked there
	 * against ListenBrainz and stored there; Heddohon keeps nothing.
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
	 * Returns the last.fm approval page to send the browser to. The page sends
	 * the browser back to `/settings/lastfm` with a token, which that route
	 * hands to the music server.
	 *
	 * Returned for the page to navigate to rather than as a redirect. A 303
	 * from a form post to another origin is refused by `form-action 'self'`,
	 * and `goto` in the enhanced form refuses external URLs.
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
	 * See `importPlays` for what is skipped. The read walks the whole library
	 * on Navidrome, 500 songs a request.
	 */
	importHistory: async ({ locals }) => {
		const session = locals.session;
		if (!session) return fail(401, { error: 'Not signed in' });
		const backend = backendFor(session.account.backend);
		const { historyDays } = await getSettings(session.account.id);
		let result;
		try {
			result = await importPlays(session.account.id, () => backend.getPlayedSongs(session.credential), historyDays);
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
