/**
 * The tracks an account has played, for the history page.
 *
 * Neither music server's API has a log to read: Subsonic's recent list is of
 * albums, and Jellyfin's `DatePlayed` is each item's last play. A row is
 * written here when a play passes the scrobble threshold, which the player
 * reports to `/api/playback` once per play, whether or not the account reports
 * plays upstream. It stays on this server, and Settings clears it.
 *
 * The music server's last play of each song can be brought in once from
 * Settings (`importPlays`).
 *
 * Navidrome does keep a log, its scrobble history, which only a plugin inside
 * it can read. Where the Heddohon plugin is installed (`plugin.ts`), a play
 * made in another app is written here as Navidrome reports it
 * (`recordScrobble`), and the import is of every play (`openScrobbleImport`).
 *
 * Plays through a shared link reach no account's `/api/playback` and are not
 * recorded.
 */
import { store } from './db';
import type { Song } from '$lib/types';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Plays kept per account, oldest dropped first, by how long the account keeps
 * its history: 5000 for 90 days, 50,000 for a year (about 140 tracks a day),
 * unlimited for 0 (the default).
 */
function maxPlays(keepDays: number): number {
	if (keepDays === 0) return Infinity;
	return keepDays > 90 ? 50_000 : 5000;
}

export interface Play {
	songId: string;
	/** Epoch millis. */
	playedAt: number;
}

/**
 * Records a play, and drops what is past either limit for the account.
 *
 * `song` is the track as the music server describes it now, kept with the play
 * so the stats page reads this table alone. A play recorded without it (the
 * lookup failed) still counts in the history and the totals.
 */
export async function recordPlay(
	accountId: string,
	songId: string,
	options: { at?: number; song?: Song | null; keepDays?: number } = {}
): Promise<void> {
	const at = options.at ?? Date.now();
	const database = await store();
	await database.run(
		`INSERT INTO plays (${COLUMNS}) VALUES ${ROW}`,
		...playRow(accountId, songId, at, options.song ?? null)
	);
	await trim(accountId, at, options.keepDays ?? 0);
}

const COLUMNS = 'account_id, song_id, played_at, title, artist, artist_id, album, album_id, cover_art, duration';
const ROW = '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';

function playRow(accountId: string, songId: string, at: number, song: Song | null): unknown[] {
	return [
		accountId,
		songId,
		at,
		song?.title ?? null,
		song?.artist ?? null,
		song?.artistId ?? null,
		song?.album ?? null,
		song?.albumId ?? null,
		song?.coverArt ?? null,
		song ? Math.round(song.duration) : null
	];
}

/** Drops what is past either limit for the account, as of `now`. */
async function trim(accountId: string, now: number, keepDays: number): Promise<void> {
	if (keepDays === 0) return;
	const database = await store();
	await database.run('DELETE FROM plays WHERE account_id = ? AND played_at < ?', accountId, now - keepDays * DAY_MS);
	// The played_at of the play at the limit, and everything older than it.
	// Two plays in one millisecond at the boundary are both kept.
	await database.run(
		`DELETE FROM plays WHERE account_id = ? AND played_at < (
		   SELECT played_at FROM plays WHERE account_id = ? ORDER BY played_at DESC LIMIT 1 OFFSET ?
		 )`,
		accountId,
		accountId,
		maxPlays(keepDays) - 1
	);
}

/** A page of the account's plays, newest first, and how many there are. */
export async function recentPlays(accountId: string, limit: number, offset: number): Promise<{ plays: Play[]; total: number }> {
	const database = await store();
	const [rows, count] = await Promise.all([
		database.all<{ song_id: string; played_at: number }>(
			'SELECT song_id, played_at FROM plays WHERE account_id = ? ORDER BY played_at DESC LIMIT ? OFFSET ?',
			accountId,
			limit,
			offset
		),
		database.get<{ count: number }>('SELECT COUNT(*) AS count FROM plays WHERE account_id = ?', accountId)
	]);
	return {
		plays: rows.map((row) => ({ songId: row.song_id, playedAt: Number(row.played_at) })),
		total: Number(count?.count ?? 0)
	};
}

