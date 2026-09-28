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

/** Plays kept per account, the oldest dropped first. */
export const MAX_PLAYS = 5000;
/** How long a play is kept. */
export const MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

export interface Play {
	songId: string;
	/** Epoch millis. */
	playedAt: number;
}

/** Records a play, and drops what is past either limit for the account. */
export async function recordPlay(accountId: string, songId: string, at = Date.now()): Promise<void> {
	const database = await store();
	await database.run('INSERT INTO plays (account_id, song_id, played_at) VALUES (?, ?, ?)', accountId, songId, at);
	await database.run('DELETE FROM plays WHERE account_id = ? AND played_at < ?', accountId, at - MAX_AGE_MS);
	// The played_at of the play at the limit, and everything older than it.
	// Two plays in one millisecond at the boundary are both kept.
	await database.run(
		`DELETE FROM plays WHERE account_id = ? AND played_at < (
		   SELECT played_at FROM plays WHERE account_id = ? ORDER BY played_at DESC LIMIT 1 OFFSET ?
		 )`,
		accountId,
		accountId,
		MAX_PLAYS - 1
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
