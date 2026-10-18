/**
 * The "New releases" shelf: recent and announced albums and EPs by the
 * artists an account plays most, from MusicBrainz, that the library does not
 * have.
 *
 * Off unless `HEDDOHON_NEW_RELEASES=true`, and then only for an account that
 * turns it on under Settings (`newReleases`). On, the names of that account's
 * ten most played artists of the last year, or the MusicBrainz ids its music
 * server knows for them, are sent from this server to MusicBrainz (or to
 * `HEDDOHON_MUSICBRAINZ_URL`, for a mirror).
 *
 * MusicBrainz takes one request a second from a client and asks it to name
 * itself (musicbrainz.org/doc/MusicBrainz_API/Rate_Limiting), so every request
 * here waits its turn in one queue for the process. What an artist has
 * released is the same for every account and is held by the artist's
 * MusicBrainz id for a day; the shelf itself is held per account for a day.
 *
 * The answers are third-party text, rendered only as text, capped in size, and
 * fetched with redirects refused.
 */
import { mapLimited } from './backends/http';
import { config } from './config';
import { albumsByArtist } from './details';
import { topArtistsSince } from './history';
import type { LibraryContext } from './library';
import { log, reason } from './log';
import { Memo } from './memo';
import { fold } from './playlistfiles';
import { APP_VERSION } from './version';

export interface NewRelease {
	/** The MusicBrainz release group. */
	id: string;
	title: string;
	artist: string;
	/** The artist in the library. */
	artistId: string;
	/** `YYYY-MM-DD`, or `YYYY-MM` where MusicBrainz has no day. */
	date: string;
	type: 'Album' | 'EP';
	/** Not out yet. */
	upcoming: boolean;
	url: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** How far back a release still counts as new. */
const RECENT_DAYS = 180;
/** The artists looked up for an account, and how far back their plays are counted. */
const ARTISTS = 10;
const ARTISTS_SINCE_DAYS = 365;
/** Releases on the shelf. */
const SHOWN = 12;
/** Pages of release groups read for one artist, 100 each. */
const MAX_PAGES = 3;

const TIMEOUT_MS = 10_000;
const MAX_BYTES = 1024 * 1024;
/** Between two requests to MusicBrainz: its limit is one a second. */
const SPACING_MS = 1100;

const MBID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/* ── MusicBrainz ──────────────────────────────────────────────────────── */

let queue: Promise<unknown> = Promise.resolve();
let nextAt = 0;

/** A JSON answer from MusicBrainz, in its turn; null for a 404. */
function ask(path: string, params: Record<string, string>): Promise<unknown> {
	const base = config().musicbrainzUrl;
	if (!base) return Promise.resolve(null);
	const turn = queue.then(async () => {
		const wait = nextAt - Date.now();
		if (wait > 0) await new Promise((done) => setTimeout(done, wait));
		nextAt = Date.now() + SPACING_MS;
		const url = new URL(`${base}/ws/2/${path}`);
		for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
		url.searchParams.set('fmt', 'json');
		const response = await fetch(url, {
			headers: {
				accept: 'application/json',
				'user-agent': `Heddohon/${APP_VERSION} ( https://github.com/zorcerer/heddohon )`
			},
			redirect: 'error',
			signal: AbortSignal.timeout(TIMEOUT_MS)
		});
		if (response.status === 404) {
			await response.body?.cancel();
			return null;
		}
		if (!response.ok) {
			await response.body?.cancel();
			throw new Error(`MusicBrainz returned HTTP ${response.status}`);
		}
		const declared = Number(response.headers.get('content-length'));
		if (Number.isFinite(declared) && declared > MAX_BYTES) throw new Error('MusicBrainz answer over the size cap');
		const text = await response.text();
		if (text.length > MAX_BYTES) throw new Error('MusicBrainz answer over the size cap');
		return JSON.parse(text) as unknown;
	});
	queue = turn.catch(() => undefined);
	return turn;
}

/** Held for every account: by key, until a time, at most `max`, the oldest dropped first. */
class Held<T> {
	readonly #entries = new Map<string, { value: Promise<T>; until: number }>();
	constructor(readonly max: number) {}

