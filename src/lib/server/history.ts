/**
 * The tracks an account has played, for the history page.
 *
 * Neither music server keeps a log Heddohon could read: Subsonic's recent list
 * is of albums, and Jellyfin's `DatePlayed` is the last play of each item. So a
 * row is written here when a play passes the scrobble threshold, which the
 * player reports to `/api/playback` once per play. It is written whether or
 * not the account reports plays to the music server: it stays on this server,
 * and Settings clears it.
 *
 * Plays through a shared link are not recorded. They are someone else
 * listening, and they reach no account's `/api/playback`.
 */
import { store } from './db';
import type { Song } from '$lib/types';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Plays kept per account, the oldest dropped first, by how long the account
 * keeps its history: 5000 for the 90 days of the default, 50,000 for a year,
 * which is a year at about 140 tracks a day.
 */
export function maxPlays(keepDays: number): number {
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
 * `song` is the track as the music server describes it now, kept with the
 * play so the stats page is a query over this table alone. A play recorded
 * without it (the lookup failed) still counts in the history and the totals.
 */
export async function recordPlay(
	accountId: string,
	songId: string,
	options: { at?: number; song?: Song | null; keepDays?: number } = {}
): Promise<void> {
	const at = options.at ?? Date.now();
	const song = options.song ?? null;
	const database = await store();
	await database.run(
		`INSERT INTO plays (account_id, song_id, played_at, title, artist, artist_id, album, album_id, cover_art, duration)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
	);
	await database.run('DELETE FROM plays WHERE account_id = ? AND played_at < ?', accountId, at - (options.keepDays ?? 90) * DAY_MS);
	// The played_at of the play at the limit, and everything older than it.
	// Two plays in one millisecond at the boundary are both kept.
	await database.run(
		`DELETE FROM plays WHERE account_id = ? AND played_at < (
		   SELECT played_at FROM plays WHERE account_id = ? ORDER BY played_at DESC LIMIT 1 OFFSET ?
		 )`,
		accountId,
		accountId,
		maxPlays(options.keepDays ?? 90) - 1
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

/** The periods the stats page offers. */
export const STATS_PERIODS = ['month', 'quarter', 'year', 'all'] as const;
export type StatsPeriod = (typeof STATS_PERIODS)[number];

/**
 * The first moment a period covers: the last 30 or 90 days, the calendar
 * year so far (in UTC; the page is a summary, and the hour either side of
 * midnight on 1 January does not change it), or everything kept.
 */
export function periodStart(period: StatsPeriod, now = Date.now()): number {
	if (period === 'month') return now - 30 * DAY_MS;
	if (period === 'quarter') return now - 90 * DAY_MS;
	if (period === 'year') return Date.UTC(new Date(now).getUTCFullYear(), 0, 1);
	return 0;
}

export interface RankedArtist {
	id: string | null;
	name: string;
	plays: number;
	coverArt: string | null;
}

export interface RankedAlbum {
	id: string;
	name: string;
	artist: string | null;
	plays: number;
	coverArt: string | null;
}

export interface RankedTrack {
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
	 * Hours rather than finished figures, since the hour of the day and the
	 * day of the week are the listener's local ones, which the browser knows
	 * and the server does not. A year is at most 8,784 entries.
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
