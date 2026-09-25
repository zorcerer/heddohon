/**
 * Song links, which anyone holding one can open without an account.
 *
 * A link is a bearer capability for exactly one song. Whoever presents the
 * token gets that song's details, its cover and its audio, fetched with the
 * sharer's stored credential, and nothing else: the song id is read from the
 * row, never from the request, and no route under `/share` takes an id, a
 * path or a write. The credential stays in this process, as it does for every
 * other request.
 *
 * The token is handled the way the session cookie is: 256 random bits in the
 * link, and only an HMAC digest in the database, under a key of its own. A
 * copy of the database therefore yields no working link. The cost is that a
 * link can be shown once, when it is made. After that its owner can see what
 * it points at and withdraw it, and cannot read it back.
 */
import { randomUUID } from 'node:crypto';
import type { BackendKind, Song } from '$lib/types';
import type { Account, AuthenticatedSession } from './auth';
import { backendFor, UpstreamError, type StoredCredential } from './backends';
import { config } from './config';
import { mapLimited } from './backends/http';
import { openJson, randomToken, shareDigest } from './crypto';
import { now, store, type ShareRow } from './db';
import { log, reason } from './log';

/** The lifetimes a link can be given, in days. Anything else is refused. */
export const SHARE_LIFETIMES_DAYS = [1, 7, 30] as const;
export type ShareLifetime = (typeof SHARE_LIFETIMES_DAYS)[number];
export const DEFAULT_SHARE_LIFETIME: ShareLifetime = 7;

/**
 * Live links one account may hold at once. Each one is a row that outlives
 * the session that made it, so this is what bounds the table.
 */
export const MAX_ACTIVE_SHARES = 100;

/**
 * What `randomToken` produces: 32 bytes as unpadded base64url, 43 characters.
 * Anything else in the path is refused before it is digested, so a request
 * cannot make the server HMAC a megabyte of path.
 */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function isShareLifetime(value: unknown): value is ShareLifetime {
	return SHARE_LIFETIMES_DAYS.includes(value as ShareLifetime);
}

export class ShareLimitError extends Error {}

export interface CreatedShare {
	id: string;
	/** The raw token. Returned here and nowhere else. */
	token: string;
	expiresAt: number;
}

