/**
 * An account's profile page: four albums it picks, a short bio, and, where it
 * turns them on, what it played lately and its most played artists, from this
 * server's own history (`plays`).
 *
 * Who sees it:
 *
 *  - the account itself, at `/people/<handle>`, always;
 *  - the other accounts signed in here, where it is `listed`, at the same
 *    address and in the list at `/people`;
 *  - anyone with its public link, `/p/<token>`, while the account has one.
 *    The token is stored as a digest under a key of its own
 *    (`profileLinkDigest`), as a now-playing link's is, so a copy of the
 *    database opens nothing, and it is shown once, as it is made.
 *
 * An album is read through the account's own credential as it is picked, and
 * what the page shows of it (title, artist, year, cover id) is kept from that
 * read, so nothing a request sends becomes text on another account's screen.
 * Covers are served through the owner's stored credential by slot
 * (`coverOfSlot`), as a shared link's are: the address names a place on the
 * page, never a cover id, so a viewer reaches the covers the page shows and
 * no other.
 *
 * The handle is the profile's (`profiles` in `listening.ts`), which the
 * "Listening now" list uses too; the account id is never shown.
 */
import type { BackendKind } from '$lib/types';
import type { Account } from './auth';
import type { StoredCredential } from './backends';
import { backendFor, UpstreamError } from './backends';
import { profileLinkDigest, randomToken } from './crypto';
import { now, store } from './db';
import { ensureHandle } from './listening';

export const FAVOURITE_SLOTS = 4;
/** Characters in a bio, counted as a reader would (code points). */
export const MAX_BIO = 280;
/** Albums in "Listened to lately". */
const RECENT_COUNT = 8;
/** Artists in "Most played", over `TOP_DAYS`. */
const TOP_COUNT = 8;
const TOP_DAYS = 30;

const LINK_PREFIX = 'hhpr_';
/** The prefix and 43 characters of `randomToken`, with room. Anything longer is no token. */
const MAX_TOKEN_LENGTH = 64;
/** A handle as `listening.ts` makes one: 12 random bytes in hex. */
const HANDLE = /^[0-9a-f]{24}$/;

/** An album as it was when picked. */
export interface PickedAlbum {
	id: string;
	title: string;
	artist: string | null;
	artistId: string | null;
	year: number | null;
	/** Whether the music server has a cover for it; the id stays on the server. */
	cover: boolean;
}

interface StoredAlbum extends Omit<PickedAlbum, 'cover'> {
	coverArt: string | null;
}

export interface RecentAlbum {
	id: string;
	title: string;
	artist: string | null;
	cover: boolean;
}

export interface TopArtist {
	id: string;
	name: string;
	plays: number;
}

/** A page as a viewer is sent it. */
export interface ProfileView {
	handle: string;
	name: string;
	/** The picture's version, or null without one. */
	avatar: number | null;
	/** Which kind of music server the ids are on; a viewer on the other gets no album links. */
	backend: BackendKind;
	bio: string | null;
	/** `FAVOURITE_SLOTS` places, each an album or null. */
	favourites: (PickedAlbum | null)[];
	/** Null where the account has not turned it on. */
	recent: RecentAlbum[] | null;
	top: TopArtist[] | null;
}

/** What the account itself can change, besides the page. */
export interface PageSettings {
	listed: boolean;
	recent: boolean;
	top: boolean;
	/** When the public link was made, or null without one. */
	linkMadeAt: number | null;
}

interface PageRow {
	account_id: string;
	bio: string | null;
	albums: string;
	listed: number;
	recent: number;
	top_artists: number;
	link_made_at: number | null;
}

const EMPTY_ALBUMS = JSON.stringify(Array(FAVOURITE_SLOTS).fill(null));

function albumsOf(row: PageRow | undefined): (StoredAlbum | null)[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(row?.albums ?? EMPTY_ALBUMS);
	} catch {
		parsed = null;
	}
	const list = Array.isArray(parsed) ? parsed : [];
	return Array.from({ length: FAVOURITE_SLOTS }, (_, i) => (list[i] && typeof list[i] === 'object' ? (list[i] as StoredAlbum) : null));
}

async function rowOf(accountId: string): Promise<PageRow | undefined> {
	return (await store()).get<PageRow>('SELECT * FROM profile_pages WHERE account_id = ?', accountId);
}

export async function pageSettings(accountId: string): Promise<PageSettings> {
	const row = await rowOf(accountId);
	return {
		listed: Number(row?.listed ?? 0) === 1,
		recent: Number(row?.recent ?? 0) === 1,
		top: Number(row?.top_artists ?? 0) === 1,
		linkMadeAt: row?.link_made_at == null ? null : Number(row.link_made_at)
	};
}

/**
 * A bio from a request: at most `MAX_BIO` characters, with control and
 * direction characters taken out, runs of blank lines made one, and null for
 * none. Undefined for something that is neither a string nor null. It is
 * shown as text, never as markup.
 */
