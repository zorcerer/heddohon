/**
 * Shared links to a song, an album or a playlist, opened without an account.
 *
 * A link is a bearer capability for one item. Its holder gets the item's
 * details, covers and audio, fetched with the sharer's stored credential. The
 * item's id is read from the row, never from the request. A request names only
 * a track's position (`/stream/3`), looked up in the item as the sharer sees
 * it. No route under `/share` takes an id, a path or a write.
 *
 * The token is handled as the session cookie is: 256 random bits in the link
 * and an HMAC digest in the database, under its own key, so a copy of the
 * database yields no working link. A link is therefore shown once, when made.
 */
import { randomUUID } from 'node:crypto';
import type { BackendKind, Playlist, Song } from '$lib/types';
import type { Account, AuthenticatedSession } from './auth';
import { backendFor, UpstreamError, type StoredCredential } from './backends';
import { config } from './config';
import { mapLimited } from './backends/http';
import { openJson, randomToken, shareDigest } from './crypto';
import { now, store, type ShareRow } from './db';
import { log, reason } from './log';
import { Memo } from './memo';

/** The lifetimes a link can be given, in days. Anything else is refused. */
const SHARE_LIFETIMES_DAYS = [1, 7, 30] as const;
export type ShareLifetime = (typeof SHARE_LIFETIMES_DAYS)[number];
export const DEFAULT_SHARE_LIFETIME: ShareLifetime = 7;

/** Live links one account may hold. Rows outlive the session, so this bounds the table. */
const MAX_ACTIVE_SHARES = 100;

/**
 * What `randomToken` produces: 43 characters of base64url. Anything else is
 * refused before it is digested, so a request cannot have a megabyte of path
 * HMACed.
 */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function isShareLifetime(value: unknown): value is ShareLifetime {
	return SHARE_LIFETIMES_DAYS.includes(value as ShareLifetime);
}

/** What a link can be to. */
const SHARE_KINDS = ['song', 'album', 'playlist'] as const;
export type ShareKind = (typeof SHARE_KINDS)[number];

export function isShareKind(value: unknown): value is ShareKind {
	return SHARE_KINDS.includes(value as ShareKind);
}

/** A row from before albums and playlists could be shared has no kind, and is a song. */
function kindOf(row: ShareRow): ShareKind {
	return isShareKind(row.kind) ? row.kind : 'song';
}

/**
 * The most tracks an album or playlist link serves, from its start: about 30
 * hours. Each track is a row on the page and a position the stream route
 * answers for.
 */
export const MAX_SHARED_TRACKS = 500;

export class ShareLimitError extends Error {}

export interface CreatedShare {
	id: string;
	/** The raw token. Returned here and nowhere else. */
	token: string;
	expiresAt: number;
}

export async function createShare(
	account: Account,
	kind: ShareKind,
	itemId: string,
	days: ShareLifetime
): Promise<CreatedShare> {
	await pruneExpiredShares();
	const database = await store();
	const timestamp = now();

	const id = randomUUID();
	const token = randomToken();
	const expiresAt = timestamp + days * 24 * 60 * 60 * 1000;
	/*
	 * The count and the insert are one statement, under a lock on the account.
	 * As two statements, concurrent requests all counted before any inserted
	 * and passed the ceiling. See `exclusive` in db.ts for PostgreSQL.
	 */
	const inserted = await database.exclusive(`shares:${account.id}`, (tx) => tx.run(
		`INSERT INTO shares (id, token_digest, account_id, backend, song_id, kind, created_at, expires_at)
		 SELECT ?, ?, ?, ?, ?, ?, CAST(? AS BIGINT), CAST(? AS BIGINT)
		 WHERE (SELECT COUNT(*) FROM shares WHERE account_id = ? AND expires_at > ?) < ?`,
		id,
		shareDigest(token),
		account.id,
		account.backend,
		itemId,
		kind,
		timestamp,
		expiresAt,
		account.id,
		timestamp,
		MAX_ACTIVE_SHARES
	));
	if (inserted.changes === 0) {
		throw new ShareLimitError(
			`You already have ${MAX_ACTIVE_SHARES} live links. Withdraw one in Settings to make another.`
		);
	}

	return { id, token, expiresAt };
}