export async function createShare(
	account: Account,
	songId: string,
	days: ShareLifetime
): Promise<CreatedShare> {
	await pruneExpiredShares();
	const database = await store();
	const timestamp = now();

	const id = randomUUID();
	const token = randomToken();
	const expiresAt = timestamp + days * 24 * 60 * 60 * 1000;
	/*
	 * The count and the insert in one statement, under a lock on the account.
	 * As two statements with the database behind an `await`, concurrent
	 * requests all counted before any inserted and ran past the ceiling. See
	 * `exclusive` in db.ts for why the lock is needed on PostgreSQL as well.
	 */
	const inserted = await database.exclusive(`shares:${account.id}`, (tx) => tx.run(
		`INSERT INTO shares (id, token_digest, account_id, backend, song_id, created_at, expires_at)
		 SELECT ?, ?, ?, ?, ?, CAST(? AS BIGINT), CAST(? AS BIGINT)
		 WHERE (SELECT COUNT(*) FROM shares WHERE account_id = ? AND expires_at > ?) < ?`,
		id,
		shareDigest(token),
		account.id,
		account.backend,
		songId,
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
	songId: string;
	/** The sharer's username, as the music server spells it. */
	sharedBy: string;
	sharerAccountId: string;
	expiresAt: number;
}

/**
 * The live share a token names, or null.
 *
 * An unknown token, an expired one and a withdrawn one all come back as the
 * same null, so the page cannot be used to learn which links once existed.
 */
export async function resolveShare(token: string): Promise<ResolvedShare | null> {
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
		songId: row.song_id,
		sharedBy: row.username,
		sharerAccountId: row.account_id,
		expiresAt: row.expires_at
	};
}

/**
 * The sharer's credential, opened for one request. Null when it can no longer
 * be opened, which happens after `HEDDOHON_SECRET` changes.
 */
export async function sharerCredential(share: ResolvedShare): Promise<StoredCredential | null> {
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
 * The shared song, as the sharer's account sees it now, or null.
 *
 * Null covers the song having been removed and the sharer's credential having
 * stopped working upstream. Both mean the link cannot be played, and a visitor
 * is told only that. A rejected credential does not sign the sharer out from
 * here: the request may be anonymous, and the sharer's own next request finds
 * out the same thing. Any other upstream failure is thrown, so an outage reads
 * as an outage rather than as a dead link.
 */
export async function sharedSong(
	share: ResolvedShare,
	credential: StoredCredential
): Promise<Song | null> {
	try {
		const [song] = await backendFor(share.backend).getSongs(credential, [share.songId]);
		return song ?? null;
	} catch (err) {
		if (err instanceof UpstreamError && (err.kind === 'auth' || err.kind === 'not_found')) {
			return null;
		}
		throw err;
	}
}

/**
 * Resolves a token and opens the sharer's credential in one step, for the
 * routes that serve a link. Null for any link that cannot be played.
 */
export async function shareAccess(
	token: string
): Promise<{ share: ResolvedShare; credential: StoredCredential } | null> {
	// Checked here as well as on the page, so the media routes close with it:
	// with `HEDDOHON_SHARING=false` no route under `/share` resolves a token.
	if (!config().sharing) return null;
	const share = await resolveShare(token);
	if (!share) return null;
	const credential = await sharerCredential(share);
	return credential ? { share, credential } : null;
}

export interface OwnShare {
	id: string;
	songId: string;
	createdAt: number;
	expiresAt: number;
}

/** An account's own live links, newest first. Never another account's. */
export async function listShares(accountId: string): Promise<OwnShare[]> {
	const rows = await (await store()).all<ShareRow>(
		'SELECT * FROM shares WHERE account_id = ? AND expires_at > ? ORDER BY created_at DESC',
		accountId,
		now()
	);
	return rows.map((row) => ({
			id: row.id,
			songId: row.song_id,
			createdAt: row.created_at,
			expiresAt: row.expires_at
		}));
}

export interface DescribedShare extends OwnShare {
	/** Null when the music server no longer returns the song to its sharer. */
	song: Song | null;
}

/**
 * An account's links with the songs they point at, looked up with that
 * account's own credential. Titles are not stored with the link, so the
 * database holds an id per link and nothing a reader could take as a
 * listening history.
 *
 * A music server that fails here costs the titles and not the list: the links
 * are still shown, and can still be withdrawn.
 */
export async function describeShares(session: AuthenticatedSession): Promise<DescribedShare[]> {
	const shares = await listShares(session.account.id);
	if (shares.length === 0) return [];

	/*
	 * One lookup per song. A batch fails whole on Subsonic when any one id is
	 * gone, so a single removed track took every other link's title with it.
	 * `mapLimited` holds this to the same fan-out as every other upstream burst.
	 */
	const backend = backendFor(session.account.backend);
	const ids = [...new Set(shares.map((share) => share.songId))];
	const found = await mapLimited(ids, async (id) => {
		try {
			return (await backend.getSongs(session.credential, [id]))[0] ?? null;
		} catch (err) {
			if (!(err instanceof UpstreamError && err.kind === 'not_found')) {
				log.warn('shares-describe-failed', { detail: reason(err) });
			}
			return null;
		}
	});
	const byId = new Map(found.filter((song): song is Song => song !== null).map((song) => [song.id, song]));
	return shares.map((share) => ({ ...share, song: byId.get(share.songId) ?? null }));
}

/**
 * Streams in progress through each link, so withdrawing it can cut them off.
 *
 * Checking the token on every request is not enough on its own. A browser
 * plays a track as one open-ended range, so the one request that matters was
 * checked once, at the start, and a link withdrawn a second later went on
 * sending the whole file. The registry is in memory: a restart ends every
 * stream anyway.
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
 * Withdraws one link. The account is part of the match, so an id belonging to
 * somebody else deletes nothing and reads the same as an id that never existed.
 */
export async function revokeShare(accountId: string, id: string): Promise<boolean> {
	const result = await (await store()).run('DELETE FROM shares WHERE id = ? AND account_id = ?', id, accountId);
	if (result.changes > 0) cutShareStreams(id);
	return result.changes > 0;
}

/** Withdraws every link an account holds. Returns how many there were. */
export async function revokeAllShares(accountId: string): Promise<number> {
	const database = await store();
	const rows = await database.all<{ id: string }>('SELECT id FROM shares WHERE account_id = ?', accountId);
	await database.run('DELETE FROM shares WHERE account_id = ?', accountId);
	for (const { id } of rows) cutShareStreams(id);
	return rows.length;
}

let lastPrune = 0;

async function pruneExpiredShares(): Promise<void> {
	// The same once-a-minute rhythm as sessions. An expired row is refused when
	// presented whether or not it has been swept; this only keeps the table small.
	const timestamp = now();
	if (timestamp - lastPrune < 60_000) return;
	lastPrune = timestamp;
	await (await store()).run('DELETE FROM shares WHERE expires_at <= ?', timestamp);
}
