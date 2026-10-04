/**
 * Where an account's plays go besides the music server.
 *
 * - A Discord channel, through a webhook the account pastes in. Each play that
 *   counts is posted as one message, with the cover attached.
 * - ListenBrainz, with the account's own user token. Navidrome can also
 *   scrobble there itself (`backends/navidrome.ts`), and both at once would
 *   send each play twice, so Settings refuses one while the other is linked.
 *
 * Each is off until the operator turns it on (`HEDDOHON_DISCORD`,
 * `HEDDOHON_LISTENBRAINZ`). On, it sends the title, artist and album of what
 * an account plays, and to Discord the cover, to a third party the account
 * chose. The user name is not sent.
 *
 * A webhook address posts to its channel and a token writes to its profile, so
 * both are sealed as the music-server credential is, under their own key, and
 * neither is sent back to a browser. Settings shows the webhook's name or the
 * ListenBrainz user.
 *
 * Both follow "Report playback": with it off, nothing leaves.
 */
import type { Song } from '$lib/types';
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
 * `HEDDOHON_DISCORD_URL` with those two in the path, so an account does not
 * choose the host this server connects to.
 */
const WEBHOOK = /^https:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/api(?:\/v\d{1,2})?\/webhooks\/(\d{15,22})\/([A-Za-z0-9_-]{40,100})\/?$/;

/** As `LISTENBRAINZ_TOKEN` in the settings page's actions: a UUID, with room to grow. */
const TOKEN = /^[A-Za-z0-9-]{1,128}$/;

/**
 * A bucket of `burst` per account that regains one every `everyMs`.
 *
 * Every request below leaves from this server's address when an account asks.
 * Unlimited, one account's script could post to Discord as fast as it reported
 * plays, and Discord refuses an address that sends it 10,000 refused requests
 * in 10 minutes, for every account here.
 */
function limiter(burst: number, everyMs: number): (account: string) => boolean {
	const buckets = new Map<string, { tokens: number; at: number }>();
	return (account) => {
		const now = Date.now();
		// One entry per account. Past 5000 the map is emptied, which gives every
		// account its burst back.
		if (buckets.size > 5000) buckets.clear();
		const bucket = buckets.get(account) ?? { tokens: burst, at: now };
		bucket.tokens = Math.min(burst, bucket.tokens + (now - bucket.at) / everyMs);
		bucket.at = now;
		buckets.set(account, bucket);
		if (bucket.tokens < 1) return false;
		bucket.tokens -= 1;
		return true;
	};
}

/** A play counts no sooner than 30 seconds into a track, so 3 a minute is above what listening sends. */
const mayAnnouncePlay = limiter(5, 20_000);
/** Skipping through a queue starts a track every second or two; "playing now" follows at one in 5 seconds. */
const mayAnnounceStart = limiter(5, 5_000);
/** Attempts to link that reach Discord or ListenBrainz: 5, then one every 2 minutes. */
const mayLink = limiter(5, 120_000);