/** Forgets every play of the account. Returns how many there were. */
export async function clearHistory(accountId: string): Promise<number> {
	return (await (await store()).run('DELETE FROM plays WHERE account_id = ?', accountId)).changes;
}

/**
 * How far apart, beyond the song's length, this server's record of a play and
 * the music server's date for it may be and still be one play. Heddohon
 * records a play when it stops, Jellyfin dates it from the start, and
 * Navidrome from the scrobble, sent as the track stops.
 */
const SAME_PLAY_SLACK_MS = 5 * 60 * 1000;

/** Rows per `INSERT`: 10 parameters each, under SQLite's older limit of 999. */
const IMPORT_CHUNK = 90;

/** Accounts with an import running, so a second click does not import twice. */
const importing = new Set<string>();

export interface ImportResult {
	/** Songs the music server gave a last-played date for. */
	found: number;
	/** Plays added to the history. */
	imported: number;
}

/**
 * Adds the music server's last play of each song to the account's history:
 * one play per song, at the date the server kept (`getPlayedSongs`).
 *
 * Skipped: a play the history already holds (the same song within its length
 * and `SAME_PLAY_SLACK_MS` of the date), which covers plays made here and a
 * repeated import, and a play older than the account keeps history for. `read`
 * is the call to the music server. Null while an import for the account is
 * running.
 */
export async function importPlays(
	accountId: string,
	read: () => Promise<{ song: Song; playedAt: number }[]>,
	keepDays: number,
	now = Date.now()
): Promise<ImportResult | null> {
	if (importing.has(accountId)) return null;
	importing.add(accountId);
	try {
		const played = await read();
		const database = await store();
		const existing = new Map<string, number[]>();
		for (const row of await database.all<{ song_id: string; played_at: number }>(
			'SELECT song_id, played_at FROM plays WHERE account_id = ?',
			accountId
		)) {
			const times = existing.get(row.song_id) ?? [];
			times.push(Number(row.played_at));
			existing.set(row.song_id, times);
		}

		const oldest = keepDays === 0 ? 0 : now - keepDays * DAY_MS;
		const rows = played.filter(({ song, playedAt }) => {
			if (!(playedAt >= oldest && playedAt <= now)) return false;
			const window = Math.max(0, song.duration) * 1000 + SAME_PLAY_SLACK_MS;
			return !existing.get(song.id)?.some((at) => Math.abs(at - playedAt) <= window);
		});

		for (let i = 0; i < rows.length; i += IMPORT_CHUNK) {
			const chunk = rows.slice(i, i + IMPORT_CHUNK);
			await database.run(
				`INSERT INTO plays (${COLUMNS}) VALUES ${chunk.map(() => ROW).join(', ')}`,
				...chunk.flatMap(({ song, playedAt }) => playRow(accountId, song.id, playedAt, song))
			);
		}
		await trim(accountId, now, keepDays);
		return { found: played.length, imported: rows.length };
	} finally {
		importing.delete(accountId);
	}
}

/**
 * How far apart this server's time for a play and Navidrome's time for its
 * scrobble may be and still be one play. A play made here is recorded and then
 * scrobbled with the same time (`at` in `PlaybackReport`), and before that was
 * sent Navidrome dated the scrobble as it arrived, a request later. A track is
 * not scrobbled before 30 seconds of it have played, so two plays of one song
 * by one listener are further apart than this.
 */
const SAME_SCROBBLE_MS = 30 * 1000;

/**
 * One at a time for an account: a look for a play and then its insert, which
 * must not interleave with another's. A play Navidrome reports as it happens
 * and the page of an import can hold the same play, and on PostgreSQL each
 * statement is a round trip during which the other runs.
 *
 * In this process's memory, like the imports themselves (`plugin.ts`).
 */
const turns = new Map<string, Promise<unknown>>();

function inTurn<T>(accountId: string, work: () => Promise<T>): Promise<T> {
	const turn = (turns.get(accountId) ?? Promise.resolve()).then(work);
	const done = turn.catch(() => undefined);
	turns.set(accountId, done);
	void done.then(() => {
		if (turns.get(accountId) === done) turns.delete(accountId);
	});
	return turn;
}

