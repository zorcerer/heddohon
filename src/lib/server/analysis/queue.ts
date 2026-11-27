/**
 * The sound analysis job (issue #318, part of #312): walks the library and
 * measures each song once, at the pace an administrator sets, out of the way
 * of anyone listening.
 *
 * Everything it touches is given to it (`JobDeps`): where the songs come
 * from, where results go, how a song is decoded and measured, the settings,
 * the clock. `job.ts` gives it the app's; `tests/e2e/analysis-job.test.mjs`
 * gives it stand-ins and a clock of its own, and runs it without the app.
 *
 * One song at a time, whichever music servers it reads: two at once would
 * take two cores where the pace promises at most one. Each step checks the
 * settings first, so turning it off, pausing it or a listener arriving stops
 * it within the song under way.
 *
 * An album an administrator asks for (`queueAlbum`, issue #330) goes ahead
 * of the library: its songs are measured again though they have a current
 * result, while the job is paused or outside its hours, and still not while
 * someone listens.
 */
import { ANALYSIS_RATE, DecodeError } from './decode.ts';
import type { SongFeatures } from './features.ts';
import type { AnalysisSong, AnalysisSource } from './source.ts';
import type { SongRef } from './store.ts';

/**
 * - `full`: one song after another.
 * - `gentle`: after each song, a rest as long as the song took, so half of one
 *   core at most. The default.
 * - `background`: one song every 3 minutes.
 */
export type Pace = 'full' | 'gentle' | 'background';
export const PACES: readonly Pace[] = ['full', 'gentle', 'background'];

export interface JobSettings {
	paused: boolean;
	pace: Pace;
	/** While someone listens: `pause` (the default) or `continue`. */
	whileListening: 'pause' | 'continue';
	/** Only between these minutes of the day, server time, `from` to `to` (past midnight where `to` is before `from`); null for any time. */
	hours: { from: number; to: number } | null;
}

export const DEFAULT_SETTINGS: JobSettings = { paused: false, pace: 'gentle', whileListening: 'pause', hours: null };

/**
 * - `off`: the server does not analyse (`HEDDOHON_ANALYSIS`).
 * - `no-account`: no analysis account is named for any music server.
 * - `listing`: reading the library.
 * - `running`: measuring a song.
 * - `paused`: an administrator paused it.
 * - `throttled`: someone is listening, and it waits for 60s of quiet.
 * - `outside-hours`: it waits for its hours.
 * - `done`: every song is measured, or failed; it looks for new ones every 6h.
 * - `stopped`: it cannot go on (no ffmpeg, the library will not list), and
 *   tries again in 5 minutes.
 */
export type JobState = 'off' | 'no-account' | 'listing' | 'running' | 'paused' | 'throttled' | 'outside-hours' | 'done' | 'stopped';

export interface JobStatus {
	state: JobState;
	/** Songs in the libraries read, and of them measured or failed by the current analysis. */
	total: number;
	measured: number;
	failed: number;
	/** The song being measured. */
	current: { backend: string; title: string; artist: string | null } | null;
	/** Songs finished in the last hour. */
	lastHour: number;
	/** At that pace, how long the rest would take, in ms; null where nothing is left or there is no pace yet. */
	finishInMs: number | null;
	lastError: { title: string; message: string; at: number } | null;
	/** The album asked for that is being measured, and how far it is. */
	album: { title: string; done: number; total: number } | null;
}

/**
 * An album an administrator asked to have measured now. Its songs come from
 * that administrator's own request (`job.ts`); the analysis account reads
 * only their audio.
 */
export interface AlbumRequest {
	/** Who asked: one album waiting at a time each. */
	by: string;
	backend: string;
	title: string;
	songs: AnalysisSong[];
}