/** Which of the two the operator has turned on, for every account. */
export function offeredIntegrations(): Record<IntegrationKind, boolean> {
	const cfg = config();
	return { discord: cfg.discordUrl !== null, listenbrainz: cfg.listenbrainzUrl !== null };
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
 * Redirects are refused: neither API sends one, and following one would carry
 * the token in the path or the header to its target.
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

export type LinkFailure = 'off' | 'malformed' | 'refused' | 'unreachable' | 'throttled';

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
	if (!mayLink(accountId)) return 'throttled';
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
export async function linkListenBrainz(accountId: string, token: string): Promise<LinkFailure | { name: string }> {
	const base = config().listenbrainzUrl;
	if (!base) return 'off';
	if (!TOKEN.test(token)) return 'malformed';
	if (!mayLink(accountId)) return 'throttled';
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
 * Library text, escaped so Discord shows it as it is. An embed renders
 * Markdown, and a title of `[free](https://example.com)` became a link in the
 * channel.
 */
function plain(text: string, length: number): string {
	return text.replace(/[\\*_~`|>[\]()#-]/g, '\\$&').slice(0, length);
}

interface Listener {
	id: string;
}

/** A cover's bytes and the type the music server gave them. */
export interface CoverImage {
	type: string;
	body: Buffer;
}

/**
 * The image types attached to a post, and the fixed name each goes under.
 * Discord draws these four in an embed. SVG is left out, as in the cover cache.
 */
const ATTACHED: Record<string, string> = {
	'image/jpeg': 'cover.jpg',
	'image/png': 'cover.png',
	'image/webp': 'cover.webp',
	'image/gif': 'cover.gif'
};

/** Asked of the music server at this size, one of `COVER_SIZES`. Discord draws a thumbnail at 80px. */
export const DISCORD_COVER_SIZE = 256;
/** The largest cover attached. One at 256px is 10 to 40 KB. */
const MAX_ATTACHED_BYTES = 1024 * 1024;

/**
 * One message per play. It does not name the account: the user name is what
 * the sign-in page accepts, and a channel can have many readers. The message
 * is posted under the webhook's own name.
 */
async function postToDiscord(account: Listener, link: DiscordLink, song: Song, cover: CoverImage | null): Promise<void> {
	const base = config().discordUrl;
	if (!base) return;
	// The cover is attached as a file. Discord shows an embed image from an
	// address anyone can fetch or from an attachment, and a cover here is
	// behind a session.
	const filename = cover && cover.body.byteLength <= MAX_ATTACHED_BYTES ? ATTACHED[cover.type.split(';')[0].trim().toLowerCase()] : undefined;
	const payload = JSON.stringify({
		// Nobody is pinged by a tag: an artist called `@everyone` names nobody.
		allowed_mentions: { parse: [] },
		embeds: [
			{
				title: plain(song.title, 256),
				description: [song.artist, song.album]
					.filter((part): part is string => Boolean(part))
					.map((part) => plain(part, 300))
					.join('\n'),
				...(filename ? { thumbnail: { url: `attachment://${filename}` } } : {}),
				footer: { text: config().appName },
				timestamp: new Date().toISOString()
			}
		],
		...(filename ? { attachments: [{ id: 0, filename }] } : {})
	});
	let body: string | FormData = payload;
	if (cover && filename) {
		body = new FormData();
		body.set('payload_json', payload);
		body.set('files[0]', new Blob([new Uint8Array(cover.body)], { type: cover.type.split(';')[0].trim().toLowerCase() }), filename);
	}
	const response = await call(`${base}/api/webhooks/${link.id}/${link.token}`, {
		method: 'POST',
		// A form sets its own type, with the boundary it was written with.
		headers: typeof body === 'string' ? { 'content-type': 'application/json' } : {},
		body
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
 * dates the listen's start. `cover` reads the track's cover, possibly from the
 * music server, and is called only for a Discord post that is within its limit.
 */
export async function announcePlay(
	account: Listener,
	song: Song,
	position: number,
	cover: (coverId: string) => Promise<CoverImage | null>
): Promise<void> {
	try {
		const offered = offeredIntegrations();
		if (!offered.discord && !offered.listenbrainz) return;
		const found = await links(account.id);
		if (!found.discord && !found.listenbrainz) return;
		if (!mayAnnouncePlay(account.id)) return;
		await Promise.all([
			// The cover is read inside the post's own promise, so a slow music
			// server does not hold the listen back.
			offered.discord && found.discord
				? Promise.resolve(song.coverArt ? cover(song.coverArt).catch(() => null) : null).then((image) =>
						postToDiscord(account, found.discord!, song, image)
					)
				: null,
			offered.listenbrainz && found.listenbrainz
				? submitListen(account, found.listenbrainz, song, Math.floor(Date.now() / 1000 - position))
				: null
		]);
	} catch (err) {
		log.warn('integration-failed', { detail: reason(err) });
	}
}

/**
 * A track that started, for ListenBrainz's "playing now". `song` is a request
 * to the music server, called only where the account has ListenBrainz linked.
 */
export async function announceStart(account: Listener, song: () => Promise<Song | null>): Promise<void> {
	try {
		if (!offeredIntegrations().listenbrainz) return;
		const link = (await links(account.id)).listenbrainz;
		const playing = link && mayAnnounceStart(account.id) ? await song() : null;
		if (link && playing) await submitListen(account, link, playing, null);
	} catch (err) {
		log.warn('integration-failed', { detail: reason(err) });
	}
}