export interface ResolvedShare {
	id: string;
	backend: BackendKind;
	kind: ShareKind;
	/** The song, album or playlist, by `kind`. */
	itemId: string;
	/** The sharer's username, as the music server spells it. */
	sharedBy: string;
	sharerAccountId: string;
	expiresAt: number;
}

/**
 * The live share a token names, or null. Unknown, expired and withdrawn
 * tokens give the same null, so the page does not reveal which links existed.
 */
async function resolveShare(token: string): Promise<ResolvedShare | null> {
	if (!TOKEN_PATTERN.test(token)) return null;

	const database = await store();
	const row = await database.get<ShareRow & { username: string }>(
		`SELECT shares.*, accounts.username AS username
		 FROM shares JOIN accounts ON accounts.id = shares.account_id
		 WHERE shares.token_digest = ?`,
		shareDigest(token)
	);
	if (!row) return null;

	if (row.expires_at <= now()) {
		await database.run('DELETE FROM shares WHERE id = ?', row.id);
		return null;
	}

	return {
		id: row.id,
		backend: row.backend as BackendKind,
		kind: kindOf(row),
		itemId: row.song_id,
		sharedBy: row.username,
		sharerAccountId: row.account_id,
		expiresAt: row.expires_at
	};
}

/**
 * The sharer's credential, opened for one request. Null when it no longer
 * opens, as after `HEDDOHON_SECRET` changes.
 */
async function sharerCredential(share: ResolvedShare): Promise<StoredCredential | null> {
	const row = await (await store()).get<{ credential: string }>(
		'SELECT credential FROM accounts WHERE id = ?',
		share.sharerAccountId
	);
	if (!row) return null;
	try {
		return openJson<StoredCredential>(row.credential);
	} catch {
		return null;
	}
}

/**
 * The track at `position` in what the link is to, as the sharer's account sees
 * it now, or null.
 *
 * Null covers a removed song and a sharer's credential rejected upstream. A
 * rejected credential does not sign the sharer out from here: the request may
 * be anonymous, and the sharer's next request finds the same. Any other
 * upstream failure is thrown, so an outage does not read as a dead link.
 */
export async function sharedSong(
	share: ResolvedShare,
	credential: StoredCredential,
	position = 0
): Promise<Song | null> {
	return (await sharedItem(share, credential))?.tracks[position] ?? null;
}

export interface SharedItem {
	kind: ShareKind;
	/** The song's title, or the album's or playlist's name. */
	title: string;
	/** The artist of a song or album; null for a playlist. */
	subtitle: string | null;
	coverArt: string | null;
	/** In order, at most `MAX_SHARED_TRACKS`. One for a song link. */
	tracks: Song[];
}

/*
 * What each link is to, held for five minutes per link.
 *
 * Read from the music server on every request, it cost the whole album or
 * playlist each time. Against a mock Subsonic server with a 5000-entry
 * playlist, 50 parallel `HEAD /share/<token>/stream/499` from one anonymous
 * client made 100 upstream calls and fetched 59.7MB of JSON in 747ms.
 *
 * The token, the expiry and withdrawal are still checked on every request
 * (`shareAccess`). A change made outside Heddohon reaches a link up to five
 * minutes late; playlist edits made through Heddohon drop the sharer's entries
 * at once. A link that finds nothing is not held.
 *
 * Keyed by the sharer's account and the link, and dropped with the account's
 * other entries when its credential stops working. An entry is at most
 * `MAX_SHARED_TRACKS` songs, a few hundred kilobytes.
 */
const SHARED_ITEM_TTL_MS = 5 * 60_000;
const sharedItems = new Memo(SHARED_ITEM_TTL_MS, 64);