export interface JobDeps {
	/** Whether the server analyses at all. */
	enabled(): boolean;
	/** One source for each music server with an analysis account. */
	sources(): Promise<AnalysisSource[]>;
	store: {
		settled(song: SongRef): boolean;
		put(song: SongRef, features: SongFeatures): void;
		fail(song: SongRef, error: string): void;
		counts(backend: string): { measured: number; failed: number };
	};
	settings(): Promise<JobSettings>;
	decode(audio: ReadableStream<Uint8Array>, options: { duration: number; signal: AbortSignal; fromStart?: boolean }): Promise<Float32Array>;
	analyse(samples: Float32Array, rate: number): Promise<SongFeatures>;
	/** When audio last went to a listener, in ms, or 0 (`listening-activity.ts`). */
	lastListened(): number;
	now(): number;
	/** Resolves after `ms`, or at once when `signal` aborts. */
	sleep(ms: number, signal: AbortSignal): Promise<void>;
	log(event: string, fields: Record<string, string | number | boolean | null | undefined>): void;
	/** Minutes past midnight, server time, for `hours`. */
	minuteOfDay(): number;
}

/** How long to wait before looking again, when there is nothing to do. */
export const IDLE_MS = 60_000;
/** Quiet after the last stream before going on. */
export const QUIET_MS = 60_000;
/** Background pace: one song in this long. */
export const BACKGROUND_EVERY_MS = 180_000;
/** A finished library is listed again this often, for new songs. */
export const RELIST_MS = 6 * 60 * 60 * 1000;
/** After a stop, the next try. */
export const RETRY_MS = 5 * 60_000;

const HOUR_MS = 60 * 60 * 1000;

interface Library {
	source: AnalysisSource;
	songs: AnalysisSong[];
	/** Every song before this one is settled. */
	next: number;
	listedAt: number;
}

export function withinHours(hours: JobSettings['hours'], minute: number): boolean {
	if (!hours || hours.from === hours.to) return true;
	return hours.from < hours.to ? minute >= hours.from && minute < hours.to : minute >= hours.from || minute < hours.to;
}

export class AnalysisJob {
	readonly #deps: JobDeps;
	#state: JobState = 'off';
	#current: JobStatus['current'] = null;
	#lastError: JobStatus['lastError'] = null;
	/** When each of the songs finished in the last hour did. */
	#finished: number[] = [];
	#libraries = new Map<string, Library>();
	/** Albums asked for, first first; `next` is the song of it to measure. */
	#albums: (AlbumRequest & { next: number })[] = [];
	#stopper: AbortController | null = null;
	#running: Promise<void> | null = null;

	constructor(deps: JobDeps) {
		this.#deps = deps;
	}

	status(): JobStatus {
		const now = this.#deps.now();
		this.#finished = this.#finished.filter((at) => now - at < HOUR_MS);
		let total = 0;
		let measured = 0;
		let failed = 0;
		for (const library of this.#libraries.values()) {
			const counts = this.#deps.store.counts(library.source.backend);
			total += library.songs.length;
			measured += Math.min(counts.measured, library.songs.length);
			failed += Math.min(counts.failed, library.songs.length);
		}
		const left = Math.max(0, total - measured - failed);
		const lastHour = this.#finished.length;
		return {
			state: this.#state,
			total,
			measured,
			failed,
			current: this.#current,
			lastHour,
			finishInMs: left > 0 && lastHour > 0 ? Math.round((left / lastHour) * HOUR_MS) : null,
			lastError: this.#lastError,
			album: this.#albums[0] ? { title: this.#albums[0].title, done: this.#albums[0].next, total: this.#albums[0].songs.length } : null
		};
	}

	/**
	 * Puts an album ahead of the library. False where the same administrator
	 * already has one waiting, or the album has no songs.
	 */
	queueAlbum(request: AlbumRequest): boolean {
		if (request.songs.length === 0 || this.albumWaiting(request.by)) return false;
		this.#albums.push({ ...request, next: 0 });
		this.#deps.log('analysis-album-queued', { by: request.by, backend: request.backend, songs: request.songs.length });
		this.wake();
		return true;
	}

	/** Whether this administrator has an album waiting or under way. */
	albumWaiting(by: string): boolean {
		return this.#albums.some((album) => album.by === by);
	}

