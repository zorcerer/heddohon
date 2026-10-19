/**
 * The "New releases" shelf: recent and announced albums and EPs by the
 * artists an account plays most, from MusicBrainz, that the library does not
 * have.
 *
 * Off unless `HEDDOHON_NEW_RELEASES` is on (Settings, Features, or the
 * environment), and then only for an account that turns it on under Settings
 * (`newReleases`). On, the names of that account's ten most played artists of
 * the last year, or the MusicBrainz ids its music server knows for them, are
 * sent from this server to MusicBrainz (or to `HEDDOHON_MUSICBRAINZ_URL`, for
 * a mirror).
 *
 * MusicBrainz takes one request a second from a client and asks it to name
 * itself (musicbrainz.org/doc/MusicBrainz_API/Rate_Limiting), so every request
 * here waits its turn in one queue for the process, and a shelf of ten
 * artists takes 10 to 20 seconds to make. Nobody waits for that but once:
 *
 * - The shelf is started when the account turns it on (`prepareNewReleases`),
 *   so it is usually there by the time the home page is opened.
 * - Made, it is shown at once. Once it is a day old, the home page shows it as
 *   it is and a new one is made behind it (`newReleases`).
 * - What MusicBrainz said, and every account's shelf, are kept in
 *   `HEDDOHON_DATA_DIR/new-releases.json` (`STORE_FILE`), so a restart or an
 *   update starts from them.
 *
 * Only an account's first shelf, with nothing kept, makes the home page wait,
 * and for at most 2.5 seconds (`WAIT_MS`); the shelf is there on a later visit.
 *
 * The answers are third-party text, rendered only as text, capped in size, and
 * fetched with redirects refused.
 */