export function cleanBio(value: unknown): string | null | undefined {
	if (value === null) return null;
	if (typeof value !== 'string') return undefined;
	const text = value
		.normalize('NFC')
		.replace(/\r\n?/g, '\n')
		.replace(/[\p{Cs}\p{Co}؜‎‏‪-‮⁦-⁩]/gu, '')
		.replace(/(?!\n)\p{Cc}/gu, ' ')
		.replace(/[^\S\n]+/g, ' ')
		.replace(/ *\n */g, '\n')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
	return Array.from(text).slice(0, MAX_BIO).join('').trim() || null;
}

export type PageError = { error: 'not_found'; slot: number };

/**
 * Saves what the account changed of its page. `albums` is the four slots, each
 * an album id or null; each id is read through the account's credential,
 * which is what an id of an album the account cannot read, or a made-up one,
 * fails on.
 */
export async function savePage(
	account: Account,
	credential: StoredCredential,
	patch: { bio?: string | null; albums?: (string | null)[]; listed?: boolean; recent?: boolean; top?: boolean }
): Promise<PageError | null> {
	const current = await rowOf(account.id);
	let albums = albumsOf(current);
	if (patch.albums) {
		const kept = new Map(albums.filter((album): album is StoredAlbum => album !== null).map((album) => [album.id, album]));
		const next: (StoredAlbum | null)[] = [];
		for (const [slot, id] of patch.albums.entries()) {
			if (id === null) {
				next.push(null);
				continue;
			}
			// An album already on the page keeps what was read when it was picked.
			const held = kept.get(id);
			if (held) {
				next.push(held);
				continue;
			}
			try {
				const album = await backendFor(account.backend).getAlbum(credential, id);
				next.push({
					id: album.id,
					title: album.name,
					artist: album.artist,
					artistId: album.artistId,
					year: album.year,
					coverArt: album.coverArt
				});
			} catch (err) {
				// Anything else, a credential refused among it, is the caller's to answer.
				if (err instanceof UpstreamError && err.kind === 'not_found') return { error: 'not_found', slot };
				throw err;
			}
		}
		albums = next;
	}
	const bio = patch.bio === undefined ? (current?.bio ?? null) : patch.bio;
	const flag = (value: boolean | undefined, stored: number | undefined) => ((value ?? Number(stored ?? 0) === 1) ? 1 : 0);
	await ensureHandle(account.id);
	await (await store()).run(
		`INSERT INTO profile_pages (account_id, bio, albums, listed, recent, top_artists, link_digest, link_made_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?)
		 ON CONFLICT(account_id) DO UPDATE SET bio = excluded.bio, albums = excluded.albums, listed = excluded.listed,
		   recent = excluded.recent, top_artists = excluded.top_artists, updated_at = excluded.updated_at`,
		account.id,
		bio,
		JSON.stringify(albums),
		flag(patch.listed, current?.listed),
		flag(patch.recent, current?.recent),
		flag(patch.top, current?.top_artists),
		now()
	);
	return null;
}

/** The albums the account played last, newest first, one entry an album. */
async function recentAlbums(accountId: string): Promise<{ id: string; title: string; artist: string | null; coverArt: string | null }[]> {
	return (await store()).all(
		`SELECT album_id AS id, MAX(album) AS title, MAX(artist) AS artist, MAX(cover_art) AS "coverArt" FROM plays
		 WHERE account_id = ? AND album_id IS NOT NULL AND album IS NOT NULL
		 GROUP BY album_id ORDER BY MAX(played_at) DESC LIMIT ?`,
		accountId,
		RECENT_COUNT
	);
}

async function topArtists(accountId: string): Promise<TopArtist[]> {
	const rows = await (await store()).all<{ id: string; name: string; plays: number }>(
		`SELECT artist_id AS id, MAX(artist) AS name, COUNT(*) AS plays FROM plays
		 WHERE account_id = ? AND played_at >= ? AND artist_id IS NOT NULL AND artist IS NOT NULL
		 GROUP BY artist_id ORDER BY COUNT(*) DESC, MAX(artist) LIMIT ?`,
		accountId,
		now() - TOP_DAYS * 24 * 60 * 60 * 1000,
		TOP_COUNT
	);
	return rows.map((row) => ({ id: row.id, name: row.name, plays: Number(row.plays) }));
}

/** The page of an account, as anyone allowed to see it is sent it. */
async function viewOf(accountId: string): Promise<ProfileView | null> {
	const database = await store();
	const owner = await database.get<{ backend: string; username: string; handle: string | null; name: string | null; avatar_at: number | null }>(
		`SELECT a.backend, a.username, p.handle, p.name, p.avatar_at FROM accounts a
		 LEFT JOIN profiles p ON p.account_id = a.id WHERE a.id = ?`,
		accountId
	);
	if (!owner?.handle) return null;
	const row = await rowOf(accountId);
	const [recent, top] = await Promise.all([
		Number(row?.recent ?? 0) === 1 ? recentAlbums(accountId) : null,
		Number(row?.top_artists ?? 0) === 1 ? topArtists(accountId) : null
	]);
	return {
		handle: owner.handle,
		name: owner.name ?? owner.username,
		avatar: owner.avatar_at === null ? null : Number(owner.avatar_at),
		backend: owner.backend as BackendKind,
		bio: row?.bio ?? null,
		favourites: albumsOf(row).map(
			(album) =>
				album && {
					id: album.id,
					title: album.title,
					artist: album.artist,
					artistId: album.artistId,
					year: album.year,
					cover: album.coverArt !== null
				}
		),
		recent: recent && recent.map((album) => ({ id: album.id, title: album.title, artist: album.artist, cover: album.coverArt !== null })),
		top
	};
}