/**
 * Records a play Navidrome reports through its plugin (`plugin.ts`), which
 * hears of every play of the account, the ones made here among them. False
 * for one the history already holds, and for one older than the account keeps.
 */
export async function recordScrobble(
	accountId: string,
	song: Song,
	at: number,
	keepDays: number,
	now = Date.now()
): Promise<boolean> {
	if (keepDays !== 0 && at < now - keepDays * DAY_MS) return false;
	return inTurn(accountId, async () => {
		if (await hasScrobble(accountId, song.id, at)) return false;
		await recordPlay(accountId, song.id, { at, song, keepDays });
		return true;
	});
}

/** Whether the history holds a play of the song within `SAME_SCROBBLE_MS` of `at`. */
export async function hasScrobble(accountId: string, songId: string, at: number): Promise<boolean> {
	// The time first: the index is on the account and the time, and the range
	// holds a play or two.
	const row = await (await store()).get<{ song_id: string }>(
		'SELECT song_id FROM plays WHERE account_id = ? AND played_at >= ? AND played_at <= ? AND song_id = ? LIMIT 1',
		accountId,
		at - SAME_SCROBBLE_MS,
		at + SAME_SCROBBLE_MS,
		songId
	);
	return row !== undefined;
}

/** An import of Navidrome's scrobble history, which arrives a page at a time; see `plugin.ts`. */
export interface ScrobbleImport {
	/** Adds a page: the plays the history lacks, of songs the account can read. */
	add(plays: Play[]): Promise<void>;
	/** Scrobbles received and plays added so far. */
	readonly result: ImportResult;
	/** Drops what is past the account's limits and lets another import start. */
	end(): Promise<void>;
}

/**
 * Starts an import of every play Navidrome kept for the account, where
 * `importPlays` has only the last play of each song.
 *
 * `read` is the same call, used here for the songs alone: a scrobble names
 * only a song's id, and a song with a scrobble has been played. A scrobble of
 * a song the account can no longer read is skipped, as is one the history
 * already holds (`SAME_SCROBBLE_MS`), which covers plays made here, an earlier
 * import of either kind and a page sent twice. Null while an import for the
 * account is running.
 */
export async function openScrobbleImport(
	accountId: string,
	read: () => Promise<{ song: Song; playedAt: number }[]>,
	keepDays: number,
	now = Date.now()
): Promise<ScrobbleImport | null> {
	if (importing.has(accountId)) return null;
	importing.add(accountId);
	try {
		const songs = new Map<string, Song>();
		for (const { song } of await read()) songs.set(song.id, song);
		const database = await store();
		const oldest = keepDays === 0 ? 0 : now - keepDays * DAY_MS;
		const result: ImportResult = { found: 0, imported: 0 };
		let ended = false;

		/**
		 * A page's plays the history lacks. What it holds is read as each page
		 * arrives. Read once at the start, it missed the plays Navidrome
		 * reported while the import ran: 47 were in the history twice after an
		 * import of 6,073 made while plays were still arriving.
		 */
		const missing = async (plays: Play[]): Promise<{ song: Song; playedAt: number }[]> => {
			const wanted = plays.filter(({ songId, playedAt }) => songs.has(songId) && playedAt >= oldest && playedAt <= now);
			if (wanted.length === 0) return [];
			let first = Infinity;
			let last = -Infinity;
			for (const { playedAt } of wanted) {
				first = Math.min(first, playedAt);
				last = Math.max(last, playedAt);
			}
			const held = new Map<string, number[]>();
			for (const row of await database.all<{ song_id: string; played_at: number }>(
				'SELECT song_id, played_at FROM plays WHERE account_id = ? AND played_at >= ? AND played_at <= ?',
				accountId,
				first - SAME_SCROBBLE_MS,
				last + SAME_SCROBBLE_MS
			)) {
				const times = held.get(row.song_id) ?? [];
				times.push(Number(row.played_at));
				held.set(row.song_id, times);
			}
			const rows: { song: Song; playedAt: number }[] = [];
			for (const { songId, playedAt } of wanted) {
				const times = held.get(songId) ?? [];
				if (times.some((at) => Math.abs(at - playedAt) <= SAME_SCROBBLE_MS)) continue;
				// Held with the rest, so the same play later in the page is skipped too.
				times.push(playedAt);
				held.set(songId, times);
				rows.push({ song: songs.get(songId)!, playedAt });
			}
			return rows;
		};

		return {
			result,
			add: (plays) =>
				inTurn(accountId, async () => {
					if (ended) return;
					result.found += plays.length;
					const rows = await missing(plays);
					for (let i = 0; i < rows.length; i += IMPORT_CHUNK) {
						const chunk = rows.slice(i, i + IMPORT_CHUNK);
						await database.run(
							`INSERT INTO plays (${COLUMNS}) VALUES ${chunk.map(() => ROW).join(', ')}`,
							...chunk.flatMap(({ song, playedAt }) => playRow(accountId, song.id, playedAt, song))
						);
					}
					result.imported += rows.length;
				}),
			async end() {
				if (ended) return;
				ended = true;
				importing.delete(accountId);
				await trim(accountId, now, keepDays);
			}
		};
	} catch (err) {
		importing.delete(accountId);
		throw err;
	}
}

