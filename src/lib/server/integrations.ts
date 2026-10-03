/**
 * Where an account's plays go besides the music server.
 *
 * - A Discord channel, through a webhook the account pastes in. Each play that
 *   counts is posted there as one message.
 * - ListenBrainz, with a user token, for an account on a music server that
 *   cannot scrobble there itself. Navidrome can (`backends/navidrome.ts`), so
 *   this is offered on Jellyfin only: both at once would send each play twice.
 *
 * Each is off until the operator turns it on (`HEDDOHON_DISCORD`,
 * `HEDDOHON_LISTENBRAINZ`), as every other request this server makes to a host
 * that is not the music server is. Turned on, it sends the title, artist and
 * album of what an account plays to a third party the account chose.
 *
 * What an account pastes in is a secret: a webhook address posts to its
 * channel, and a token writes to its ListenBrainz profile. Both are sealed as
 * the music-server credential is, under a key of their own, and neither is
 * sent back to a browser. Settings shows the webhook's name or the
 * ListenBrainz user and nothing else.
 *
 * Both follow "Report playback": with it off, nothing leaves.
 */
import type { Song } from '$lib/types';
import type { BackendKind } from '$lib/types';
import { backendFor } from './backends';
import { config } from './config';
import { openJson, sealJson } from './crypto';
import { store } from './db';
import { log, reason } from './log';
import { APP_VERSION } from './version';

export type IntegrationKind = 'discord' | 'listenbrainz';

interface DiscordLink {
	id: string;
	token: string;
	/** The webhook's name on Discord, for Settings. */
	name: string;
}

interface ListenBrainzLink {
	token: string;
	/** The ListenBrainz user the token belongs to, for Settings. */
	user: string;
}

const PURPOSE = 'integration';
const TIMEOUT_MS = 5000;
/** The most read of an answer. Discord's webhook record and ListenBrainz's are under 1 KB. */
const MAX_BYTES = 16 * 1024;

/**
 * A webhook address as Discord shows it: `discord.com` or the older
 * `discordapp.com`, the test and canary hosts, with or without an API version.
 *
 * Only the id and the token are kept. The request goes to the operator's
 * `HEDDOHON_DISCORD_URL` with those two in the path, so nothing an account
 * types chooses the host this server connects to.
 */
const WEBHOOK = /^https:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/api(?:\/v\d{1,2})?\/webhooks\/(\d{15,22})\/([A-Za-z0-9_-]{40,100})\/?$/;

/** As `LISTENBRAINZ_TOKEN` in the settings page's actions: a UUID, with room to grow. */
const TOKEN = /^[A-Za-z0-9-]{1,128}$/;

/** Which of the two Settings offers an account on this music server. */
export function offeredIntegrations(backend: BackendKind): Record<IntegrationKind, boolean> {
	const cfg = config();
	return {
		discord: cfg.discordUrl !== null,
		listenbrainz: cfg.listenbrainzUrl !== null && !backendFor(backend).scrobblers
	};
}

async function links(accountId: string): Promise<{ discord?: DiscordLink; listenbrainz?: ListenBrainzLink }> {
	const rows = await (await store()).all<{ kind: string; secret: string }>(
		'SELECT kind, secret FROM integrations WHERE account_id = ?',
		accountId
	);
	const found: { discord?: DiscordLink; listenbrainz?: ListenBrainzLink } = {};
	for (const row of rows) {
		try {
			if (row.kind === 'discord') found.discord = openJson<DiscordLink>(row.secret, PURPOSE);
			if (row.kind === 'listenbrainz') found.listenbrainz = openJson<ListenBrainzLink>(row.secret, PURPOSE);
		} catch {
			// Sealed under another `HEDDOHON_SECRET`. Linked again, it is replaced.
		}
	}
	return found;
}

/** What Settings shows of each: the webhook's name, the ListenBrainz user, or null. */
export async function linkedIntegrations(accountId: string): Promise<Record<IntegrationKind, string | null>> {
	const found = await links(accountId);
	return { discord: found.discord?.name ?? null, listenbrainz: found.listenbrainz?.user ?? null };
}