	get(key: string, ttl: number, load: () => Promise<T>): Promise<T> {
		const held = this.#entries.get(key);
		if (held && held.until > Date.now()) return held.value;
		const value = load();
		this.#entries.delete(key);
		this.#entries.set(key, { value, until: Date.now() + ttl });
		if (this.#entries.size > this.max) this.#entries.delete(this.#entries.keys().next().value!);
		value.catch(() => this.#entries.delete(key));
		return value;
	}
}

/** Artist ids by name, as MusicBrainz's search finds them (a name it does not know is held as null). */
const idsByName = new Held<string | null>(2000);
/** Release groups by artist id. */
const groupsByArtist = new Held<ReleaseGroup[]>(2000);

interface ReleaseGroup {
	id: string;
	title: string;
	date: string;
	type: 'Album' | 'EP';
}

/** Lucene's special characters, escaped for a phrase query. */
function phrase(text: string): string {
	return `"${text.replace(/["\\]/g, '\\$&')}"`;
}

/** The MusicBrainz id of the artist named `name`: the one search result named exactly so, with a full score. */
function artistIdByName(name: string): Promise<string | null> {
	return idsByName.get(fold(name), DAY_MS, async () => {
		const body = (await ask('artist', { query: `artist:${phrase(name)}`, limit: '5' })) as {
			artists?: { id?: unknown; name?: unknown; score?: unknown }[];
		} | null;
		const found = (body?.artists ?? []).find(
			(artist) => typeof artist.name === 'string' && fold(artist.name) === fold(name) && Number(artist.score) === 100
		);
		return typeof found?.id === 'string' && MBID.test(found.id) ? found.id.toLowerCase() : null;
	});
}

/** The artist's albums and EPs as MusicBrainz lists them, with a date, leaving out compilations, live records and the like. */
function releaseGroups(artistId: string): Promise<ReleaseGroup[]> {
	return groupsByArtist.get(artistId, DAY_MS, async () => {
		const groups: ReleaseGroup[] = [];
		for (let page = 0; page < MAX_PAGES; page++) {
			const body = (await ask('release-group', {
				artist: artistId,
				type: 'album|ep',
				limit: '100',
				offset: String(page * 100)
			})) as { 'release-group-count'?: unknown; 'release-groups'?: Record<string, unknown>[] } | null;
			const listed = body?.['release-groups'] ?? [];
			for (const group of listed) {
				const date = group['first-release-date'];
				const type = group['primary-type'];
				const secondary = group['secondary-types'];
				if (typeof group.id !== 'string' || typeof group.title !== 'string') continue;
				if (typeof date !== 'string' || !/^\d{4}-\d{2}(-\d{2})?$/.test(date)) continue;
				if (type !== 'Album' && type !== 'EP') continue;
				if (Array.isArray(secondary) && secondary.length > 0) continue;
				groups.push({ id: group.id, title: group.title.slice(0, 300), date, type });
			}
			if (listed.length < 100 || (page + 1) * 100 >= Number(body?.['release-group-count'] ?? 0)) break;
		}
		return groups;
	});
}

/* ── The shelf ────────────────────────────────────────────────────────── */

/** An artist to look for, with what the library says of it. */
interface Wanted {
	id: string;
	name: string;
	/** The MusicBrainz id the music server keeps for it, where it keeps one. */
	mbid: string | null;
	/** The titles of its albums in the library, folded. */
	owned: string[];
}

/**
 * What the library says of the account's most played artists. Read through
 * the account's credential, so it is awaited by the request; the MusicBrainz
 * part below needs no credential and may run on after it (invariant 2).
 */
const libraryParts = new Memo(DAY_MS, 500);
const shelves = new Memo(DAY_MS, 500);

/** The MusicBrainz id the music server keeps for a library artist, from its link there. */
async function knownArtistId(context: LibraryContext, artistId: string): Promise<string | null> {
	const links = await context.backend.getExternalLinks(context.credential, 'artist', artistId).catch(() => []);
	for (const link of links) {
		const id = /musicbrainz\.org\/artist\/([0-9a-f-]{36})/i.exec(link.url)?.[1];
		if (id && MBID.test(id)) return id.toLowerCase();
	}
	return null;
}

async function readLibrary(context: LibraryContext, now: number): Promise<Wanted[]> {
	const artists = await topArtistsSince(context.accountId, now - ARTISTS_SINCE_DAYS * DAY_MS, ARTISTS);
	return mapLimited(artists, async (artist) => ({
		...artist,
		mbid: await knownArtistId(context, artist.id),
		owned: (await albumsByArtist(context, artist.id).catch(() => [])).map((album) => fold(album.name))
	}));
}

async function askMusicBrainz(artists: Wanted[], now: number): Promise<NewRelease[]> {
	const since = new Date(now - RECENT_DAYS * DAY_MS).toISOString().slice(0, 10);
	const today = new Date(now).toISOString().slice(0, 10);
	const found: NewRelease[] = [];
	// One artist at a time: MusicBrainz is asked one request a second anyway.
	for (const artist of artists) {
		try {
			const mbid = artist.mbid ?? (await artistIdByName(artist.name));
			if (!mbid) continue;
			const owned = new Set(artist.owned);
			for (const group of await releaseGroups(mbid)) {
				if (group.date < since || owned.has(fold(group.title))) continue;
				found.push({
					id: group.id,
					title: group.title,
					artist: artist.name,
					artistId: artist.id,
					date: group.date,
					type: group.type,
					upcoming: group.date > today,
					url: `https://musicbrainz.org/release-group/${group.id}`
				});
			}
		} catch (err) {
			log.warn('new-releases-failed', { detail: reason(err) });
		}
	}
	// The newest first, an announced one ahead of anything out.
	return found.sort((a, b) => b.date.localeCompare(a.date)).slice(0, SHOWN);
}

/** How long the home page waits for MusicBrainz; past it the page goes without, and the next visit has the shelf. */
const WAIT_MS = 2500;

/**
 * The account's shelf, or an empty one where the switch is off, or while
 * MusicBrainz is still being asked for the first time that day (the shelf is
 * kept when it is done).
 */
export async function newReleases(context: LibraryContext, now = Date.now()): Promise<NewRelease[]> {
	if (!config().musicbrainzUrl) return [];
	const artists = await libraryParts.get(context, 'artists', () => readLibrary(context, now));
	const shelf = shelves.get(context, 'shelf', () => askMusicBrainz(artists, now));
	let timer: ReturnType<typeof setTimeout> | undefined;
	const late = new Promise<NewRelease[]>((done) => {
		timer = setTimeout(() => done([]), WAIT_MS);
	});
	try {
		return await Promise.race([shelf, late]);
	} finally {
		clearTimeout(timer);
	}
}