/** The periods the stats page offers. */
export const STATS_PERIODS = ['month', 'quarter', 'year', 'all'] as const;
export type StatsPeriod = (typeof STATS_PERIODS)[number];

/**
 * The first moment a period covers: the last 30 or 90 days, the calendar year
 * so far (in UTC), or everything kept.
 */
export function periodStart(period: StatsPeriod, now = Date.now()): number {
	if (period === 'month') return now - 30 * DAY_MS;
	if (period === 'quarter') return now - 90 * DAY_MS;
	if (period === 'year') return Date.UTC(new Date(now).getUTCFullYear(), 0, 1);
	return 0;
}

interface RankedArtist {
	id: string | null;
	name: string;
	plays: number;
	coverArt: string | null;
}

interface RankedAlbum {
	id: string;
	name: string;
	artist: string | null;
	plays: number;
	coverArt: string | null;
}

interface RankedTrack {
	id: string;
	title: string;
	artist: string | null;
	albumId: string | null;
	plays: number;
	coverArt: string | null;
}

export interface ListeningStats {
	plays: number;
	/** Seconds, from the plays whose length was kept. */
	seconds: number;
	tracks: number;
	artists: number;
	topArtists: RankedArtist[];
	topAlbums: RankedAlbum[];
	topTracks: RankedTrack[];
	/** Artists whose first kept play falls in the period, most played first. */
	newArtists: RankedArtist[];
	/**
	 * Plays by the hour they started in, as `[hours since the epoch, plays]`.
	 * The hour of the day and the day of the week are the listener's local
	 * ones, which only the browser knows. A year is at most 8,784 entries.
	 */
	hours: [number, number][];
}

const TOP = 10;
const HOUR_MS = 60 * 60 * 1000;