async function save(accountId: string, kind: IntegrationKind, link: DiscordLink | ListenBrainzLink): Promise<void> {
	await (await store()).run(
		`INSERT INTO integrations (account_id, kind, secret, created_at) VALUES (?, ?, ?, ?)
		 ON CONFLICT (account_id, kind) DO UPDATE SET secret = excluded.secret, created_at = excluded.created_at`,
		accountId,
		kind,
		sealJson(link, PURPOSE),
		Date.now()
	);
	log.info('integration-linked', { kind });
}

export async function unlinkIntegration(accountId: string, kind: IntegrationKind): Promise<void> {
	const result = await (await store()).run('DELETE FROM integrations WHERE account_id = ? AND kind = ?', accountId, kind);
	if (result.changes > 0) log.info('integration-unlinked', { kind });
}

/**
 * Drops everything an account has linked, when its credential is replaced:
 * another person under the name, or a changed password (`storeAccount` in
 * `auth.ts`). Kept, the next holder's plays went to the previous holder's
 * channel and profile.
 */
export async function dropIntegrations(accountId: string): Promise<void> {
	await (await store()).run('DELETE FROM integrations WHERE account_id = ?', accountId);
}

/**
 * One request to Discord or ListenBrainz, or null when it did not answer.
 * Redirects are refused: neither API sends one, and a followed one would take
 * the token in the path or the header to wherever it pointed.
 */
async function call(url: string, init: RequestInit = {}): Promise<Response | null> {
	try {
		return await fetch(url, {
			...init,
			headers: {
				accept: 'application/json',
				'user-agent': `Heddohon/${APP_VERSION} (https://github.com/zorcerer/heddohon)`,
				...init.headers
			},
			redirect: 'error',
			signal: AbortSignal.timeout(TIMEOUT_MS)
		});
	} catch {
		return null;
	}
}

/** The answer as JSON, read up to `MAX_BYTES`, or null. */
async function readJson(response: Response): Promise<Record<string, unknown> | null> {
	try {
		const reader = response.body?.getReader();
		if (!reader) return null;
		const chunks: Uint8Array[] = [];
		let total = 0;
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > MAX_BYTES) {
				await reader.cancel();
				return null;
			}
			chunks.push(value);
		}
		const body: unknown = JSON.parse(Buffer.concat(chunks, total).toString('utf8'));
		return body && typeof body === 'object' ? (body as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

export type LinkFailure = 'off' | 'malformed' | 'refused' | 'unreachable';

/**
 * Links a Discord channel from its webhook address. The webhook is read from
 * Discord first, which says whether it exists and what it is called.
 */
export async function linkDiscord(accountId: string, address: string): Promise<LinkFailure | { name: string }> {
	const base = config().discordUrl;
	if (!base) return 'off';
	const match = WEBHOOK.exec(address.trim());
	if (!match) return 'malformed';
	const [, id, token] = match;
	const response = await call(`${base}/api/webhooks/${id}/${token}`);
	if (!response) return 'unreachable';
	if (!response.ok) {
		await response.body?.cancel().catch(() => undefined);
		return response.status === 401 || response.status === 404 ? 'refused' : 'unreachable';
	}
	const record = await readJson(response);
	const name = typeof record?.name === 'string' && record.name ? record.name.slice(0, 80) : 'a webhook';
	await save(accountId, 'discord', { id, token, name });
	return { name };
}

/** Links ListenBrainz from a user token, which ListenBrainz is asked about first. */
export async function linkListenBrainz(
	accountId: string,
	backend: BackendKind,
	token: string
): Promise<LinkFailure | { name: string }> {
	const base = config().listenbrainzUrl;
	if (!base || !offeredIntegrations(backend).listenbrainz) return 'off';
	if (!TOKEN.test(token)) return 'malformed';
	const response = await call(`${base}/1/validate-token`, { headers: { authorization: `Token ${token}` } });
	if (!response) return 'unreachable';
	const record = response.ok ? await readJson(response) : null;
	if (!response.ok) await response.body?.cancel().catch(() => undefined);
	if (response.status >= 500 || (response.ok && !record)) return 'unreachable';
	if (record?.valid !== true) return 'refused';
	const user = typeof record.user_name === 'string' && record.user_name ? record.user_name.slice(0, 80) : 'your account';
	await save(accountId, 'listenbrainz', { token, user });
	return { name: user };
}

/**
 * Text from the library, written so Discord shows it as it is. Tags are
 * written by whoever can edit the library, and an embed renders Markdown: a
 * title of `[free](https://example.com)` became a link in the channel.
 */
function plain(text: string, length: number): string {
	return text.replace(/[\\*_~`|>[\]()#-]/g, '\\$&').slice(0, length);
}

interface Listener {
	id: string;
	username: string;
}

async function postToDiscord(account: Listener, link: DiscordLink, song: Song): Promise<void> {
	const base = config().discordUrl;
	if (!base) return;
	const response = await call(`${base}/api/webhooks/${link.id}/${link.token}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			// Nobody is pinged by a tag: an artist called `@everyone` names nobody.
			allowed_mentions: { parse: [] },
			embeds: [
				{
					// Plain text to Discord, unlike the two below it.
					author: { name: `${account.username.slice(0, 80)} is listening to` },
					title: plain(song.title, 256),
					description: [song.artist, song.album]
						.filter((part): part is string => Boolean(part))
						.map((part) => plain(part, 300))
						.join('\n'),
					footer: { text: config().appName },
					timestamp: new Date().toISOString()
				}
			]
		})
	});
	await response?.body?.cancel().catch(() => undefined);
	if (!response || response.ok) return;
	// The webhook was deleted on Discord. Kept, every play would ask again.
	const gone = response.status === 401 || response.status === 404;
	if (gone) await unlinkIntegration(account.id, 'discord');
	log.warn('integration-failed', { kind: 'discord', status: response.status, unlinked: gone });
}