	/** Starts the loop, if it is not running. */
	start(): void {
		if (this.#running) return;
		const stopper = new AbortController();
		this.#stopper = stopper;
		this.#running = this.#loop(stopper.signal).finally(() => {
			this.#running = null;
		});
	}

	/** Stops the loop within the song under way, and waits for it. */
	async stop(): Promise<void> {
		this.#stopper?.abort();
		await this.#running;
	}

	/** Cuts the current wait short, as after a setting changes. */
	wake(): void {
		this.#wake?.abort();
	}

	/**
	 * Forgets where it is in each library and lists them again, as after the
	 * results were reset or the failures are to be retried: songs it had
	 * passed as settled may not be any more.
	 */
	forget(): void {
		this.#libraries.clear();
		this.wake();
	}
	#wake: AbortController | null = null;

	async #rest(ms: number, signal: AbortSignal): Promise<void> {
		const wake = new AbortController();
		this.#wake = wake;
		const either = AbortSignal.any([signal, wake.signal]);
		await this.#deps.sleep(ms, either);
		if (this.#wake === wake) this.#wake = null;
	}

	#set(state: JobState): void {
		if (state !== this.#state) this.#deps.log(`analysis-${state}`, { from: this.#state });
		this.#state = state;
	}

	async #loop(signal: AbortSignal): Promise<void> {
		while (!signal.aborted) {
			let wait: number;
			// Nothing a step meets may end the loop, or the server with it: a
			// rejection here is unhandled, and a deployment still being set up
			// threw from its first look at the configuration and stopped.
			try {
				wait = await this.#step(signal);
			} catch (err) {
				this.#current = null;
				this.#stop(err instanceof Error ? err.message : String(err));
				wait = RETRY_MS;
			}
			if (wait > 0) await this.#rest(wait, signal);
		}
		this.#current = null;
	}

	/** One decision and, where it is to work, one song. Returns how long to rest before the next. */
	async #step(signal: AbortSignal): Promise<number> {
		const deps = this.#deps;
		if (!deps.enabled()) {
			this.#set('off');
			return IDLE_MS;
		}
		const settings = await deps.settings();
		// An album asked for is asked for now: neither a pause nor the hours hold it.
		if (this.#albums.length === 0) {
			if (settings.paused) {
				this.#set('paused');
				return IDLE_MS;
			}
			if (!withinHours(settings.hours, deps.minuteOfDay())) {
				this.#set('outside-hours');
				return IDLE_MS;
			}
		}
		if (settings.whileListening === 'pause') {
			const quietFor = deps.now() - deps.lastListened();
			if (quietFor < QUIET_MS) {
				this.#set('throttled');
				return QUIET_MS - quietFor;
			}
		}

		const sources = await deps.sources();
		if (this.#albums.length > 0) return this.#measureAlbum(sources, settings, signal);
		if (sources.length === 0) {
			this.#set('no-account');
			return IDLE_MS;
		}

		const found = await this.#nextSong(sources, signal);
		if (found === 'stopped') return RETRY_MS;
		if (!found) {
			this.#set('done');
			return IDLE_MS;
		}
		return this.#measure(found.library, found.song, settings, signal);
	}

	/** The next song to measure, listing a library where it has not been, or not for `RELIST_MS`. */
	async #nextSong(sources: AnalysisSource[], signal: AbortSignal): Promise<{ library: Library; song: AnalysisSong } | null | 'stopped'> {
		const deps = this.#deps;
		const backends = new Set<string>(sources.map((source) => source.backend));
		for (const backend of this.#libraries.keys()) if (!backends.has(backend)) this.#libraries.delete(backend);
		for (const source of sources) {
			let library = this.#libraries.get(source.backend);
			const stale = library && library.next >= library.songs.length && deps.now() - library.listedAt >= RELIST_MS;
			if (!library || library.source !== source || stale) {
				this.#set('listing');
				try {
					const songs = await source.songs();
					library = { source, songs, next: 0, listedAt: deps.now() };
					this.#libraries.set(source.backend, library);
					deps.log('analysis-listed', { backend: source.backend, songs: songs.length });
				} catch (err) {
					this.#stop(`The library could not be listed: ${err instanceof Error ? err.message : String(err)}`);
					return 'stopped';
				}
			}
			while (library.next < library.songs.length && !signal.aborted) {
				const song = library.songs[library.next];
				if (!deps.store.settled({ backend: source.backend, songId: song.id, fileKey: song.fileKey })) return { library, song };
				library.next++;
			}
		}
		return null;
	}

	/** The next song of the first album asked for, measured whatever is stored for it. */
	async #measureAlbum(sources: AnalysisSource[], settings: JobSettings, signal: AbortSignal): Promise<number> {
		const album = this.#albums[0];
		const source = sources.find((each) => each.backend === album.backend);
		if (!source) {
			// The account was removed, or the feature switched off and on, since it was asked for.
			this.#albums.shift();
			this.#deps.log('analysis-album-dropped', { by: album.by, backend: album.backend, detail: 'no analysis account' });
			return 0;
		}
		const { rest, done } = await this.#measureSong(source, album.songs[album.next], settings, signal);
		if (done) album.next++;
		if (album.next >= album.songs.length) {
			this.#albums.shift();
			this.#deps.log('analysis-album-done', { by: album.by, backend: album.backend, songs: album.songs.length });
		}
		return rest;
	}

	async #measure(library: Library, song: AnalysisSong, settings: JobSettings, signal: AbortSignal): Promise<number> {
		const { rest, done } = await this.#measureSong(library.source, song, settings, signal);
		if (done) library.next++;
		return rest;
	}

	/**
	 * Measures one song and keeps the result or the failure. `rest` is how
	 * long to wait after it; `done` is false where the song is to be tried
	 * again: the job was stopped, or it has no ffmpeg.
	 */
	async #measureSong(source: AnalysisSource, song: AnalysisSong, settings: JobSettings, signal: AbortSignal): Promise<{ rest: number; done: boolean }> {
		const deps = this.#deps;
		const ref = { backend: source.backend, songId: song.id, fileKey: song.fileKey };
		this.#set('running');
		this.#current = { backend: ref.backend, title: song.title, artist: song.artist };
		const started = deps.now();
		try {
			let samples: Float32Array;
			try {
				samples = await deps.decode(await source.audio(song.id, signal), { duration: song.duration, signal });
			} catch (err) {
				// The excerpt starts 30s in by the length the music server reports. A
				// file shorter than that decodes to nothing there: read it once more
				// from its start.
				if (!(err instanceof DecodeError && err.kind === 'empty')) throw err;
				samples = await deps.decode(await source.audio(song.id, signal), { duration: song.duration, signal, fromStart: true });
			}
			const features = await deps.analyse(samples, ANALYSIS_RATE);
			if (signal.aborted) return { rest: 0, done: false };
			deps.store.put(ref, features);
		} catch (err) {
			if (signal.aborted) return { rest: 0, done: false };
			// No ffmpeg is not the song's fault: every song would fail the same way.
			if (err instanceof DecodeError && err.kind === 'missing') {
				this.#stop(err.message);
				return { rest: RETRY_MS, done: false };
			}
			const message = err instanceof Error ? err.message : String(err);
			deps.store.fail(ref, message);
			this.#lastError = { title: song.title, message, at: deps.now() };
			deps.log('analysis-song-failed', { backend: ref.backend, song: song.id, detail: message });
		} finally {
			this.#current = null;
		}
		const took = deps.now() - started;
		this.#finished.push(deps.now());
		if (settings.pace === 'full') return { rest: 0, done: true };
		if (settings.pace === 'background') return { rest: Math.max(0, BACKGROUND_EVERY_MS - took), done: true };
		return { rest: took, done: true };
	}

	#stop(message: string): void {
		this.#lastError = { title: '', message, at: this.#deps.now() };
		this.#set('stopped');
		this.#deps.log('analysis-stopped', { detail: message });
	}
}
