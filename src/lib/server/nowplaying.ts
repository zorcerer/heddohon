/**
 * A link that shows what one account is playing, without a sign-in: a page
 * for an OBS browser source (`/now/<token>`), JSON for Home Assistant's REST
 * sensor or a script (`/api/now-playing/<token>`), and the track's cover
 * (`/api/now-playing/<token>/cover`).
 *
 * The account makes it and withdraws it under Settings, Account; it has one at
 * a time, and a new one replaces the old. The token is stored as a digest
 * under a key of its own (`nowPlayingDigest`), as share and MCP tokens are, so
 * a copy of the database opens nothing. It is withdrawn with the account's
 * sessions (`destroyAllSessions`): a password changed upstream or a user name
 * reused by someone else ends it.
 *
 * What it shows is what the account's browsers report over the remote
 * control's event streams (`remote.ts`), and what its other apps play where
 * the account has chosen to show those (`listeningOtherApps`): the title,
 * artist, album, length and position of a track that is playing. Paused, or
 * with nothing playing, it says so and nothing more. Without
 * `HEDDOHON_REMOTE_CONTROL` there are no reports, and the routes answer 404.
 */
import { config } from './config';
import { nowPlayingDigest, randomToken } from './crypto';
import { now, store } from './db';
import { playingInApps, playingOn, type RemoteState } from './remote';

const PREFIX = 'hhnp_';
/** The prefix and 43 characters of `randomToken`, with room. Anything longer is no token. */
const MAX_TOKEN_LENGTH = 64;

/** Makes the account's link, replacing the one it had. The token is returned this once. */
export async function makeNowPlayingLink(accountId: string): Promise<string> {
	const token = `${PREFIX}${randomToken()}`;
	const database = await store();
	await database.run('DELETE FROM now_playing_links WHERE account_id = ?', accountId);
	await database.run(
		'INSERT INTO now_playing_links (account_id, token_digest, created_at) VALUES (?, ?, ?)',
		accountId,
		nowPlayingDigest(token),
		now()
	);
	return token;
}

/** Withdraws the account's link. False where it had none. */
export async function withdrawNowPlayingLink(accountId: string): Promise<boolean> {
	const result = await (await store()).run('DELETE FROM now_playing_links WHERE account_id = ?', accountId);
	return result.changes > 0;
}

/** When the account's link was made, or null where it has none. */
export async function nowPlayingLinkMadeAt(accountId: string): Promise<number | null> {
	const row = await (await store()).get<{ created_at: number }>(
		'SELECT created_at FROM now_playing_links WHERE account_id = ?',
		accountId
	);
	return row ? Number(row.created_at) : null;
}

/** The account a token is the link of, or null: a malformed token is not looked up. */
export async function accountOfNowPlaying(token: string): Promise<string | null> {
	if (!config().remoteControl) return null;
	if (!token.startsWith(PREFIX) || token.length > MAX_TOKEN_LENGTH) return null;
	const row = await (await store()).get<{ account_id: string }>(
		'SELECT account_id FROM now_playing_links WHERE token_digest = ?',
		nowPlayingDigest(token)
	);
	return row?.account_id ?? null;
}

export type NowPlaying =
	| { playing: false }
	| {
			playing: true;
			title: string;
			artist: string | null;
			album: string | null;
			/** Seconds. */
			duration: number;
			/** Seconds into the track as of this answer. */
			position: number;
			/** Whether `/api/now-playing/<token>/cover` has a picture for it. */
			cover: boolean;
	  };

/**
 * The track the account is playing: of its browsers and apps that play, the
 * one heard from last. Its cover id stays here (`coverOf`).
 */
function current(accountId: string): RemoteState | null {
	const reports = [...playingOn(accountId), ...playingInApps(accountId)];
	return reports.reduce<RemoteState | null>((latest, { state }) => (latest && latest.at >= state.at ? latest : state), null);
}

export function nowPlaying(accountId: string, at = Date.now()): NowPlaying {
	const state = current(accountId);
	if (!state) return { playing: false };
	const moved = state.position + Math.max(0, at - state.at) / 1000;
	return {
		playing: true,
		title: state.title,
		artist: state.artist,
		album: state.album,
		duration: Math.round(state.duration),
		position: Math.round(state.duration > 0 ? Math.min(moved, state.duration) : moved),
		cover: state.coverArt !== null
	};
}

/** The cover id of what the account is playing, or null. */
export function coverOf(accountId: string): string | null {
	return current(accountId)?.coverArt ?? null;
}
