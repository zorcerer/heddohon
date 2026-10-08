/**
 * What the Heddohon plugin for Navidrome sends, which is how plays made in
 * other apps reach the history. The plugin is in a repository of its own,
 * github.com/zorcerer/heddohon-navidrome-plugin, whose README sets out the
 * messages; a change to one of them is a change there too.
 *
 * Navidrome calls the plugin for every play of a user, whichever client made
 * it, and keeps a scrobble history only a plugin can read. A plugin cannot be
 * called from outside Navidrome, so it posts to `/api/plugin/navidrome` here:
 * each play as it happens, and every 15 seconds a poll, which is answered with
 * the accounts whose scrobble history is wanted.
 *
 * The endpoint exists only where `HEDDOHON_NAVIDROME_PLUGIN_TOKEN` is set, and
 * the plugin proves itself with that token. What the token allows:
 *
 * - A play goes into the history of the account its user name signs in to,
 *   only where that account's stored credential still signs in to Navidrome
 *   and reads the song. The row holds the song as Navidrome describes it to
 *   that account, never text from the request.
 * - A page of scrobble history is taken only for an account that asked for an
 *   import from Settings, while that import is open.
 * - What an app is playing now is held in memory for that account's own
 *   browsers (`reportApp` in `remote.ts`), under the same lookup: the track
 *   shown is the one Navidrome describes to the account. The one text taken
 *   from the request is the app's name, cleaned and cut to 32 characters, and
 *   it is shown to that account alone.
 * - Nothing is read: the answer names the accounts with an import open and
 *   holds nothing else.
 *
 * An account turns plays from other apps off under Settings
 * (`historyOtherApps`). What its apps play is shown to other accounts only
 * where it has turned that on (`listeningOtherApps`; see `listening.ts`).
 */
import { createHash } from 'node:crypto';
import type { Account } from './auth';
import { accountOfUser } from './auth';
import { backendFor, UpstreamError, type StoredCredential } from './backends';
import { CLIENT_NAME } from './backends/subsonic';
import { config } from './config';
import { constantTimeEquals, pluginDigest } from './crypto';
import { openScrobbleImport, recordScrobble, hasScrobble, type ImportResult, type ScrobbleImport } from './history';
import { appChanged, cleanName } from './listening';
import { log } from './log';
import { foldName } from './names';
import { reportApp } from './remote';
import { getSettings } from './settings';
import type { BackendKind, Song } from '$lib/types';

/** Plays in one message as they happen. The plugin sends one. */
export const MAX_PLAYS = 100;
/** Scrobbles in one page of history. The plugin sends 1000. */
export const MAX_HISTORY_PAGE = 2000;

/**
 * How far ahead of this server's clock a play's time may be, for a Navidrome
 * on another machine. A later one is refused.
 */
const CLOCK_SLACK_MS = 5 * 60 * 1000;

/**
 * How long after its last request the plugin is taken to be running. It polls
 * every 15 seconds, so this is three polls missed.
 */
const HEARD_WITHIN_MS = 60 * 1000;

let heardAt = 0;

/** Whether the plugin's endpoint is on for accounts of this kind. */
export function pluginOffered(kind: BackendKind): boolean {
	const cfg = config();
	return kind === 'subsonic' && cfg.navidromePluginToken !== null && cfg.upstreams.some((up) => up.kind === 'subsonic');
}

/** Whether the plugin has sent anything in the last minute. Memory of this process, so false after a restart until the next poll. */
export function pluginHeard(): boolean {
	return Date.now() - heardAt <= HEARD_WITHIN_MS;
}

/** Whether a request's `Authorization` header carries the plugin's token. Notes the time when it does. */
export function pluginAuthorized(header: string | null): boolean {
	const token = config().navidromePluginToken;
	if (token === null || !header?.startsWith('Bearer ')) return false;
	if (!constantTimeEquals(pluginDigest(header.slice(7)), pluginDigest(token))) return false;
	heardAt = Date.now();
	return true;
}

export interface PluginPlay {
	username: string;
	songId: string;
	/** Epoch millis. */
	at: number;
}

/**
 * A time the plugin sent, in Unix seconds, as epoch millis. Null for anything
 * that is not a whole number of seconds after 1970 and no later than now.
 */
export function playTime(value: unknown, now = Date.now()): number | null {
	if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) return null;
	const at = value * 1000;
	if (at > now + CLOCK_SLACK_MS) return null;
	return Math.min(at, now);
}

/**
 * Records plays Navidrome reports as they happen. Returns how many went into
 * a history.
 *
 * A play is dropped, without an error, when no account signs in under its
 * user name, the account has plays from other apps turned off, the history
 * holds it already (a play made here comes back from Navidrome as its
 * scrobble), the stored credential no longer signs in, or the account cannot
 * read the song. A rejected credential does not sign the account out from
 * here, as with a shared link's owner: its next request finds the same.
 *
 * Throws the `UpstreamError` of a music server that did not answer, so the
 * plugin is told to send the plays again.
 */