/** The account's own page, made (empty) where it has none. */
export async function ownPage(accountId: string): Promise<ProfileView> {
	await ensureHandle(accountId);
	return (await viewOf(accountId))!;
}

/** The account a handle names, if `viewer` may see its page: its own, or a listed one. */
export async function accountOfHandle(handle: string, viewer: string): Promise<string | null> {
	if (!HANDLE.test(handle)) return null;
	const row = await (await store()).get<{ account_id: string; listed: number | null }>(
		`SELECT p.account_id, g.listed FROM profiles p LEFT JOIN profile_pages g ON g.account_id = p.account_id WHERE p.handle = ?`,
		handle
	);
	if (!row) return null;
	return row.account_id === viewer || Number(row.listed ?? 0) === 1 ? row.account_id : null;
}

export async function pageOf(accountId: string): Promise<ProfileView | null> {
	return viewOf(accountId);
}

/** The pages listed to the accounts here, for `/people`, by name. */
export async function listedPages(): Promise<{ handle: string; name: string; avatar: number | null; favourites: number }[]> {
	const rows = await (await store()).all<{ handle: string; name: string | null; username: string; avatar_at: number | null; albums: string }>(
		`SELECT p.handle, p.name, a.username, p.avatar_at, g.albums FROM profile_pages g
		 JOIN profiles p ON p.account_id = g.account_id JOIN accounts a ON a.id = g.account_id
		 WHERE g.listed = 1`
	);
	return rows
		.map((row) => ({
			handle: row.handle,
			name: row.name ?? row.username,
			avatar: row.avatar_at === null ? null : Number(row.avatar_at),
			favourites: albumsOf({ albums: row.albums } as PageRow).filter(Boolean).length
		}))
		.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The cover id at a place on the page: `f0` to `f3` for the four albums, `r0`
 * to `r7` for what was played lately while that is shown. Null for anything
 * else.
 */
export async function coverOfSlot(accountId: string, slot: string): Promise<string | null> {
	const match = /^([fr])([0-9])$/.exec(slot);
	if (!match) return null;
	const index = Number(match[2]);
	const row = await rowOf(accountId);
	if (match[1] === 'f') return index < FAVOURITE_SLOTS ? (albumsOf(row)[index]?.coverArt ?? null) : null;
	if (Number(row?.recent ?? 0) !== 1) return null;
	return (await recentAlbums(accountId))[index]?.coverArt ?? null;
}

/** Makes the account's public link, replacing the one it had. The token is returned this once. */
export async function makeProfileLink(account: Account): Promise<string> {
	const token = `${LINK_PREFIX}${randomToken()}`;
	await ensureHandle(account.id);
	const database = await store();
	await database.run(
		`INSERT INTO profile_pages (account_id, bio, albums, listed, recent, top_artists, link_digest, link_made_at, updated_at)
		 VALUES (?, NULL, ?, 0, 0, 0, ?, ?, ?)
		 ON CONFLICT(account_id) DO UPDATE SET link_digest = excluded.link_digest, link_made_at = excluded.link_made_at`,
		account.id,
		EMPTY_ALBUMS,
		profileLinkDigest(token),
		now(),
		now()
	);
	return token;
}

/** Withdraws the account's public link. False where it had none. */
export async function withdrawProfileLink(accountId: string): Promise<boolean> {
	const result = await (await store()).run(
		'UPDATE profile_pages SET link_digest = NULL, link_made_at = NULL WHERE account_id = ? AND link_digest IS NOT NULL',
		accountId
	);
	return result.changes > 0;
}

/** The account a public link's token is for, or null: a malformed token is not looked up. */
export async function accountOfProfileLink(token: string): Promise<string | null> {
	if (!token.startsWith(LINK_PREFIX) || token.length > MAX_TOKEN_LENGTH) return null;
	const row = await (await store()).get<{ account_id: string }>(
		'SELECT account_id FROM profile_pages WHERE link_digest = ?',
		profileLinkDigest(token)
	);
	return row?.account_id ?? null;
}

/**
 * Takes the page out of sight of everyone but its account: not listed, and
 * its link withdrawn. When the password changes (`storeAccount` in auth.ts),
 * which on Subsonic is also what a name passed to another person looks like,
 * and when the account's sessions are all ended.
 */
export async function hidePage(accountId: string): Promise<void> {
	await (await store()).run(
		'UPDATE profile_pages SET listed = 0, link_digest = NULL, link_made_at = NULL WHERE account_id = ?',
		accountId
	);
}

/** Removes the page, when the account's row passes to another upstream user. */
export async function clearPage(accountId: string): Promise<void> {
	await (await store()).run('DELETE FROM profile_pages WHERE account_id = ?', accountId);
}
