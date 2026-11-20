/**
 * The sound analysis job as the server runs it: `queue.ts` given the app's
 * parts. Started with the server (`init` in `hooks.server.ts`) and stopped on
 * shutdown. With the feature off it rests a minute at a time and does
 * nothing else: no thread, no file, no request to the music server.
 *
 * The administrator's settings for it (paused, pace, while someone listens,
 * hours) are a row in the main database's `meta`, so they survive a restart
 * and are in the backup. Its results are in `analysis.db` (`store.ts`).
 */
import { config } from '../config';
import { store as mainStore } from '../db';
import { lastListened } from '../listening-activity';
import { log } from '../log';
import { openSource } from './account.ts';
import { analyseInWorker, stopAnalyser } from './analyser.ts';
import { decodeExcerpt } from './decode.ts';
import { AnalysisJob, DEFAULT_SETTINGS, PACES, type JobSettings, type JobStatus } from './queue.ts';
import { analysisSongOf, type AnalysisSource } from './source.ts';
import type { AlbumDetail, BackendKind } from '#lib/types.ts';
import { analysisStore, closeAnalysisStore, forgetSoundIndexes } from './results.ts';

const SETTINGS_KEY = 'analysis-settings';

let job: AnalysisJob | null = null;

export { analysisStore };

/** The settings as saved, each field checked, with the defaults for anything missing or wrong. */
export async function jobSettings(): Promise<JobSettings> {
	const row = await (await mainStore()).get<{ value: string }>('SELECT value FROM meta WHERE key = ?', SETTINGS_KEY);
	let saved: Partial<JobSettings> = {};
	try {
		saved = row ? (JSON.parse(row.value) as Partial<JobSettings>) : {};
	} catch {
		// A row that does not parse is as no row.
	}
	const minute = (value: unknown) => (Number.isInteger(value) && (value as number) >= 0 && (value as number) < 1440 ? (value as number) : null);
	const from = minute(saved.hours?.from);
	const to = minute(saved.hours?.to);
	return {
		paused: saved.paused === true,
		pace: PACES.includes(saved.pace as JobSettings['pace']) ? (saved.pace as JobSettings['pace']) : DEFAULT_SETTINGS.pace,
		whileListening: saved.whileListening === 'continue' ? 'continue' : 'pause',
		hours: from !== null && to !== null ? { from, to } : null
	};
}

/** Saves a change to the settings, and has the job act on it now rather than after its rest. */
export async function saveJobSettings(change: Partial<JobSettings>, by: string): Promise<JobSettings> {
	const next = { ...(await jobSettings()), ...change };
	await (await mainStore()).run(
		'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
		SETTINGS_KEY,
		JSON.stringify(next)
	);
	log.info('analysis-settings-saved', { by, ...next, hours: next.hours ? `${next.hours.from}-${next.hours.to}` : 'any' });
	job?.wake();
	return jobSettings();
}

async function sources(): Promise<AnalysisSource[]> {
	const found: AnalysisSource[] = [];
	for (const upstream of config().upstreams) {
		const source = await openSource(upstream.kind);
		if (source) found.push(source);
	}
	return found;
}

/** Starts the job, once per process. */
export function startAnalysisJob(): void {
	if (job) return;
	job = new AnalysisJob({
		// A deployment still being set up has no configuration yet, and so does not analyse.
		enabled: () => {
			try {
				return config().analysis;
			} catch {
				return false;
			}
		},
		sources,
		store: {
			settled: (song) => analysisStore().settled(song),
			put: (song, features) => analysisStore().put(song, features),
			fail: (song, error) => analysisStore().fail(song, error),
			counts: (backend) => analysisStore().counts(backend)
		},
		settings: jobSettings,
		// The image's ffmpeg is on the path (`Dockerfile`); elsewhere, whichever one is.
		decode: (audio, { duration, signal, fromStart }) => decodeExcerpt(audio, { duration, signal, fromStart }),
		analyse: analyseInWorker,
		lastListened,
		now: () => Date.now(),
		sleep: (ms, signal) =>
			new Promise((resolve) => {
				if (signal.aborted) return resolve();
				const timer = setTimeout(done, ms);
				// A rest is not a reason to keep the process alive.
				timer.unref();
				function done() {
					clearTimeout(timer);
					signal.removeEventListener('abort', done);
					resolve();
				}
				signal.addEventListener('abort', done, { once: true });
			}),
		// A stop is the one line written at the default level (`error`): the job
		// cannot go on, and on 2026-11-14 an empty log was all an administrator
		// had to tell a running job from one that never started.
		log: (event, fields) => (event === 'analysis-stopped' ? log.error(event, fields) : log.info(event, fields)),
		minuteOfDay: () => {
			const now = new Date();
			return now.getHours() * 60 + now.getMinutes();
		}
	});
	job.start();
}

/** Stops the job and its worker, and closes `analysis.db`. */
export async function stopAnalysisJob(): Promise<void> {
	await job?.stop();
	job = null;
	await stopAnalyser();
	closeAnalysisStore();
}

/**
 * Has the job look again now rather than after its rest: after the feature is
 * switched on, or an analysis account is named or removed.
 */
export function wakeAnalysisJob(): void {
	job?.forget();
}

/** What the job is doing, or null where it was never started. */
export function analysisStatus(): JobStatus | null {
	return job?.status() ?? null;
}

/** Whether the job has stopped on an error, for the dot on the links to Settings. */
export function analysisStopped(): boolean {
	return job?.status().state === 'stopped';
}

/**
 * How much of an album, as an administrator's own login lists it, has a
 * current result, and whether that administrator has an album waiting.
 */
export function albumAnalysis(backend: BackendKind, album: AlbumDetail, by: string): { measured: number; total: number; waiting: boolean } {
	const songs = album.songs.filter((song) => !song.live);
	const measured = songs.filter((song) => analysisStore().get({ backend, songId: song.id, fileKey: analysisSongOf(song).fileKey }) !== null).length;
	return { measured, total: songs.length, waiting: job?.albumWaiting(by) ?? false };
}

/**
 * Puts an album ahead of the library (issue #330), its songs as the asking
 * administrator's login lists them. `waiting` where that administrator
 * already has one, `empty` where it has no song to measure.
 */
export function analyseAlbum(backend: BackendKind, album: AlbumDetail, by: string): 'queued' | 'waiting' | 'empty' {
	const songs = album.songs.filter((song) => !song.live).map(analysisSongOf);
	if (songs.length === 0) return 'empty';
	if (!job) return 'waiting';
	return job.queueAlbum({ by, backend, title: album.name, songs }) ? 'queued' : 'waiting';
}

/** Removes `analysis.db` and starts the library again. */
export function resetAnalysis(by: string): void {
	analysisStore().reset();
	forgetSoundIndexes();
	log.warn('analysis-reset', { by });
	job?.forget();
}

/** Has the job try the songs that failed again. */
export function retryFailedAnalysis(by: string): number {
	let count = 0;
	for (const upstream of config().upstreams) count += analysisStore().retryFailed(upstream.kind);
	log.info('analysis-retry', { by, songs: count });
	job?.forget();
	return count;
}