export async function takePlays(plays: PluginPlay[]): Promise<number> {
	let recorded = 0;
	for (const play of plays) {
		const found = await accountOfUser('subsonic', play.username);
		if (!found) continue;
		const { account, credential } = found;
		const settings = await getSettings(account.id);
		if (!settings.historyOtherApps) continue;
		// Before the lookup: most of what arrives is a play made here, and this
		// costs no call to the music server.
		if (await hasScrobble(account.id, play.songId, play.at)) continue;

		let song: Song | null;
		try {
			song = (await backendFor('subsonic').getSongs(credential, [play.songId]))[0] ?? null;
		} catch (err) {
			if (err instanceof UpstreamError && (err.kind === 'auth' || err.kind === 'not_found')) {
				log.debug('plugin-play-dropped', { account: account.id, why: err.kind });
				continue;
			}
			throw err;
		}
		if (!song) {
			log.debug('plugin-play-dropped', { account: account.id, why: 'not_found' });
			continue;
		}
		if (await recordScrobble(account.id, song, play.at, settings.historyDays)) recorded++;
	}
	return recorded;
}

/* ── What another app is playing now ──────────────────────────────────────── */

export const PLAYBACK_STATES = ['starting', 'playing', 'paused', 'stopped', 'expired'] as const;

export interface PluginPlayback {
	username: string;
	songId: string;
	state: (typeof PLAYBACK_STATES)[number];
	/** Seconds into the track. */
	position: number;
	/** Navidrome's id for the client. */
	player: string;
	/** What the client calls itself. */
	playerName: string | null;
}

/**
 * How long a track looked up for a playback report is held. An app that says
 * where it is does so every few seconds, each time for the same track.
 */
const TRACK_HELD_MS = 10 * 60 * 1000;
/** A track the account could not read is asked for again after this. */
const TRACK_MISSED_MS = 60 * 1000;
const MAX_TRACKS_HELD = 500;

/** By account and song. Null for a track the account's credential did not read. */
const tracks = new Map<string, { song: Song | null; until: number }>();

async function trackFor(account: Account, credential: StoredCredential, songId: string): Promise<Song | null> {
	const key = `${account.id}\0${songId}`;
	const now = Date.now();
	const held = tracks.get(key);
	if (held && held.until > now) return held.song;
	let song: Song | null;
	try {
		song = (await backendFor('subsonic').getSongs(credential, [songId]))[0] ?? null;
	} catch (err) {
		// A music server that did not answer is asked again at the next report.
		if (!(err instanceof UpstreamError) || (err.kind !== 'auth' && err.kind !== 'not_found')) return null;
		song = null;
	}
	tracks.delete(key);
	// The oldest goes first: a Map keeps the order its keys were set in.
	if (tracks.size >= MAX_TRACKS_HELD) tracks.delete(tracks.keys().next().value!);
	tracks.set(key, { song, until: now + (song ? TRACK_HELD_MS : TRACK_MISSED_MS) });
	return song;
}

/**
 * Takes Navidrome's report of what an app is playing, pausing or has stopped.
 *
 * Navidrome reports every client of the user, this server among them, which
 * is left out by its client name: its browsers report for themselves. The
 * rest is held for the account's own browsers to show and pick up from
 * (`remote.ts`), and for the other accounts only where the account has
 * turned on "Include what I play in other apps".
 *
 * Dropped as a play is: a user with no account here, a credential that no
 * longer signs in, a song the account cannot read.
 */
export async function takePlayback(report: PluginPlayback): Promise<void> {
	const cfg = config();
	if (!cfg.remoteControl) return;
	if (report.playerName?.toLowerCase() === CLIENT_NAME) return;
	const found = await accountOfUser('subsonic', report.username);
	if (!found) return;
	const { account, credential } = found;

	const ended = report.state === 'stopped' || report.state === 'expired';
	const song = ended ? null : await trackFor(account, credential, report.songId);
	if (!song) {
		reportApp(account.id, report.player, null);
		return appChanged(account);
	}
	const settings = await getSettings(account.id);
	reportApp(account.id, report.player, {
		// Navidrome's id stays here. The browsers tell two apps apart by this.
		id: createHash('sha256').update(report.player).digest('hex').slice(0, 16),
		name: cleanName(report.playerName) ?? null,
		state: {
			songId: song.id,
			title: song.title,
			artist: song.artist,
			coverArt: song.coverArt,
			album: song.album,
			albumId: song.albumId,
			position: song.duration > 0 ? Math.min(report.position, song.duration) : report.position,
			duration: song.duration,
			playing: report.state !== 'paused',
			volume: 1
		},
		// A client that only says a track started sends `playing` at 0 and
		// nothing after it. Any other report is from one that says where it is.
		exact: report.state !== 'playing' || report.position > 0,
		shared: cfg.listeners && settings.listeningOtherApps
	});
	await appChanged(account);
}