/** An account's listening from `from` on, from the history table alone. */
export async function listeningStats(accountId: string, from: number): Promise<ListeningStats> {
	const database = await store();
	const scope = 'account_id = ? AND played_at >= ?';
	// Grouped by id where the server gave one, by name otherwise.
	const artistKey = 'COALESCE(artist_id, artist)';
	const [totals, topArtists, topAlbums, topTracks, newArtists, hours] = await Promise.all([
		database.get<{ plays: number; seconds: number | null; tracks: number; artists: number }>(
			`SELECT COUNT(*) AS plays, SUM(duration) AS seconds, COUNT(DISTINCT song_id) AS tracks,
			        COUNT(DISTINCT ${artistKey}) AS artists
			 FROM plays WHERE ${scope}`,
			accountId,
			from
		),
		database.all<{ id: string | null; name: string; plays: number; cover: string | null }>(
			`SELECT MAX(artist_id) AS id, MAX(artist) AS name, COUNT(*) AS plays, MAX(cover_art) AS cover
			 FROM plays WHERE ${scope} AND artist IS NOT NULL
			 GROUP BY ${artistKey} ORDER BY COUNT(*) DESC, MAX(artist) LIMIT ${TOP}`,
			accountId,
			from
		),
		database.all<{ id: string; name: string | null; artist: string | null; plays: number; cover: string | null }>(
			`SELECT album_id AS id, MAX(album) AS name, MAX(artist) AS artist, COUNT(*) AS plays, MAX(cover_art) AS cover
			 FROM plays WHERE ${scope} AND album_id IS NOT NULL
			 GROUP BY album_id ORDER BY COUNT(*) DESC, MAX(album) LIMIT ${TOP}`,
			accountId,
			from
		),
		database.all<{ id: string; title: string | null; artist: string | null; album: string | null; plays: number; cover: string | null }>(
			`SELECT song_id AS id, MAX(title) AS title, MAX(artist) AS artist, MAX(album_id) AS album, COUNT(*) AS plays,
			        MAX(cover_art) AS cover
			 FROM plays WHERE ${scope} AND title IS NOT NULL
			 GROUP BY song_id ORDER BY COUNT(*) DESC, MAX(title) LIMIT ${TOP}`,
			accountId,
			from
		),
		// First heard: the earliest play over everything kept, not only the period.
		database.all<{ id: string | null; name: string; plays: number; cover: string | null }>(
			`SELECT MAX(artist_id) AS id, MAX(artist) AS name, COUNT(*) AS plays, MAX(cover_art) AS cover
			 FROM plays WHERE account_id = ? AND artist IS NOT NULL
			 GROUP BY ${artistKey} HAVING MIN(played_at) >= ? ORDER BY COUNT(*) DESC, MAX(artist) LIMIT ${TOP}`,
			accountId,
			// Everything kept is new against nothing, so the whole history names none.
			from > 0 ? from : Number.MAX_SAFE_INTEGER
		),
		database.all<{ hour: number; plays: number }>(
			`SELECT played_at / ${HOUR_MS} AS hour, COUNT(*) AS plays FROM plays WHERE ${scope}
			 GROUP BY played_at / ${HOUR_MS} ORDER BY hour`,
			accountId,
			from
		)
	]);
	const artist = (row: { id: string | null; name: string; plays: number; cover: string | null }): RankedArtist => ({
		id: row.id,
		name: row.name,
		plays: Number(row.plays),
		coverArt: row.cover
	});
	return {
		plays: Number(totals?.plays ?? 0),
		seconds: Number(totals?.seconds ?? 0),
		tracks: Number(totals?.tracks ?? 0),
		artists: Number(totals?.artists ?? 0),
		topArtists: topArtists.map(artist),
		topAlbums: topAlbums.map((row) => ({
			id: row.id,
			name: row.name ?? 'Unknown album',
			artist: row.artist,
			plays: Number(row.plays),
			coverArt: row.cover
		})),
		topTracks: topTracks.map((row) => ({
			id: row.id,
			title: row.title ?? 'Unknown title',
			artist: row.artist,
			albumId: row.album,
			plays: Number(row.plays),
			coverArt: row.cover
		})),
		newArtists: newArtists.map(artist),
		hours: hours.map((row) => [Math.floor(Number(row.hour)), Number(row.plays)])
	};
}

/** An album played on this date in an earlier year, for the home page. */
export interface RememberedAlbum {
	id: string;
	name: string;
	artist: string | null;
	coverArt: string | null;
	/** The latest earlier year it was played on this date. */
	year: number;
	/** Its plays on this date, over every earlier year. */
	plays: number;
}

/** A calendar date: the month from 0, as `Date` numbers it. */
export interface CalendarDate {
	year: number;
	month: number;
	day: number;
}

/**
 * Albums played on `date` in the years before it, the most recent year first
 * and within a year the most played, for the "On this day" shelf.
 *
 * The date and `offsetMinutes`, the listener's distance ahead of UTC, come
 * from the browser. Today's offset stands for the offset on this date in each
 * earlier year. A year without the date (29 February) is skipped.
 *
 * One range read of the account's index per year. With SQLite on 250,000 plays
 * over five years (about 140 a day): 1ms for the five, where one query with
 * the ranges joined by OR read the account's plays in order and took 23ms.
 */