/** Drops an account's held items, after it edits a playlist or its credential stops working. */
export function forgetSharedItems(accountId: string): void {
	sharedItems.forgetAccount(accountId);
}

/**
 * What a link is to, as the sharer's account saw it at most five minutes ago
 * (see `sharedItems`), or null on the same terms as `sharedSong`.
 */
export function sharedItem(share: ResolvedShare, credential: StoredCredential): Promise<SharedItem | null> {
	return sharedItems.get({ accountId: share.sharerAccountId, credential }, share.id, () => readSharedItem(share, credential), (item) =>
		item ? SHARED_ITEM_TTL_MS : 0
	);
}

/**
 * Whether a playlist is the sharer's own, and so one it may link to.
 *
 * Navidrome lists another user's public playlist to every account, and a link
 * to one served that user's name and tracks to anyone, which that user could
 * neither see nor withdraw. Jellyfin reports no owner (`owner` is null) and
 * lists only playlists the account may open.
 */
export function ownsPlaylist(playlist: Playlist, username: string): boolean {
	const fold = (name: string) => name.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
	return playlist.owner === null || fold(playlist.owner) === fold(username);
}

async function readSharedItem(share: ResolvedShare, credential: StoredCredential): Promise<SharedItem | null> {
	const backend = backendFor(share.backend);
	try {
		if (share.kind === 'album') {
			const album = await backend.getAlbum(credential, share.itemId);
			return {
				kind: 'album',
				title: album.name,
				subtitle: album.artist,
				coverArt: album.coverArt,
				tracks: album.songs.slice(0, MAX_SHARED_TRACKS)
			};
		}
		if (share.kind === 'playlist') {
			const playlist = await backend.getPlaylist(credential, share.itemId);
			if (!ownsPlaylist(playlist, share.sharedBy)) return null;
			return {
				kind: 'playlist',
				title: playlist.name,
				subtitle: null,
				coverArt: playlist.coverArt,
				tracks: playlist.songs.slice(0, MAX_SHARED_TRACKS)
			};
		}
		const [song] = await backend.getSongs(credential, [share.itemId]);
		return song
			? { kind: 'song', title: song.title, subtitle: song.artist, coverArt: song.coverArt, tracks: [song] }
			: null;
	} catch (err) {
		if (err instanceof UpstreamError && (err.kind === 'auth' || err.kind === 'not_found')) {
			return null;
		}
		throw err;
	}
}

/**
 * Resolves a token and opens the sharer's credential, for the routes that
 * serve a link. Null for any link that cannot be played.
 */
export async function shareAccess(
	token: string
): Promise<{ share: ResolvedShare; credential: StoredCredential } | null> {
	// Checked here as well as on the page, so `HEDDOHON_SHARING=false` closes
	// the media routes too.
	if (!config().sharing) return null;
	const share = await resolveShare(token);
	if (!share) return null;
	const credential = await sharerCredential(share);
	return credential ? { share, credential } : null;
}

interface OwnShare {
	id: string;
	kind: ShareKind;
	itemId: string;
	createdAt: number;
	expiresAt: number;
}

/** An account's own live links, newest first. Never another account's. */
async function listShares(accountId: string): Promise<OwnShare[]> {
	const rows = await (await store()).all<ShareRow>(
		'SELECT * FROM shares WHERE account_id = ? AND expires_at > ? ORDER BY created_at DESC',
		accountId,
		now()
	);
	return rows.map((row) => ({
		id: row.id,
		kind: kindOf(row),
		itemId: row.song_id,
		createdAt: row.created_at,
		expiresAt: row.expires_at
	}));
}

/** What a link is to, for the list in Settings. */
interface ShareSubject {
	title: string;
	subtitle: string | null;
	coverArt: string | null;
}

export interface DescribedShare extends OwnShare {
	/** Null when the music server no longer returns the item to its sharer. */
	item: ShareSubject | null;
}