import { readFileSync, renameSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { mapLimited } from './backends/http';
import { config } from './config';
import { albumsByArtist } from './details';
import { topArtistsSince } from './history';
import type { LibraryContext } from './library';
import { log, reason } from './log';
import { viewerOf } from './memo';
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

/** How old a shelf may be and still be shown while a new one is made. Older, it is made again first. */
const STALE_MS = 7 * DAY_MS;
/** Shelves kept, one an account and upstream user, the oldest dropped first. */
const MAX_SHELVES = 500;
/** How long the home page waits for an account's first shelf. */
const WAIT_MS = 2500;

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

/**
 * Answers held for every account: by key, until a time, at most `max`, the
 * oldest dropped first. What has arrived can be written out and read back
 * (`saved`, `restore`), for the file the cache is kept in.
 */
class Held<T> {
	readonly #entries = new Map<string, { value: Promise<T>; until: number; arrived?: T }>();
	constructor(readonly max: number) {}

	get(key: string, ttl: number, load: () => Promise<T>): Promise<T> {
		const held = this.#entries.get(key);
		if (held && held.until > Date.now()) return held.value;
		const value = load();
		const entry: { value: Promise<T>; until: number; arrived?: T } = { value, until: Date.now() + ttl };
		this.#put(key, entry);
		value.then(
			(arrived) => {
				entry.arrived = arrived;
				saveSoon();
			},
			() => {
				if (this.#entries.get(key) === entry) this.#entries.delete(key);
			}
		);
		return value;
	}

	#put(key: string, entry: { value: Promise<T>; until: number; arrived?: T }) {
		this.#entries.delete(key);
		this.#entries.set(key, entry);
		if (this.#entries.size > this.max) this.#entries.delete(this.#entries.keys().next().value!);
	}

	saved(): [string, number, T][] {
		const now = Date.now();
		return [...this.#entries].flatMap(([key, entry]) =>
			entry.until > now && 'arrived' in entry ? [[key, entry.until, entry.arrived as T] as [string, number, T]] : []
		);
	}

	restore(rows: unknown, valid: (value: unknown) => value is T) {
		if (!Array.isArray(rows)) return;
		const now = Date.now();
		for (const row of rows) {
			if (!Array.isArray(row) || typeof row[0] !== 'string' || typeof row[1] !== 'number' || row[1] <= now || !valid(row[2])) continue;
			this.#put(row[0], { value: Promise.resolve(row[2]), until: row[1], arrived: row[2] });
		}
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

/** The MusicBrainz id the music server keeps for a library artist, from its link there. */
async function knownArtistId(context: LibraryContext, artistId: string): Promise<string | null> {
	const links = await context.backend.getExternalLinks(context.credential, 'artist', artistId).catch(() => []);
	for (const link of links) {
		const id = /musicbrainz\.org\/artist\/([0-9a-f-]{36})/i.exec(link.url)?.[1];
		if (id && MBID.test(id)) return id.toLowerCase();
	}
	return null;
}

/** What the library says of the account's most played artists, through its credential. */
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

/** Each account's shelf and when it was made, by account and upstream user, as `Memo` keys them. */
const shelves = new Map<string, { shelf: NewRelease[]; madeAt: number }>();
/** Shelves being made, so two visits at once make one. */
const making = new Map<string, { library: Promise<unknown>; shelf: Promise<NewRelease[]> }>();

const keyOf = (context: LibraryContext) => `${context.accountId}\u0000${viewerOf(context.credential)}`;

/**
 * Starts a shelf. `library` is the part read through the account's
 * credential, which the caller awaits, so the credential is used within its
 * request alone (invariant 2); `shelf` is MusicBrainz, which needs none and may
 * go on after it.
 */
function make(context: LibraryContext, now: number) {
	const key = keyOf(context);
	const running = making.get(key);
	if (running) return running;
	const library = readLibrary(context, now);
	const shelf = library
		.then((artists) => askMusicBrainz(artists, now))
		.then((made) => {
			shelves.delete(key);
			shelves.set(key, { shelf: made, madeAt: Date.now() });
			if (shelves.size > MAX_SHELVES) shelves.delete(shelves.keys().next().value!);
			saveSoon();
			return made;
		})
		.finally(() => making.delete(key));
	shelf.catch((err) => log.warn('new-releases-failed', { detail: reason(err) }));
	const job = { library: library.catch(() => undefined), shelf };
	making.set(key, job);
	return job;
}

/**
 * The account's shelf for the home page: the one kept, at once, with a new
 * one started behind it where it is a day old; or, with none kept, the first,
 * waited for up to `WAIT_MS`. Empty where the switch is off.
 */
export async function newReleases(context: LibraryContext, now = Date.now()): Promise<NewRelease[]> {
	if (!config().musicbrainzUrl) return [];
	load();
	const kept = shelves.get(keyOf(context));
	const fresh = kept && now - kept.madeAt < DAY_MS;
	if (fresh) return kept.shelf;
	const job = make(context, now);
	await job.library;
	if (kept && now - kept.madeAt < STALE_MS) return kept.shelf;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const late = new Promise<NewRelease[]>((done) => {
		timer = setTimeout(() => done([]), WAIT_MS);
	});
	try {
		return await Promise.race([job.shelf.catch(() => []), late]);
	} finally {
		clearTimeout(timer);
	}
}

/** Starts the account's shelf, where it has none that is fresh: as it turns the shelf on, before its next visit. */
export async function prepareNewReleases(context: LibraryContext, now = Date.now()): Promise<void> {
	if (!config().musicbrainzUrl) return;
	load();
	const kept = shelves.get(keyOf(context));
	if (kept && now - kept.madeAt < DAY_MS) return;
	await make(context, now).library;
}

/* ── Kept on disk ─────────────────────────────────────────────────────── */

/**
 * The MusicBrainz answers and the shelves, in the data directory, mode 0600
 * as `setup.json` is: a shelf names the artists an account plays. A cache
 * alone, made again from nothing where it is missing or unreadable, and not in
 * a backup. Written at most every 5 seconds, by a rename over the old file.
 */
const STORE_FILE = 'new-releases.json';
const SAVE_DELAY_MS = 5000;

let loaded = false;
let saveTimer: ReturnType<typeof setTimeout> | undefined;

const isRelease = (value: unknown): value is NewRelease =>
	!!value && typeof value === 'object' && typeof (value as NewRelease).id === 'string' && typeof (value as NewRelease).title === 'string';
const isGroups = (value: unknown): value is ReleaseGroup[] =>
	Array.isArray(value) && value.every((group) => group && typeof group.id === 'string' && typeof group.date === 'string');
const isId = (value: unknown): value is string | null => value === null || (typeof value === 'string' && MBID.test(value));

function load() {
	if (loaded) return;
	loaded = true;
	let kept: Record<string, unknown>;
	try {
		kept = JSON.parse(readFileSync(join(config().dataDir, STORE_FILE), 'utf8')) as Record<string, unknown>;
	} catch {
		return;
	}
	idsByName.restore(kept.ids, isId);
	groupsByArtist.restore(kept.groups, isGroups);
	if (Array.isArray(kept.shelves)) {
		for (const row of kept.shelves.slice(-MAX_SHELVES)) {
			if (!Array.isArray(row) || typeof row[0] !== 'string' || typeof row[1] !== 'number' || !Array.isArray(row[2])) continue;
			if (!row[2].every(isRelease)) continue;
			shelves.set(row[0], { madeAt: row[1], shelf: row[2] });
		}
	}
}

function saveSoon() {
	if (saveTimer) return;
	saveTimer = setTimeout(save, SAVE_DELAY_MS);
	saveTimer.unref?.();
}

function save() {
	saveTimer = undefined;
	try {
		const path = join(config().dataDir, STORE_FILE);
		const body = JSON.stringify({
			ids: idsByName.saved(),
			groups: groupsByArtist.saved(),
			shelves: [...shelves].map(([key, { madeAt, shelf }]) => [key, madeAt, shelf])
		});
		const scratch = `${path}.${process.pid}.tmp`;
		writeFileSync(scratch, body, { mode: 0o600 });
		chmodSync(scratch, 0o600);
		renameSync(scratch, path);
	} catch (err) {
		log.warn('new-releases-failed', { detail: reason(err) });
	}
}