export async function onThisDay(accountId: string, date: CalendarDate, offsetMinutes: number, limit: number): Promise<RememberedAlbum[]> {
	const database = await store();
	const first = await database.get<{ at: number | null }>('SELECT MIN(played_at) AS at FROM plays WHERE account_id = ?', accountId);
	if (first?.at == null) return [];
	const years: number[] = [];
	// From the year before the first play's in UTC: in a time zone behind UTC
	// it can still be that year.
	for (let year = new Date(Number(first.at)).getUTCFullYear() - 1; year < date.year; year++) {
		if (new Date(Date.UTC(year, date.month, date.day)).getUTCDate() === date.day) years.push(year);
	}
	const byYear = await Promise.all(
		years.map((year) => {
			const midnight = Date.UTC(year, date.month, date.day) - offsetMinutes * 60 * 1000;
			return database.all<{ id: string; name: string | null; artist: string | null; cover: string | null; plays: number }>(
				`SELECT album_id AS id, MAX(album) AS name, MAX(artist) AS artist, MAX(cover_art) AS cover, COUNT(*) AS plays
				 FROM plays WHERE account_id = ? AND played_at >= ? AND played_at < ? AND album_id IS NOT NULL
				 GROUP BY album_id`,
				accountId,
				midnight,
				midnight + DAY_MS
			);
		})
	);
	const albums = new Map<string, RememberedAlbum>();
	byYear.forEach((rows, i) => {
		for (const row of rows) {
			const album = albums.get(row.id);
			// Years are read oldest first, so a later one replaces the year.
			if (album) {
				album.year = years[i];
				album.plays += Number(row.plays);
			} else {
				albums.set(row.id, {
					id: row.id,
					name: row.name ?? 'Unknown album',
					artist: row.artist,
					coverArt: row.cover,
					year: years[i],
					plays: Number(row.plays)
				});
			}
		}
	});
	return [...albums.values()].sort((a, b) => b.year - a.year || b.plays - a.plays).slice(0, limit);
}

export interface ForgottenAlbum {
	id: string;
	name: string;
	artist: string | null;
	coverArt: string | null;
	plays: number;
	/** Epoch millis of the album's latest play. */
	lastPlayed: number;
}

/** How long an album has gone unplayed before "Rediscover" offers it. */
const REDISCOVER_AFTER_DAYS = 180;

/**
 * Plays an album needs to count as played often. An imported history has one
 * play per track, so this is also three tracks of an album played once each.
 */
const REDISCOVER_MIN_PLAYS = 3;

/**
 * Albums the account played often and has not played for
 * `REDISCOVER_AFTER_DAYS`, most played first, for the "Rediscover" shelf. An
 * account that keeps 90 days of history has none.
 *
 * In two steps: the albums from `plays_album_idx` alone, then each one's name,
 * artist and cover from its latest play. With SQLite on 250,000 plays of 3000
 * albums: 22ms, where one query grouping the rows took 330ms, and
 * better-sqlite3 blocks the event loop for that long on every home page load.
 */
export async function forgottenAlbums(accountId: string, limit: number, now = Date.now()): Promise<ForgottenAlbum[]> {
	const database = await store();
	const albums = await database.all<{ id: string; plays: number; last: number }>(
		`SELECT album_id AS id, COUNT(*) AS plays, MAX(played_at) AS last
		 FROM plays WHERE account_id = ? AND album_id IS NOT NULL
		 GROUP BY album_id HAVING MAX(played_at) < ? AND COUNT(*) >= ${REDISCOVER_MIN_PLAYS}
		 ORDER BY COUNT(*) DESC, album_id LIMIT ?`,
		accountId,
		now - REDISCOVER_AFTER_DAYS * DAY_MS,
		limit
	);
	return Promise.all(
		albums.map(async (album) => {
			const latest = await database.get<{ name: string | null; artist: string | null; cover: string | null }>(
				`SELECT album AS name, artist, cover_art AS cover FROM plays
				 WHERE account_id = ? AND album_id = ? ORDER BY played_at DESC LIMIT 1`,
				accountId,
				album.id
			);
			return {
				id: album.id,
				name: latest?.name ?? 'Unknown album',
				artist: latest?.artist ?? null,
				coverArt: latest?.cover ?? null,
				plays: Number(album.plays),
				lastPlayed: Number(album.last)
			};
		})
	);
}