/**
 * An account's links with what they point at, looked up with its own
 * credential. Titles are not stored, so the database holds only an id per
 * link. A failing music server costs the titles: the links are still listed
 * and can be withdrawn.
 */
export async function describeShares(session: AuthenticatedSession): Promise<DescribedShare[]> {
	const shares = await listShares(session.account.id);
	if (shares.length === 0) return [];

	/*
	 * One lookup per item. A batch fails whole on Subsonic when any id is gone,
	 * so one removed track took every other link's title with it.
	 */
	const backend = backendFor(session.account.backend);
	const cred = session.credential;
	const keys = [...new Set(shares.map((share) => `${share.kind}:${share.itemId}`))];
	const found = await mapLimited(keys, async (key): Promise<[string, ShareSubject | null]> => {
		const [kind, ...rest] = key.split(':');
		const id = rest.join(':');
		try {
			if (kind === 'album') {
				const album = await backend.getAlbum(cred, id);
				return [key, { title: album.name, subtitle: album.artist, coverArt: album.coverArt }];
			}
			if (kind === 'playlist') {
				const playlist = await backend.getPlaylist(cred, id);
				return [key, { title: playlist.name, subtitle: null, coverArt: playlist.coverArt }];
			}
			const [song] = await backend.getSongs(cred, [id]);
			return [key, song ? { title: song.title, subtitle: song.artist, coverArt: song.coverArt } : null];
		} catch (err) {
			if (!(err instanceof UpstreamError && err.kind === 'not_found')) {
				log.warn('shares-describe-failed', { detail: reason(err) });
			}
			return [key, null];
		}
	});
	const byKey = new Map(found);
	return shares.map((share) => ({ ...share, item: byKey.get(`${share.kind}:${share.itemId}`) ?? null }));
}

/**
 * Streams in progress through each link, so withdrawing it cuts them off.
 *
 * A browser plays a track as one open-ended range, checked once at its start,
 * so a link withdrawn a second later kept sending the file. In memory: a
 * restart ends every stream.
 */
const openStreams = new Map<string, Set<AbortController>>();

/** Registers a stream against a link. Returns the release, safe to call twice. */
export function holdShareStream(shareId: string, controller: AbortController): () => void {
	let streams = openStreams.get(shareId);
	if (!streams) openStreams.set(shareId, (streams = new Set()));
	streams.add(controller);
	return () => {
		streams.delete(controller);
		if (streams.size === 0 && openStreams.get(shareId) === streams) openStreams.delete(shareId);
	};
}

function cutShareStreams(shareId: string): void {
	const streams = openStreams.get(shareId);
	if (!streams) return;
	openStreams.delete(shareId);
	for (const controller of streams) controller.abort(new Error('share withdrawn'));
}

/**
 * Withdraws one link. The account is part of the match, so another account's
 * id deletes nothing and reads as an id that never existed.
 */
export async function revokeShare(accountId: string, id: string): Promise<boolean> {
	const result = await (await store()).run('DELETE FROM shares WHERE id = ? AND account_id = ?', id, accountId);
	if (result.changes > 0) cutShareStreams(id);
	sharedItems.forget(accountId, id);
	return result.changes > 0;
}

/** Withdraws every link an account holds. Returns how many there were. */
export async function revokeAllShares(accountId: string): Promise<number> {
	const database = await store();
	const rows = await database.all<{ id: string }>('SELECT id FROM shares WHERE account_id = ?', accountId);
	await database.run('DELETE FROM shares WHERE account_id = ?', accountId);
	for (const { id } of rows) cutShareStreams(id);
	forgetSharedItems(accountId);
	return rows.length;
}

let lastPrune = 0;

async function pruneExpiredShares(): Promise<void> {
	// Once a minute, as for sessions. An expired row is refused whether swept
	// or not; this keeps the table small.
	const timestamp = now();
	if (timestamp - lastPrune < 60_000) return;
	lastPrune = timestamp;
	await (await store()).run('DELETE FROM shares WHERE expires_at <= ?', timestamp);
}