/* ── Importing the scrobble history ───────────────────────────────────────── */

/** What an import came to: its counts, or `failed` when Navidrome did not send the history. */
export type ImportOutcome = ImportResult | 'failed';

interface ImportJob {
	account: Account;
	scrobbles: ScrobbleImport;
	/** Unix seconds the next page is wanted from. */
	from: number;
	/** The plays of the last page that fell in that second, which the next page holds again. */
	edge: Set<string>;
	settled: Promise<ImportOutcome>;
	settle(outcome: ImportOutcome): void;
	idle: ReturnType<typeof setTimeout> | null;
}

/**
 * Imports open at once. Each holds every played song of its account until it
 * ends: about 20MB for 50,000 songs.
 */
const MAX_IMPORTS = 4;
/** How long an import waits for its next page before it is given up. The plugin polls every 15 seconds. */
const IMPORT_IDLE_MS = 2 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** By account id. */
const imports = new Map<string, ImportJob>();

async function finish(job: ImportJob, outcome: ImportOutcome): Promise<void> {
	if (imports.get(job.account.id) !== job) return;
	imports.delete(job.account.id);
	if (job.idle) clearTimeout(job.idle);
	await job.scrobbles.end().catch(() => undefined);
	if (outcome === 'failed') log.warn('history-import-failed', { detail: 'the Navidrome plugin did not send the history' });
	else log.info('history-imported', { found: outcome.found, imported: outcome.imported, from: 'scrobbles' });
	job.settle(outcome);
}

/** Starts the wait for the next page again. */
function touch(job: ImportJob): void {
	if (job.idle) clearTimeout(job.idle);
	job.idle = setTimeout(() => void finish(job, 'failed'), IMPORT_IDLE_MS);
	// Not a reason to keep the process from exiting.
	job.idle.unref();
}

/**
 * Asks the plugin for the account's whole scrobble history, at its next poll.
 *
 * `read` is `getPlayedSongs` under the account's credential, called once here,
 * in the request that asked. Resolves when the last page has arrived. `busy`
 * when `MAX_IMPORTS` are open, and null while the account has an import of
 * either kind running.
 */
export async function requestImport(
	account: Account,
	read: () => Promise<{ song: Song; playedAt: number }[]>,
	keepDays: number,
	now = Date.now()
): Promise<Promise<ImportOutcome> | 'busy' | null> {
	if (imports.size >= MAX_IMPORTS) return 'busy';
	const scrobbles = await openScrobbleImport(account.id, read, keepDays, now);
	if (!scrobbles) return null;
	// Counted again: `read` took a while, and others may have opened meanwhile.
	if (imports.size >= MAX_IMPORTS) {
		await scrobbles.end();
		return 'busy';
	}
	let settle!: (outcome: ImportOutcome) => void;
	const settled = new Promise<ImportOutcome>((resolve) => (settle = resolve));
	const job: ImportJob = {
		account,
		scrobbles,
		from: keepDays === 0 ? 0 : Math.floor((now - keepDays * DAY_MS) / 1000),
		edge: new Set(),
		settled,
		settle,
		idle: null
	};
	imports.set(account.id, job);
	touch(job);
	return settled;
}

/** The accounts whose history the plugin is to send, and from when: what every answer to it carries. */
export function wanted(): { username: string; from: number }[] {
	return [...imports.values()].map((job) => ({ username: job.account.username, from: job.from }));
}

/**
 * Takes a page of an account's scrobble history, oldest first. Ignored for a
 * user without an import open. `more` says another page follows, and `failed`
 * that Navidrome would not let the plugin read this user's history.
 */
export async function takeHistory(page: {
	username: string;
	plays: { songId: string; at: number }[];
	more: boolean;
	failed: boolean;
}): Promise<void> {
	const name = foldName(page.username);
	const job = [...imports.values()].find((held) => foldName(held.account.username) === name);
	if (!job) return;
	if (page.failed) return finish(job, 'failed');
	touch(job);
	// The next page starts at the last second of this one, so the plays of that
	// second come twice. They are left out here, which keeps them out of the
	// count of what Navidrome holds.
	const edgeKey = (play: { songId: string; at: number }) => `${play.at}/${play.songId}`;
	const fresh = page.plays.filter((play) => !job.edge.has(edgeKey(play)));
	await job.scrobbles.add(fresh.map((play) => ({ songId: play.songId, playedAt: play.at })));
	if (!page.more) return finish(job, { ...job.scrobbles.result });

	const last = page.plays.reduce((latest, play) => Math.max(latest, Math.floor(play.at / 1000)), 0);
	if (last > job.from) {
		job.from = last;
		job.edge = new Set(page.plays.filter((play) => Math.floor(play.at / 1000) === last).map(edgeKey));
	} else {
		// A page that does not move the time on would be asked for forever.
		job.from += 1;
		job.edge = new Set();
	}
}