async function submitListen(
	account: Listener,
	link: ListenBrainzLink,
	song: Song,
	/** Epoch seconds the track started at, or null for "playing now". */
	listenedAt: number | null
): Promise<void> {
	const base = config().listenbrainzUrl;
	// ListenBrainz refuses a listen without both.
	if (!base || !song.title || !song.artist) return;
	const response = await call(`${base}/1/submit-listens`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', authorization: `Token ${link.token}` },
		body: JSON.stringify({
			listen_type: listenedAt === null ? 'playing_now' : 'single',
			payload: [
				{
					...(listenedAt === null ? {} : { listened_at: listenedAt }),
					track_metadata: {
						artist_name: song.artist.slice(0, 300),
						track_name: song.title.slice(0, 300),
						...(song.album ? { release_name: song.album.slice(0, 300) } : {}),
						additional_info: {
							media_player: 'Heddohon',
							submission_client: 'Heddohon',
							submission_client_version: APP_VERSION,
							...(song.duration > 0 ? { duration: Math.round(song.duration) } : {})
						}
					}
				}
			]
		})
	});
	await response?.body?.cancel().catch(() => undefined);
	if (!response || response.ok) return;
	// The token was reset on ListenBrainz.
	const gone = response.status === 401;
	if (gone) await unlinkIntegration(account.id, 'listenbrainz');
	log.warn('integration-failed', { kind: 'listenbrainz', status: response.status, unlinked: gone });
}

/**
 * A play that counted (`/api/playback`, past the scrobble threshold), sent to
 * what the account has linked. Not awaited by the caller, and it does not
 * throw: neither service may hold up or fail the report of a play.
 *
 * `position` is how far into the track the play was counted, in seconds, which
 * puts the start of the listen that far back.
 */
export async function announcePlay(account: Listener & { backend: BackendKind }, song: Song, position: number): Promise<void> {
	try {
		const offered = offeredIntegrations(account.backend);
		if (!offered.discord && !offered.listenbrainz) return;
		const found = await links(account.id);
		await Promise.all([
			offered.discord && found.discord ? postToDiscord(account, found.discord, song) : null,
			offered.listenbrainz && found.listenbrainz
				? submitListen(account, found.listenbrainz, song, Math.floor(Date.now() / 1000 - position))
				: null
		]);
	} catch (err) {
		log.warn('integration-failed', { detail: reason(err) });
	}
}

/**
 * A track that started, for ListenBrainz's "playing now". `song` is called
 * only where the account has ListenBrainz linked, since it is a request to the
 * music server that nothing else at a track's start needs.
 */
export async function announceStart(
	account: Listener & { backend: BackendKind },
	song: () => Promise<Song | null>
): Promise<void> {
	try {
		if (!offeredIntegrations(account.backend).listenbrainz) return;
		const link = (await links(account.id)).listenbrainz;
		const playing = link ? await song() : null;
		if (link && playing) await submitListen(account, link, playing, null);
	} catch (err) {
		log.warn('integration-failed', { detail: reason(err) });
	}
}
