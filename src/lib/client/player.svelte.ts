/**
 * The playback engine.
 *
 *  - Playback runs through a plain HTMLAudioElement, not a Web Audio graph. An
 *    AudioContext resamples everything to its own rate, which would convert a
 *    24/192 master to whatever the context was opened at. The element passes
 *    the stream to the platform mixer at its native rate.
 *  - Nothing is transcoded by default: the server proxies the original bytes.
 *  - Two elements alternate, so the next track is buffered while the current
 *    one plays. HTMLAudioElement cannot do sample-accurate gapless, so this is
 *    a tight handoff (see the README).
 *  - The exception is audio processing, off unless a browser switches it on
 *    (`processing.svelte.ts`): the equaliser routes both elements through a
 *    graph at the output device's rate (`audiochain.ts`).
 */
import { browser } from '$app/environment';
import { untrack } from 'svelte';
import type { Song } from '$lib/types';
import type { Correction } from '$lib/autoeq';
import type { UserSettings } from '$lib/server/settings';
import { AudioChain } from './audiochain';
import { coverUrl, streamUrl } from './format';
import { radioStreamUrl } from './radio';

type RepeatMode = 'off' | 'all' | 'one';

/**
 * A single silent sample, played and paused on the first user gesture so the
 * second audio element has its own activation: Safari and Firefox grant
 * autoplay per element, not per document.
 *
 * A file, not a `data:` URL. The Content-Security-Policy's `media-src 'self'`
 * refuses `data:`, so the sample never loaded, the second element stayed
 * locked, and a phone could stop at the first track boundary in the
 * background.
 */
const SILENCE = '/silence.wav';
/** A play counts as a scrobble past this fraction, as in Subsonic clients. */
const SCROBBLE_FRACTION = 0.5;
const SCROBBLE_MIN_SECONDS = 30;
/**
 * How many times a dropped stream is picked back up before the listener is
 * told, and the wait between tries.
 *
 * A stream can stop arriving while the file is fine: a reverse proxy's read
 * timeout, a cap on how long one response may take, a connection pool emptied
 * by a page of covers, a phone changing network. The rest is asked for from
 * the position reached.
 */
const RECOVERY_ATTEMPTS = 4;
const RECOVERY_BACKOFF_MS = 600;
/** How often, and how many times, a seek asks whether the server has the transcode whole yet. */
const SEEK_HOLD_MS = 1000;
const SEEK_HOLD_ATTEMPTS = 30;

/**
 * Largest body sent with `keepalive`, in bytes: half the 64KB the browser
 * allows across all in-flight keepalive requests, so a play-state write and a
 * playback report fit together.
 */
const KEEPALIVE_LIMIT = 32_000;

/** Cast addresses are asked for again after this, an hour before they stop working. */
const CAST_REFRESH_MS = 5 * 60 * 60 * 1000;

/** Safari's AirPlay members of a media element, which the DOM types leave out. */
type AirPlayElement = HTMLMediaElement & {
	webkitShowPlaybackTargetPicker?: () => void;
	webkitCurrentPlaybackTargetIsWireless?: boolean;
};
/**
 * The sleep timer's lengths in minutes, and how long the level takes to come
 * down before the pause. The fade is stepped from `timeupdate`, about four
 * times a second in Chromium, so 12 seconds is about 48 steps.
 */
export const SLEEP_MINUTES = [15, 30, 45, 60, 90] as const;
const SLEEP_FADE_SECONDS = 12;

/**
 * How long the output takes to reach silence before a pause, a skip or a seek
 * through the graph, and to come back. Pausing or moving an element cuts its
 * waveform mid-cycle, which is heard as a click.
 */
const DUCK_MS = 150;

/**
 * A sleep timer: pause at a time on the clock, or when the current track ends.
 * Transient, like `queueOpen`: a reload drops it.
 */
type SleepTimer = { kind: 'at'; at: number; minutes: number } | { kind: 'track' };

/**
 * Whether `next` comes straight after `current` on the same album: the next
 * track on the same disc, or the first track of the next disc. A file without
 * a disc number is on disc 1.
 */
function followsOnAlbum(current: Song, next: Song): boolean {
	if (!current.albumId || current.albumId !== next.albumId || current.track === null || next.track === null) return false;
	const disc = current.disc ?? 1;
	const nextDisc = next.disc ?? 1;
	return (nextDisc === disc && next.track === current.track + 1) || (nextDisc === disc + 1 && next.track === 1);
}

/** Fisher-Yates, in place on a copy. */
function shuffled<T>(items: T[]): T[] {
	const out = [...items];
	for (let i = out.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[out[i], out[j]] = [out[j], out[i]];
	}
	return out;
}

/**
 * `queue` put back in `order`, the ids it had before it was shuffled, with
 * `current` where it lands. Matched by id one for one, so a track queued twice
 * comes back twice. An entry removed since is left out. Entries added since go
 * straight after the current track, in their order. Where the current track is
 * itself one of them, the added entries lead the queue.
 */
function unshuffled<T extends { id: string }>(queue: T[], order: string[], current: T | undefined): T[] {
	const waiting = new Map<string, T[]>();
	for (const entry of queue) {
		const list = waiting.get(entry.id);
		if (list) list.push(entry);
		else waiting.set(entry.id, [entry]);
	}
	const originals: T[] = [];
	for (const id of order) {
		const entry = waiting.get(id)?.shift();
		if (entry) originals.push(entry);
	}
	const kept = new Set(originals);
	const added = queue.filter((entry) => !kept.has(entry));
	if (current === undefined || !kept.has(current)) return [...added, ...originals];
	const at = originals.indexOf(current) + 1;
	return [...originals.slice(0, at), ...added, ...originals.slice(at)];
}

interface PersistPayload {
	songIds: string[];
	index: number;
	position: number;
	repeat: RepeatMode;
	shuffle: boolean;
	/** The ids in the order they had before shuffling, while shuffle is on. */
	orderIds?: string[];
}

class Player {
	/** The queue in play order. Shuffling rewrites it. */
	queue = $state<Song[]>([]);
	index = $state(0);
	playing = $state(false);
	/** True between a play() call and the first frame of audio. */
	loading = $state(false);
	/**
	 * Whether the listener means playback to be running: set by play(), cleared
	 * by pause(), stop(), the end of the queue and the sleep timer. A blocked
	 * play() is retried while it holds.
	 *
	 * Unlike `playing`, it holds across a track change. The outgoing element
	 * fires `pause` about 17ms before the incoming one fires `play` (Chromium),
	 * and the room's colour, following `playing`, went to the open page's cover
	 * and back within one fade: a flash on the rail and the player.
	 */
	engaged = $state(false);

	/**
	 * Whether a newer saved queue may replace the one held here: nothing plays
	 * or loads, and nothing waits to be written. The layout asks when the page
	 * comes back to the front.
	 */
	get idle(): boolean {
		return !this.engaged && !this.playing && !this.loading && !this.#unsaved && !this.casting;
	}

	/** Whether a change made here has yet to reach the server. */
	get #unsaved(): boolean {
		return this.#changes !== this.#written;
	}

	/** When the saved state this browser holds was written, on the server's clock. */
	get savedAt(): number {
		return this.#savedAt;
	}
	currentTime = $state(0);
	duration = $state(0);
	buffered = $state(0);
	volume = $state(0.85);
	muted = $state(false);
	repeat = $state<RepeatMode>('off');
	shuffle = $state(false);
	error = $state<string | null>(null);
	queueOpen = $state(false);
	/**
	 * Whether the player panel is showing. Transient layout state, like
	 * `queueOpen`, and not a stored setting.
	 */
	panelOpen = $state(true);
	/**
	 * Whether the client has reported how wide the screen is.
	 *
	 * Open by default suits a screen with room for a column. Where the panel is
	 * a sheet over the page it would cover the library on arrival, and closed
	 * by default would reflow the grid at hydration. So the server renders the
	 * column, and the narrow layout keeps the sheet hidden until this flips in
	 * `attach()`, before the first client render.
	 */
	viewportKnown = $state(false);
	/**
	 * Whether the panel is a sheet over the page (a phone, or a window under
	 * 60rem). False until `attach()` has read the width. The phone dock and the
	 * sheet's drag read it. CSS decides the rest.
	 */
	sheetLayout = $state(false);
	sleep = $state<SleepTimer | null>(null);
	/**
	 * Which way the queue last moved: 1 forward (next, the end of a track, a
	 * new queue), -1 back (previous). The now-playing text slides in from that
	 * side. The index alone cannot tell a step back from the last track to the
	 * first from a wrap forward.
	 */
	direction = $state<1 | -1>(1);

	settings = $state<UserSettings | null>(null);

	current = $derived<Song | null>(this.queue[this.index] ?? null);
	upNext = $derived<Song | null>(this.queue[this.index + 1] ?? null);
	hasQueue = $derived(this.queue.length > 0);
	progress = $derived(this.duration > 0 ? this.currentTime / this.duration : 0);

	/** The element currently producing sound. */
	#primary: HTMLAudioElement | null = null;
	/** The element pre-buffering the next track. */
	#secondary: HTMLAudioElement | null = null;
	#preloadedFor: string | null = null;
	#scrobbled = false;
	#startReported = false;
	#persistTimer: ReturnType<typeof setTimeout> | null = null;
	/**
	 * The changes this browser has made to the queue or the position, counted,
	 * how many of them the server has taken, and when the saved state held here
	 * was written (the server's clock).
	 *
	 * The writes made on the way out (a hidden tab, a closed one) went out
	 * whether or not anything had changed here. A browser that had sat idle
	 * with a queue from days before wrote it over the one another browser had
	 * played since, and the account reopened on the old track. Counted, so a
	 * write that fails leaves its change to the next one.
	 */
	#changes = 0;
	#written = 0;
	#savedAt = 0;
	#progressTimer: ReturnType<typeof setInterval> | null = null;
	#positionTimer: ReturnType<typeof setInterval> | null = null;
	#detachers: Array<() => void> = [];
	/** Listeners that outlive an element swap. */
	#lifecycleOff: Array<() => void> = [];
	/** True once the second element has been unlocked by a user gesture. */
	#primed = false;
	/** Seconds to seek to once the restored track's metadata arrives. */
	#pendingSeek: number | null = null;
	/**
	 * A restored queue that holds only its current track while the rest is
	 * looked up: the queue as restored, and the saved ids and index it stands
	 * for. Cleared by `completeRestore`, or by anything that replaces the queue.
	 */
	#partial: { queue: Song[]; ids: string[]; index: number } | null = null;
	/**
	 * While shuffle is on, the ids in their order before the shuffle, for
	 * turning it off (`unshuffled`). Saved with the queue.
	 */
	#unshuffledIds: string[] | null = null;
	/** Consecutive attempts to pick the current track back up after a drop. */
	#recoveries = 0;
	#recoveryTimer: ReturnType<typeof setTimeout> | null = null;
	/** Ramp timer while two tracks overlap, and when the ramp started. */
	#fadeTimer: ReturnType<typeof setInterval> | null = null;
	#fadeStartedAt = 0;
	#fadeSeconds = 0;
	/**
	 * The graph both elements play through while audio processing is on, and
	 * whether a crossfade is scheduled on it. Its ramps run on the audio thread,
	 * without a timer.
	 */
	#chain: AudioChain | null = null;
	#chainFading = false;
	/** Fades to silence in flight; see `#duck`. The output comes back when the last is lifted. */
	#ducks = 0;
	/** The latest press that changes the track, and the latest seek, while each waits for its fade. */
	#changeSerial = 0;
	#seekSerial = 0;
	/** The latest seek waiting for the server to have a transcode whole; see `#seekOnceWhole`. */
	#wholeSerial = 0;
	/** Whether this page plays through the graph. */
	processing = $state(false);
	/** The output last chosen, for a graph opened after the choice. */
	#outputId = '';

	/**
	 * Whether this browser applies a `volume` set from script.
	 *
	 * iOS does not: the level belongs to the hardware buttons, a write is
	 * ignored and a read gives 1 (Apple's Safari audio guide). A crossfade
	 * there started the incoming track at full level up to 12s before the
	 * outgoing one ended. Read from a spare element, so the playing ones are
	 * not touched.
	 */
	rampsVolume = $state(true);

	/**
	 * Whether the system offers a speaker or a TV to play on: a Chromecast
	 * through the Remote Playback API (Chrome on Android), or AirPlay through
	 * Safari. The cast button shows only while this holds.
	 */
	castAvailable = $state(false);
	/** Whether the audio is playing on one of those. */
	casting = $state(false);
	/**
	 * Cast addresses by track id while casting (`server/cast.ts`), and when
	 * they were issued. The receiver fetches the stream itself, without this
	 * browser's cookie.
	 */
	#castUrls: Map<string, string> | null = null;
	#castUrlsAt = 0;

	/** The track after this one, wrapping to the first under repeat-all. */
	get #following(): Song | null {
		return this.upNext ?? (this.repeat === 'all' ? this.queue[0] : null);
	}

	/** Called once from the root layout after the audio elements are mounted. */
	attach(primary: HTMLAudioElement, secondary: HTMLAudioElement, settings: UserSettings) {
		this.#primary = primary;
		this.#secondary = secondary;
		const probe = document.createElement('audio');
		probe.volume = 0.5;
		this.rampsVolume = probe.volume === 0.5;
		this.settings = settings;
		this.volume = settings.volume;
		this.#bind(primary);
		this.#applyVolume();
		this.#startProgressReporting();
		this.#watchVisibility();
		this.#adoptViewport();
		this.#watchCast(primary, secondary);
	}

	// ── Casting ────────────────────────────────────────────────────────────

	/**
	 * Opens the system's picker for a speaker or a TV. Called from the press,
	 * which both pickers need.
	 *
	 * Chrome sends the receiver the element's address when a device is picked,
	 * so the track is moved to its cast address first. Safari opens its picker
	 * only inside the press, so there the address changes once the element
	 * reports a wireless target.
	 */
	async cast(): Promise<void> {
		const element = this.#primary;
		if (!element || !this.current) return;
		const airplay = element as AirPlayElement;
		if (typeof airplay.webkitShowPlaybackTargetPicker === 'function') {
			airplay.webkitShowPlaybackTargetPicker();
			return;
		}
		if (!element.remote) return;
		if (!(await this.#beginCast())) return;
		try {
			await element.remote.prompt();
		} catch {
			// Closed without a choice, or refused: the queue goes back to this
			// browser's own addresses.
			if (element.remote.state === 'disconnected') this.#endCast();
		}
	}

	#watchCast(...elements: HTMLAudioElement[]) {
		for (const element of elements) {
			const remote = element.remote;
			if (remote) {
				const connect = () => (this.casting = true);
				const disconnect = () => this.#endCast();
				remote.addEventListener('connect', connect);
				remote.addEventListener('disconnect', disconnect);
				this.#lifecycleOff.push(() => {
					remote.removeEventListener('connect', connect);
					remote.removeEventListener('disconnect', disconnect);
				});
			}
			// Safari's own events, which it fires in place of the ones above.
			const availability = (event: Event) =>
				(this.castAvailable = (event as Event & { availability?: string }).availability === 'available');
			const wireless = () => {
				if ((element as AirPlayElement).webkitCurrentPlaybackTargetIsWireless) {
					this.casting = true;
					void this.#beginCast();
				} else this.#endCast();
			};
			element.addEventListener('webkitplaybacktargetavailabilitychanged', availability);
			element.addEventListener('webkitcurrentplaybacktargetiswirelesschanged', wireless);
			this.#lifecycleOff.push(() => {
				element.removeEventListener('webkitplaybacktargetavailabilitychanged', availability);
				element.removeEventListener('webkitcurrentplaybacktargetiswirelesschanged', wireless);
			});
		}

		// Whether there is anything to pick. Chrome on the desktop has the API and
		// refuses to watch, which leaves the button hidden.
		const remote = elements[0]?.remote;
		if (!remote) return;
		let watch: number | null = null;
		remote
			.watchAvailability((available) => (this.castAvailable = available))
			.then((id) => (watch = id))
			.catch(() => (this.castAvailable = false));
		this.#lifecycleOff.push(() => {
			if (watch !== null) void remote.cancelWatchAvailability(watch).catch(() => undefined);
		});
	}

	/**
	 * Moves playback to cast addresses: the current track re-opened where it had
	 * got to, and nothing buffered ahead. The receiver follows the element it
	 * was picked from, so one element plays every track while casting, without
	 * the preloaded handoff or the crossfade.
	 */
	async #beginCast(): Promise<boolean> {
		if (this.#castUrls) return true;
		this.#castUrls = new Map();
		this.#castUrlsAt = Date.now();
		if (!(await this.#ensureCastUrls())) {
			this.#castUrls = null;
			return false;
		}
		this.#invalidatePreload();
		await this.#reopenCurrent();
		return true;
	}

	#endCast() {
		this.casting = false;
		this.#castUrls = null;
	}

	/**
	 * Cast addresses for the queue from the current track on, those not held
	 * already. Asked again after 5 hours, before the 6 they last.
	 */
	async #ensureCastUrls(): Promise<boolean> {
		if (!this.#castUrls) return false;
		if (Date.now() - this.#castUrlsAt > CAST_REFRESH_MS) {
			this.#castUrls.clear();
			this.#castUrlsAt = Date.now();
		}
		const held = this.#castUrls;
		const ids = [...new Set(this.queue.slice(this.index, this.index + 1000).filter((song) => !song.live).map((song) => song.id))].filter(
			(id) => !held.has(id)
		);
		if (ids.length === 0) return true;
		const response = await fetch('/api/cast', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ ids })
		}).catch(() => null);
		const urls = (await response?.json().catch(() => null))?.urls as Record<string, string> | undefined;
		if (!response?.ok || !urls) return false;
		for (const [id, url] of Object.entries(urls)) held.set(id, url);
		return true;
	}

	/**
	 * Where the element fetches a track from: its cast address while casting.
	 *
	 * `whole` is for a track opened at a position (a restored queue, a dropped
	 * stream, transcoding switched on mid-track). Until the server has read a
	 * transcode whole (`transcodes.ts`) it arrives as a stream without ranges,
	 * where a position cannot be taken up. On 2026-10-04 against Navidrome
	 * 0.64.2, resuming at 1:00 in such a stream: Chromium waited for the bytes
	 * and played from 1:00. Firefox gave an MP3 the duration of what had arrived
	 * (1.5s) and played from 0:00. WebKit reported Opus and AAC seekable to
	 * Infinity, took the seek and played from 0:00.
	 *
	 * So the address says the track is wanted whole, and the server answers
	 * once its read is done, in ranges (`proxyTranscode`). The mark applies to a
	 * transcode only: the music server answers the original file in ranges
	 * from the first request.
	 */
	#srcOf(song: Song, whole = false): string {
		if (song.live) return radioStreamUrl(song.id);
		const src = this.#castUrls?.get(song.id) ?? streamUrl(song.id, this.deliveryMode);
		if (!whole || !this.settings?.transcode) return src;
		return `${src}${src.includes('?') ? '&' : '?'}whole=1`;
	}

	/** Asks for `song` again in `element`, to be taken up at `position` once it has loaded. */
	#openAt(element: HTMLAudioElement, song: Song, position: number) {
		this.#pendingSeek = position;
		element.src = this.#srcOf(song, position > 1);
		element.load();
	}

	/**
	 * Sends both elements to the audio output `deviceId`, or to the system's
	 * default for `''`. Both, since they swap roles at every track change.
	 * Rejects where the browser refuses the device; `client/output.svelte.ts`
	 * handles that.
	 */
	async setOutput(deviceId: string): Promise<void> {
		if (this.#chain) await this.#chain.setOutput(deviceId);
		else {
			const elements = [this.#primary, this.#secondary].filter((el): el is HTMLAudioElement => el !== null);
			await Promise.all(elements.map((el) => el.setSinkId(deviceId)));
		}
		this.#outputId = deviceId;
	}

	/**
	 * Routes both elements through the graph (`audiochain.ts`), with the
	 * equaliser at `gains`. Once per page: an element cannot leave a graph, so
	 * turning processing off applies at the next load. A browser that refuses a
	 * context leaves playback as it was.
	 */
	enableProcessing(gains: readonly number[]) {
		if (!browser || !this.#primary || !this.#secondary) return;
		if (!this.#chain) {
			try {
				this.#chain = new AudioChain([this.#primary, this.#secondary]);
			} catch {
				return;
			}
			this.processing = true;
			if (this.#outputId) void this.#chain.setOutput(this.#outputId).catch(() => undefined);
			if (this.engaged) this.#chain.resume();
		}
		this.#chain.setEqualiser(gains);
		this.#abandonCrossfade();
		this.#applyVolume();
	}

	setEqualiser(gains: readonly number[]) {
		this.#chain?.setEqualiser(gains);
	}

	/** The headphone correction ahead of the bands, or none for null; see `audiochain.ts`. */
	setCorrection(correction: Correction | null) {
		this.#chain?.setCorrection(correction);
	}

	detach() {
		for (const off of this.#detachers) off();
		this.#detachers = [];
		for (const off of this.#lifecycleOff) off();
		this.#lifecycleOff = [];
		if (this.#progressTimer) clearInterval(this.#progressTimer);
		if (this.#positionTimer) clearInterval(this.#positionTimer);
		this.#cancelRecovery();
		this.#abandonCrossfade();
		// Written, not just cleared: clearing the debounce timer dropped whatever
		// the last change had scheduled.
		this.#flushPlayState();
	}

	// ── Queue control ──────────────────────────────────────────────────────

	/** Replaces the queue and starts at `startAt`, in the order given. */
	async playNow(songs: Song[], startAt = 0) {
		await this.#start(songs, startAt, false);
	}

	/** Replaces the queue with a shuffled copy and starts it. */
	async playShuffled(songs: Song[]) {
		await this.#start(shuffled(songs), 0, true);
		// After `#start`, which clears it for every new queue.
		this.#unshuffledIds = songs.map((song) => song.id);
		this.#persist();
	}

	/**
	 * Shuffle describes the queue, so a new queue sets it: on for a shuffled
	 * one, off for one in its own order. When only `playShuffled` set it, the
	 * button stayed lit, and saved, over every album played in order afterwards.
	 */
	async #start(songs: Song[], startAt: number, shuffle: boolean) {
		if (songs.length === 0) return;
		this.shuffle = shuffle;
		this.#unshuffledIds = null;
		this.direction = 1;
		this.queue = [...songs];
		this.index = Math.min(Math.max(0, startAt), songs.length - 1);
		this.#preloadedFor = null;
		await this.#changeTrack();
		this.#persist();
	}

	addToQueue(songs: Song[]) {
		if (songs.length === 0) return;
		if (this.queue.length === 0) {
			void this.playNow(songs);
			return;
		}
		this.queue = [...this.queue, ...songs];
		this.#persist();
	}

	/**
	 * Queues a track a listen-together member added: after the current track
	 * and the additions already waiting behind it, so additions play in the
	 * order made, ahead of what the host had queued. Playback is left as it is.
	 * With nothing queued the track waits for a press on play: an addition does
	 * not start sound in the host's browser.
	 */
	queueAddition(song: Song) {
		if (this.queue.length === 0) {
			this.queue = [song];
			this.index = 0;
			this.#persist();
			return;
		}
		let at = this.index + 1;
		while (this.queue[at]?.addedBy) at += 1;
		this.queue = [...this.queue.slice(0, at), song, ...this.queue.slice(at)];
		if (at === this.index + 1) this.#invalidatePreload();
		this.#persist();
	}

	removeAt(position: number) {
		if (position < 0 || position >= this.queue.length) return;
		const wasCurrent = position === this.index;
		this.queue = this.queue.filter((_, i) => i !== position);
		if (this.queue.length === 0) {
			this.stop();
			this.#persist();
			return;
		}
		if (position < this.index) this.index -= 1;
		else if (wasCurrent) {
			this.index = Math.min(this.index, this.queue.length - 1);
			void this.#loadCurrent(this.playing);
		}
		this.#invalidatePreload();
		this.#persist();
	}

	/**
	 * Moves one entry to another position. The playing track keeps playing, and
	 * `index` follows it. The buffered next track is dropped only when the move
	 * changed which track is next.
	 */
	move(from: number, to: number) {
		const length = this.queue.length;
		if (from === to || from < 0 || to < 0 || from >= length || to >= length) return;
		const nextBefore = this.upNext?.id ?? null;

		const queue = [...this.queue];
		const [moved] = queue.splice(from, 1);
		queue.splice(to, 0, moved);

		let index = this.index;
		if (from === index) index = to;
		else if (from < index && to >= index) index -= 1;
		else if (from > index && to <= index) index += 1;

		this.queue = queue;
		this.index = index;
		if ((this.upNext?.id ?? null) !== nextBefore) this.#invalidatePreload();
		this.#persist();
	}

	/** Sets the favourite state of every queued copy of a song, after a heart is pressed. */
	markStarred(id: string, starred: boolean) {
		for (const song of this.queue) if (song.id === id) song.starred = starred;
	}

	clearQueue() {
		this.stop();
		this.queue = [];
		this.index = 0;
		this.shuffle = false;
		this.#unshuffledIds = null;
		this.#persist();
	}

	async jumpTo(position: number) {
		if (position < 0 || position >= this.queue.length) return;
		this.direction = position >= this.index ? 1 : -1;
		this.index = position;
		this.#invalidatePreload();
		await this.#changeTrack();
		this.#persist();
	}

	// ── Transport ──────────────────────────────────────────────────────────

	/**
	 * Pauses what is meant to be playing, and plays otherwise.
	 *
	 * Decided by `engaged`, the listener's intent, while the track plays or is
	 * loading. `playing` follows the element and lags a press: a pause pressed
	 * just after a skip left it true for up to a second, so the next play
	 * paused again. A play that was refused (engaged, neither playing nor
	 * loading) is tried again.
	 */
	async toggle() {
		if (!this.#primary || !this.current) return;
		if (this.engaged && (this.playing || this.loading)) this.pause();
		else await this.play();
	}

	async play() {
		if (!this.#primary || !this.current) return;

		// Before the first await, so still inside the click, the only moment the
		// browser grants the second element an activation.
		this.#primeSecondary();
		this.#chain?.resume();
		this.engaged = true;
		// A timer that ran out while paused would pause again on the first
		// `timeupdate`. Pressing play after it is a decision to keep listening.
		if (this.sleep?.kind === 'at' && Date.now() >= this.sleep.at) this.setSleep(null);

		// A queue restored from the server has no src loaded yet, and carries the
		// position it was stored at.
		if (!this.#primary.src) {
			await this.#loadCurrent(true, true);
			return;
		}
		// A track picked up mid-way starts mid-cycle, so through the graph it comes
		// up from silence. A track starting from its top does not need to.
		const element = this.#primary;
		const rising = this.#chain !== null && this.#ducks === 0 && element.paused && element.currentTime > 0;
		if (rising) this.#chain?.duck(0);
		try {
			await element.play();
			this.error = null;
			if (rising && this.#ducks === 0) this.#chain?.unduck(DUCK_MS / 1000);
		} catch (err) {
			// Back at once: a later retry (`canplay`, `visibilitychange`) does not pass here.
			if (rising && this.#ducks === 0) this.#chain?.unduck(0);
			// A tab that is not on screen can have play() refused mid-queue. The
			// intent is kept, and `visibilitychange` and `canplay` retry it.
			if (typeof document !== 'undefined' && document.hidden) {
				this.playing = false;
				return;
			}
			// A pause pressed while the play was starting, or another track loaded
			// into the element (a skip pressed twice within a second), not a
			// failure. Chromium's message for the second, "The play() request was
			// interrupted by a new load request", was shown as the player's error.
			// The load that interrupted it has a play() of its own.
			if (err instanceof DOMException && err.name === 'AbortError') return;
			this.error = err instanceof Error ? err.message : 'Playback failed';
			this.playing = false;
		}
	}

	/**
	 * Unlocks the second audio element with a silent sample.
	 *
	 * Chromium grants autoplay per document. Safari and Firefox grant it per
	 * element, and the one that takes over at a track boundary was never
	 * touched by the user, so the first automatic advance was refused until the
	 * tab was focused.
	 */
	#primeSecondary() {
		const element = this.#secondary;
		if (this.#primed || !element) return;
		this.#primed = true;

		element.muted = true;
		element.src = SILENCE;
		const started = element.play();
		if (!started) return;
		void started
			.then(() => {
				element.pause();
				element.removeAttribute('src');
				element.load();
			})
			.catch(() => {
				element.removeAttribute('src');
			})
			.finally(() => {
				element.muted = false;
				this.#applyVolume();
			});
	}

	pause() {
		this.#cancelRecovery();
		this.engaged = false;
		this.#abandonCrossfade();
		const element = this.#primary;
		if (this.#fades()) {
			// A play pressed inside the fade leaves the element running, and the
			// lift brings the sound back.
			void this.#duck().then(() => {
				if (!this.engaged) element?.pause();
				this.#lift();
			});
		} else element?.pause();
		this.#chain?.suspendSoon();
		this.#persist();
	}

	stop() {
		this.engaged = false;
		this.#abandonCrossfade();
		if (this.#primary) {
			this.#primary.pause();
			this.#primary.removeAttribute('src');
			this.#primary.load();
		}
		this.playing = false;
		this.currentTime = 0;
		this.duration = 0;
	}

	async next(userInitiated = true) {
		if (this.queue.length === 0) return;
		this.direction = 1;
		// A skip drops the overlap. The end of a track completes it.
		if (userInitiated) this.#abandonCrossfade();

		if (!userInitiated && this.repeat === 'one') {
			this.seek(0);
			await this.play();
			return;
		}

		const last = this.index >= this.queue.length - 1;
		if (last) {
			if (this.repeat === 'all') {
				this.index = 0;
			} else if (!userInitiated) {
				// The natural end of the queue stops and does not wrap.
				this.engaged = false;
				this.playing = false;
				this.#persist();
				return;
			} else {
				return;
			}
		} else {
			this.index += 1;
		}

		if (userInitiated) await this.#changeTrack();
		else await this.#loadCurrent(true);
		this.#persist();
	}

	async previous() {
		if (this.queue.length === 0) return;
		this.direction = -1;
		this.#abandonCrossfade();
		// Restarts the track, or steps back when within its first 3 seconds.
		if (this.currentTime > 3) {
			this.seek(0);
			return;
		}
		if (this.index === 0) {
			if (this.repeat === 'all') this.index = this.queue.length - 1;
			else {
				this.seek(0);
				return;
			}
		} else {
			this.index -= 1;
		}
		await this.#changeTrack();
		this.#persist();
	}

	seek(seconds: number) {
		if (!this.#primary || !Number.isFinite(seconds) || this.current?.live) return;
		this.#abandonCrossfade();
		const target = Math.min(Math.max(0, seconds), this.duration || seconds);
		const element = this.#primary;
		// Nothing the element can seek to, or not that far: see `#seekOnceWhole`.
		// A second past the end is left to the element, which stops at its end.
		// `duration` here can be the music server's figure, a little over.
		//
		// Chromium reports a stream without ranges seekable to its end and takes
		// the seek by waiting for every byte before it: 25.2s for a seek to 3:51
		// with the stream arriving at 32KB/s, the sound stopped meanwhile. Such a
		// stream has no length, so its duration is Infinity. A seek well past what
		// has arrived goes the same way as one the element refuses: 1.5 to 2.3s
		// for MP3 at 48KB/s, 4 to 16s for Opus at 32KB/s, which Chromium finds
		// its place in over several ranges. Within 10 seconds of what has
		// arrived, the wait is the shorter of the two.
		//
		// Not for AAC. It is sent as ADTS, which has no index, and Chromium reads
		// one from its start whatever range it could ask for: asked for again,
		// the track had to arrive a second time (a seek to 1:28 at 32KB/s had not
		// landed after 26s). Not for a track being opened at a position either,
		// still at its top: it would be heard from there while the server was
		// asked.
		const ranges = element.seekable;
		const arrived = element.buffered.length > 0 ? element.buffered.end(element.buffered.length - 1) : 0;
		const unranged =
			element.duration === Infinity &&
			element.currentTime > 1 &&
			target > arrived + 10 &&
			this.settings?.transcodeCodec !== 'aac';
		if (element.readyState > 0 && (ranges.length === 0 || target > ranges.end(ranges.length - 1) + 1 || unranged)) {
			void this.#seekOnceWhole(element, target);
			return;
		}
		++this.#wholeSerial;
		const move = () => {
			try {
				element.currentTime = target;
				this.currentTime = target;
				this.#persist();
			} catch {
				// Seeking before metadata is ready throws. The listener can retry.
			}
		};
		if (!this.#fades()) {
			move();
			return;
		}
		// The bar goes to the target at once, and the element follows once the
		// output is silent. Of several seeks inside one fade (a drag along the
		// bar) only the last moves it.
		const serial = ++this.#seekSerial;
		this.currentTime = target;
		void this.#duck().then(() => {
			if (serial === this.#seekSerial && element === this.#primary) {
				move();
				// The track ran out inside the fade, where `ended` is not acted on.
				if (this.engaged && element.paused) void element.play().catch(() => undefined);
			}
			this.#lift();
		});
	}

	/**
	 * Whether a pause, a skip or a seek fades the output first: only through
	 * the graph, and only while it is producing sound. Without the graph the
	 * element is paused or moved at once.
	 */
	#fades(): boolean {
		const element = this.#primary;
		return this.#chain !== null && this.#chain.context.state === 'running' && element !== null && !element.paused;
	}

	/**
	 * Takes the output to silence over `DUCK_MS` and resolves once it is there.
	 * Each call is matched by one `#lift`. While any is in flight `timeupdate`
	 * and `ended` are not acted on: the queue may have moved on from the track
	 * the element is still playing out.
	 */
	#duck(): Promise<void> {
		this.#ducks++;
		this.#chain?.duck(DUCK_MS / 1000);
		return new Promise((resolve) => setTimeout(resolve, DUCK_MS));
	}

	/**
	 * Ends one fade. When it was the last in flight the output comes back: at
	 * once if `now` or if nothing is playing, and over `DUCK_MS` under a track
	 * that carries on.
	 */
	#lift(now = false) {
		this.#ducks = Math.max(0, this.#ducks - 1);
		if (this.#ducks > 0) return;
		const element = this.#primary;
		this.#chain?.unduck(now || !element || element.paused ? 0 : DUCK_MS / 1000);
	}

	/**
	 * Loads the current track after a press that changed it, fading out what is
	 * playing first where `#fades`. Of several presses inside one fade only the
	 * last loads. A pause pressed inside the fade is kept: the track loads and
	 * does not start.
	 */
	async #changeTrack() {
		if (!this.#fades()) {
			await this.#loadCurrent(true);
			return;
		}
		const serial = ++this.#changeSerial;
		// A skip is a decision to keep listening, including one pressed while a
		// pause was still fading out.
		this.engaged = true;
		await this.#duck();
		if (serial !== this.#changeSerial) {
			this.#lift();
			return;
		}
		const loading = this.#loadCurrent(this.engaged);
		// The new track starts from its top, at full level.
		this.#lift(true);
		await loading;
	}

	setVolume(value: number) {
		this.volume = Math.min(1, Math.max(0, value));
		this.muted = false;
		this.#applyVolume();
		this.#persistSettings({ volume: this.volume });
	}

	toggleMute() {
		this.muted = !this.muted;
		this.#applyVolume();
	}

	cycleRepeat() {
		this.repeat = this.repeat === 'off' ? 'all' : this.repeat === 'all' ? 'one' : 'off';
		this.#persist();
	}

	/**
	 * Shuffling rewrites the queue, so the queue panel shows what will play
	 * next. The order it had is kept, and turning shuffle off puts the queue
	 * back in that order around the playing track, with edits made since kept
	 * (`unshuffled`).
	 */
	toggleShuffle() {
		this.shuffle = !this.shuffle;
		if (this.shuffle) {
			// A queue still being restored holds only its current track. The saved
			// ids are its real order.
			this.#unshuffledIds = this.#partial ? [...this.#partial.ids] : this.queue.map((song) => song.id);
			if (this.queue.length > 1) {
				// The playing track stays put and the rest is reordered around it, so
				// turning shuffle on does not interrupt the audio.
				const current = this.queue[this.index];
				const rest = shuffled(this.queue.filter((_, i) => i !== this.index));
				this.queue = [current, ...rest];
				this.index = 0;
			}
		} else if (this.#unshuffledIds) {
			const order = this.#unshuffledIds;
			const partial = this.#partial;
			if (partial) {
				// Reordered in the saved ids, which `completeRestore` fills in. The
				// queue array is left as it is: replacing it would make
				// `completeRestore` think the queue was changed.
				const entries = partial.ids.map((id) => ({ id }));
				const reordered = unshuffled(entries, order, entries[partial.index]);
				this.#partial = { ...partial, ids: reordered.map((entry) => entry.id), index: reordered.indexOf(entries[partial.index]) };
			} else {
				const current = this.queue[this.index];
				const queue = unshuffled(this.queue, order, current);
				this.queue = queue;
				this.index = Math.max(0, queue.indexOf(current));
			}
		}
		if (!this.shuffle) this.#unshuffledIds = null;
		this.#invalidatePreload();
		this.#persist();
	}

	toggleQueuePanel() {
		this.queueOpen = !this.queueOpen;
		// The queue shows inside the panel, so asking for it opens the panel.
		if (this.queueOpen) this.panelOpen = true;
	}

	togglePanel() {
		this.panelOpen = !this.panelOpen;
	}

	/**
	 * Sets the sleep timer: minutes from now, `'track'` for the end of the
	 * current track, or `null` to cancel. Cancelling during the fade puts the
	 * level back at once.
	 */
	setSleep(choice: number | 'track' | null) {
		if (choice === null) this.sleep = null;
		else if (choice === 'track') this.sleep = { kind: 'track' };
		else this.sleep = { kind: 'at', at: Date.now() + choice * 60_000, minutes: choice };
		this.#applyVolume();
	}

	/**
	 * Where the panel is a sheet over the page it starts closed, so it does not
	 * cover the library on arrival. The breakpoint is the layout's, and it is
	 * watched, so rotating a tablet does not leave the sheet open over the
	 * content.
	 */
	#adoptViewport() {
		const sheet = window.matchMedia('(max-width: 60rem)');
		const apply = () => {
			this.panelOpen = !sheet.matches;
			this.sheetLayout = sheet.matches;
			this.viewportKnown = true;
		};
		apply();
		sheet.addEventListener('change', apply);
		// `#lifecycleOff`, not `#detachers`, which is emptied each time `#bind`
		// moves to the other audio element: after the first track change this
		// listener was gone.
		this.#lifecycleOff.push(() => sheet.removeEventListener('change', apply));
	}

	// ── Internals ──────────────────────────────────────────────────────────

	/**
	 * Loads the current track.
	 *
	 * `resume` is for a queue restored from the server, which carries a
	 * position, and whose file the first `play()` loads. Every other caller is
	 * a track the listener just chose, which starts at the beginning. Without
	 * the distinction the restored position survived into the next load, and
	 * Play on an album after a reload started its first track where the
	 * previous session had stopped.
	 */
	async #loadCurrent(autoplay: boolean, resume = false) {
		const song = this.current;
		if (!song || !this.#primary) return;

		if (!resume) this.#pendingSeek = null;

		// The ramp addresses `#primary` and `#secondary` by reference, and the swap
		// below exchanges them. A timer that outlived the swap would ramp both the
		// wrong way.
		this.#endCrossfade();

		this.#cancelRecovery();
		this.#recoveries = 0;
		this.#scrobbled = false;
		this.#startReported = false;
		// A position waiting to be taken up stays on the bar while the track
		// loads, and is where a stream that drops in that time is picked up.
		this.currentTime = this.#pendingSeek ?? 0;
		this.duration = song.duration || 0;
		this.error = null;

		// A next track already buffered in the secondary element is swapped in,
		// without a network round trip.
		if (this.#preloadedFor === song.id && this.#secondary?.src) {
			this.#swapElements();
		} else {
			this.loading = true;
			// A track queued since casting began needs its own address first.
			if (this.#castUrls && !song.live && !this.#castUrls.has(song.id)) {
				await this.#ensureCastUrls();
				if (this.current !== song || !this.#primary) return;
			}
			this.#primary.src = this.#srcOf(song, (this.#pendingSeek ?? 0) > 1);
			this.#primary.load();
		}

		this.#applyVolume();
		this.#updateMediaSession(song);
		this.#warmNext();
		this.#preloadedFor = null;

		if (autoplay) await this.play();
	}

	#swapElements() {
		if (!this.#primary || !this.#secondary) return;
		const oldPrimary = this.#primary;
		oldPrimary.pause();
		oldPrimary.removeAttribute('src');

		this.#primary = this.#secondary;
		this.#secondary = oldPrimary;
		this.#bind(this.#primary);
	}

	/**
	 * Overlaps the outgoing and incoming tracks on an equal-power ramp.
	 *
	 * The two gains are `cos` and `sin` of the same quarter turn, so their
	 * squares sum to one. A linear pair sums to one in amplitude, which dips
	 * about 3 dB in the middle.
	 *
	 * The ramp runs on an interval: `requestAnimationFrame` stops in a
	 * background tab, where an unattended queue does its crossfading.
	 */
	#maybeCrossfade() {
		if (this.#fadeTimer !== null || this.#chainFading || this.current?.live) return;
		const settings = this.settings;
		if (!settings || settings.transition !== 'crossfade') return;
		if (this.#castUrls) return;
		// Without a ramp this would be two tracks at full level, so the `ended`
		// handler makes the tight handoff from the buffered element. The graph's
		// gains are applied where `volume` is not, as on iOS.
		if (!this.rampsVolume && !this.#chain) return;
		// Repeating one track would have to fade an element into itself.
		if (this.repeat === 'one') return;
		// The next track would start before the `ended` handler could stop there.
		if (this.sleep?.kind === 'track') return;

		const outgoing = this.#primary;
		const incoming = this.#secondary;
		if (!outgoing || !incoming || !this.playing) return;

		const next = this.#following;
		if (!next || this.#preloadedFor !== next.id) return;
		// Two tracks written to run into each other (a live album, a mix) get the
		// tight handoff, unless the account asks for a fade there too.
		if (!settings.crossfadeWithinAlbum && this.current && followsOnAlbum(this.current, next)) return;
		// Not buffered far enough to start without a stall. The `ended` handler
		// makes an ordinary cut.
		if (incoming.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) return;

		const remaining = this.duration - this.currentTime;
		const seconds = Math.min(settings.crossfadeSeconds, Math.max(1, this.duration / 2));
		if (!Number.isFinite(remaining) || remaining > seconds || remaining <= 0) return;

		// `timeupdate` is coarse, so the window is usually entered late. Ramping
		// over what is left keeps the end of the ramp on the end of the track.
		this.#fadeSeconds = remaining;
		this.#fadeStartedAt = Date.now();
		incoming.currentTime = 0;

		const chain = this.#chain;
		if (chain) {
			// The whole ramp at once, on the audio thread. The elements stay at full
			// `volume`, and the level is the graph's.
			this.#chainFading = true;
			chain.holdSide(incoming, 0);
			chain.crossfade(outgoing, incoming, this.#gainFor(this.current), this.#gainFor(this.#preloadedSong()), remaining);
			void incoming.play().catch(() => this.#abandonCrossfade());
			return;
		}

		incoming.volume = 0;
		void incoming.play().catch(() => this.#abandonCrossfade());

		this.#fadeTimer = setInterval(() => this.#stepCrossfade(), 50);
	}

	#stepCrossfade() {
		const outgoing = this.#primary;
		const incoming = this.#secondary;
		if (!outgoing || !incoming) return this.#abandonCrossfade();

		const level = (this.muted ? 0 : this.volume) * this.#sleepGain();
		const t = Math.min(1, (Date.now() - this.#fadeStartedAt) / (this.#fadeSeconds * 1000));
		// Each side ramps to its own corrected level, so the join does not jump
		// between two tracks mastered at different loudness.
		outgoing.volume = level * this.#gainFor(this.current) * Math.cos((t * Math.PI) / 2);
		incoming.volume = level * this.#gainFor(this.#preloadedSong()) * Math.sin((t * Math.PI) / 2);

		// The ramp only moves the two gains. The outgoing element's `ended` event
		// advances the queue: it fires at the end of the ramp, which runs for the
		// `remaining` seconds it started with. A ramp that advanced too raced that
		// event and skipped a track when it won.
		if (t >= 1) this.#clearFadeTimer();
	}

	/**
	 * Stops the ramp and leaves both elements as they are: the outgoing track
	 * has run out, the incoming one is playing at full level, and the swap is
	 * about to make it the primary.
	 */
	#endCrossfade() {
		this.#clearFadeTimer();
		this.#chainFading = false;
	}

	/**
	 * Abandons an overlap the listener interrupted (a pause, a skip, a seek, a
	 * change to the queue). The buffered track goes back to its start, where
	 * whatever follows expects it.
	 */
	#abandonCrossfade() {
		if (this.#fadeTimer === null && !this.#chainFading) return;
		this.#clearFadeTimer();
		// `#applyVolume` below cancels the scheduled ramps and puts both sides back.
		this.#chainFading = false;
		const incoming = this.#secondary;
		if (incoming) {
			incoming.pause();
			try {
				incoming.currentTime = 0;
			} catch {
				// Seeking an element whose src was just dropped throws.
			}
		}
		this.#applyVolume();
	}

	/**
	 * A seek the element cannot make, in a transcode that began to arrive
	 * before the server had read it whole.
	 *
	 * Such a stream has no ranges (`transcodes.ts`). Chromium seeks in one by
	 * waiting for the bytes. Firefox reports nothing seekable for as long as
	 * the element holds it: in Playwright's Firefox against a read of 6
	 * seconds, presses at 0:01 and at 0:12 both left the track where it was.
	 *
	 * The server answers a new request in ranges once its read is whole, which
	 * a HEAD shows with `Accept-Ranges`. Then the track is asked for again and
	 * the position taken up through `#pendingSeek`, as a resume is. Asked for
	 * sooner, it would come as another stream without ranges, from the start.
	 * Until then the track plays on, and after 30 looks a second apart the seek
	 * is left to the element: a transcode too large for the server to hold
	 * never has ranges.
	 *
	 * A seek past what has arrived of such a stream comes here in every
	 * browser; see `seek`.
	 */
	async #seekOnceWhole(element: HTMLAudioElement, target: number) {
		const song = this.current;
		if (!song) return;
		const serial = ++this.#wholeSerial;
		const wanted = () => serial === this.#wholeSerial && this.#primary === element && this.current === song;
		this.loading = true;
		for (let attempt = 0; attempt < SEEK_HOLD_ATTEMPTS; attempt++) {
			// Past the browser's cache. Chromium makes a request wait for another
			// that is still writing the same address into its cache, up to 20
			// seconds, and the element's own stream is one: the first answer here
			// came 20.2s after the press.
			const whole = await fetch(this.#srcOf(song), { method: 'HEAD', cache: 'no-store' }).then(
				(response) => response.ok && response.headers.get('accept-ranges') === 'bytes',
				() => false
			);
			if (!wanted()) return;
			if (whole) {
				this.#abandonCrossfade();
				this.currentTime = target;
				this.#openAt(element, song, target);
				if (this.engaged) void element.play().catch(() => undefined);
				return;
			}
			await new Promise((done) => setTimeout(done, SEEK_HOLD_MS));
			if (!wanted()) return;
		}
		this.loading = false;
		// Never whole: left to the element, which in Chromium waits for the bytes.
		try {
			element.currentTime = target;
		} catch {
			// Nothing loaded to seek in.
		}
	}

	/**
	 * Asks for the rest of the current track from where it stopped arriving.
	 *
	 * `playing` is left alone: this is a gap, not a stop, and `loading` puts a
	 * spinner on the button. The position is carried by `#pendingSeek`, since
	 * the seek waits for the reloaded element to know the file's length.
	 */
	#recoverStream() {
		const element = this.#primary;
		const song = this.current;
		if (!element || !song) return;

		const position = this.currentTime;
		this.#recoveries += 1;
		this.loading = true;
		this.#cancelRecovery();
		// A proxy that just cut one response cuts the next too if asked at once.
		this.#recoveryTimer = setTimeout(() => {
			this.#recoveryTimer = null;
			// A pause pressed during the wait wins.
			if (!this.engaged || this.#primary !== element) return;
			this.#openAt(element, song, position);
			void element.play().catch(() => undefined);
		}, RECOVERY_BACKOFF_MS * this.#recoveries);
	}

	#cancelRecovery() {
		if (this.#recoveryTimer !== null) clearTimeout(this.#recoveryTimer);
		this.#recoveryTimer = null;
	}

	#clearFadeTimer() {
		if (this.#fadeTimer !== null) clearInterval(this.#fadeTimer);
		this.#fadeTimer = null;
	}

	/**
	 * Starts the server reading the next track's transcode as this one starts,
	 * with a HEAD request that downloads nothing.
	 *
	 * The server answers a transcode in ranges only once it has read it whole
	 * (`transcodes.ts`). The next track is preloaded 20 seconds before its
	 * turn, and a read started here is whole by then (2.7 to 17 seconds
	 * measured), so the element that plays it has ranges from the first byte
	 * and a dropped stream can resume. Original files need none of this.
	 */
	#warmNext() {
		if (!browser || !this.settings?.transcode) return;
		const next = this.#following;
		if (!next || next.id === this.current?.id || next.live) return;
		void fetch(streamUrl(next.id, this.deliveryMode), { method: 'HEAD' }).catch(() => undefined);
	}

	/** Buffers the upcoming track so the handoff does not wait on the network. */
	#maybePreloadNext() {
		if (!this.settings?.preloadNext || this.settings.transition === 'off') return;
		// Casting follows one element; see `#beginCast`.
		if (this.#castUrls) return;
		const next = this.#following;
		if (!next || !this.#secondary || next.live || this.current?.live) return;
		if (this.#preloadedFor === next.id) return;
		// Only within 20 seconds of the end.
		if (this.duration > 0 && this.duration - this.currentTime > 20) return;

		this.#preloadedFor = next.id;
		this.#secondary.src = streamUrl(next.id, this.deliveryMode);
		this.#secondary.preload = 'auto';
		this.#secondary.load();
	}

	/**
	 * The track's length: the element's, which is exact for a file with an
	 * index, where the music server's is a hint in whole seconds.
	 *
	 * A transcode is the exception when the two are far apart (3 seconds, or 2
	 * percent). It is as long as the file it was made from, and the element has
	 * to estimate it. In Firefox, 2026-10-06:
	 *
	 *  - An MP3 still arriving as a stream had the length of what had arrived:
	 *    1.4s for a track of 4:36. The seek bar then spanned 1.4 seconds, and a
	 *    press anywhere on it went to the start of the track.
	 *  - AAC from Navidrome, which is ADTS without an index, was given 4:28
	 *    for a track of 3:48, and a press late on the bar ran off its end into
	 *    the next track.
	 *
	 * The crossfade, the preload and the scrobble are timed from the same
	 * figure.
	 */
	#adoptDuration(element: HTMLAudioElement) {
		const own = element.duration;
		if (!Number.isFinite(own) || own <= 0) return;
		const listed = this.current?.duration ?? 0;
		const apart = Math.abs(own - listed) > Math.max(3, listed * 0.02);
		this.duration = this.settings?.transcode && listed > 0 && apart ? listed : own;
	}

	#bind(element: HTMLAudioElement) {
		for (const off of this.#detachers) off();
		this.#detachers = [];

		const on = <K extends keyof HTMLMediaElementEventMap>(
			event: K,
			handler: (e: HTMLMediaElementEventMap[K]) => void
		) => {
			element.addEventListener(event, handler);
			this.#detachers.push(() => element.removeEventListener(event, handler));
		};

		on('loadedmetadata', () => {
			this.#adoptDuration(element);
			this.loading = false;
			// A restored queue resumes where it left off, and the seek waits for the
			// element to know the file's length.
			if (this.#pendingSeek !== null) {
				const target = this.#pendingSeek;
				this.#pendingSeek = null;
				if (target > 1 && target < this.duration - 1) this.seek(target);
				if (this.engaged && element.paused) void element.play().catch(() => undefined);
			}
		});

		on('durationchange', () => this.#adoptDuration(element));

		on('timeupdate', () => {
			if (this.#ducks > 0) return;
			// A position waiting to be taken up is what the bar shows. The element
			// reports 0 until it has loaded.
			if (this.#pendingSeek !== null) return;
			this.currentTime = element.currentTime;
			this.#maybeSleep();
			this.#maybeScrobble();
			this.#maybePreloadNext();
			this.#maybeCrossfade();
		});

		on('progress', () => {
			const ranges = element.buffered;
			this.buffered = ranges.length > 0 ? ranges.end(ranges.length - 1) : 0;
		});

		on('play', () => {
			// A play from the lock screen or a retry, not only from `play()`.
			this.#chain?.resume();
			this.playing = true;
			this.loading = false;
			this.#reportStart();
			this.#syncMediaSessionState();
		});

		on('pause', () => {
			this.playing = false;
			this.#syncMediaSessionState();
		});

		on('waiting', () => {
			this.loading = true;
		});

		on('playing', () => {
			this.loading = false;
			// Sound is coming out, so the next drop gets a full set of attempts.
			this.#recoveries = 0;
			this.error = null;
		});

		on('canplay', () => {
			// Ready, not playing and not paused by the listener: an earlier play()
			// was refused, so it is tried again.
			if (this.engaged && element.paused) void element.play().catch(() => undefined);
		});

		on('ended', () => {
			if (this.#ducks > 0) return;
			this.#reportStop(true);
			if (this.sleep?.kind === 'track') void this.#sleepAtTrackEnd();
			else void this.next(false);
		});

		on('error', () => {
			const code = element.error?.code;
			// A codec this browser cannot handle, or bytes it cannot decode, does not
			// improve on a retry. Anything else is usually the transport.
			const fatal =
				code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED || code === MediaError.MEDIA_ERR_DECODE;

			if (!fatal && this.engaged && this.#recoveries < RECOVERY_ATTEMPTS) {
				this.#recoverStream();
				return;
			}

			this.loading = false;
			this.playing = false;
			this.error = fatal
				? 'This browser cannot decode this file. Check the README for codec support.'
				: 'The stream stopped and could not be picked back up.';
		});
	}


	#applyVolume() {
		// Untracked. This reads the queue and the settings and is called from
		// inside effects (`attach`, the layout's settings effect). Tracked, those
		// reads made the effect that attaches the player depend on them: settings
		// arriving with every navigation re-ran it, its teardown detached the
		// player, and every page change stopped the music.
		untrack(() => {
			const value = (this.muted ? 0 : this.volume) * this.#sleepGain();
			const chain = this.#chain;
			if (chain) {
				// Through the graph the elements play at full `volume`, and the level
				// and each track's gain are the graph's. A crossfade in progress owns
				// the two sides until it ends.
				chain.setLevel(value);
				for (const element of [this.#primary, this.#secondary]) if (element) element.volume = 1;
				if (!this.#chainFading) {
					if (this.#primary) chain.setSide(this.#primary, this.#gainFor(this.current));
					if (this.#secondary) chain.setSide(this.#secondary, this.#gainFor(this.#preloadedSong()));
				}
				return;
			}
			if (this.#primary) this.#primary.volume = value * this.#gainFor(this.current);
			if (this.#secondary) this.#secondary.volume = value * this.#gainFor(this.#preloadedSong());
		});
	}

	/** The song the second element holds, if it holds one. */
	#preloadedSong(): Song | null {
		if (!this.#preloadedFor) return null;
		return this.queue.find((song) => song.id === this.#preloadedFor) ?? null;
	}

	/**
	 * The volume correction for one song, from its ReplayGain data.
	 *
	 * Applied through each element's `volume`, a multiplier from 0 to 1, so it
	 * can lower a track and cannot raise one. Most commercial releases carry a
	 * negative track gain (about -6 to -10 dB against the 89 dB reference), so
	 * loud records come down to meet quiet ones. With audio processing on, the
	 * correction is a gain in the graph (`audiochain.ts`), and a quiet track is
	 * raised as far as its peak allows. A track without a peak is not raised.
	 *
	 * Track gain is used, with album gain as the fallback. The peak caps the
	 * factor, so the loudest sample stays within full scale. A file without
	 * data plays unchanged.
	 */
	#gainFor(song: Song | null): number {
		if (!this.settings?.normalizeVolume || !song?.replayGain) return 1;
		const { trackGain, albumGain, trackPeak, albumPeak } = song.replayGain;
		const gain = trackGain ?? albumGain;
		if (gain === null) return 1;
		let factor = 10 ** (gain / 20);
		const peak = trackGain !== null ? trackPeak : albumPeak;
		if (peak !== null && peak > 0) factor = Math.min(factor, 1 / peak);
		if (this.#chain && peak !== null && peak > 0) return Math.max(0, factor);
		return Math.min(1, Math.max(0, factor));
	}

	// ── Sleep timer ────────────────────────────────────────────────────────

	/**
	 * The level multiplier for the sleep timer's fade: 1 until the last
	 * `SLEEP_FADE_SECONDS`, then down to 0 on the crossfade's quarter-cosine.
	 */
	#sleepGain(): number {
		const sleep = this.sleep;
		if (sleep?.kind !== 'at') return 1;
		const left = (sleep.at - Date.now()) / 1000;
		if (left >= SLEEP_FADE_SECONDS) return 1;
		if (left <= 0) return 0;
		return Math.sin(((left / SLEEP_FADE_SECONDS) * Math.PI) / 2);
	}

	/**
	 * Steps the fade and pauses when the time is up.
	 *
	 * Driven by `timeupdate`: a timer in a background tab can be throttled,
	 * and `timeupdate` fires for as long as there is sound to fade. A timer
	 * that runs out while paused does nothing until `play()` clears it.
	 */
	#maybeSleep() {
		const sleep = this.sleep;
		if (sleep?.kind !== 'at') return;
		if (Date.now() < sleep.at) {
			if (sleep.at - Date.now() < SLEEP_FADE_SECONDS * 1000) this.#applyVolume();
			return;
		}
		this.pause();
		this.setSleep(null);
	}

	/**
	 * Stops at the end of a track with the next one loaded and not playing, so
	 * pressing play carries on from there.
	 */
	async #sleepAtTrackEnd() {
		this.sleep = null;
		this.engaged = false;
		this.playing = false;
		if (this.repeat === 'one') {
			this.seek(0);
			return;
		}
		const last = this.index >= this.queue.length - 1;
		if (last && this.repeat !== 'all') {
			this.#persist();
			return;
		}
		this.index = last ? 0 : this.index + 1;
		await this.#loadCurrent(false);
		this.#persist();
	}

	/** Takes new settings from the layout and re-levels the elements to them. */
	applySettings(settings: UserSettings) {
		this.settings = settings;
		this.#applyVolume();
	}

	// ── Playback reporting ─────────────────────────────────────────────────

	#reportStart() {
		if (this.#startReported || !this.current) return;
		this.#startReported = true;
		this.#report('start', this.currentTime);
	}

	#maybeScrobble() {
		if (this.#scrobbled || !this.current || this.duration <= 0) return;
		// Half the track, capped at four minutes, and never before 30 seconds: the
		// rule Subsonic clients and Last.fm use.
		const threshold = Math.max(
			Math.min(SCROBBLE_MIN_SECONDS, this.duration),
			Math.min(this.duration * SCROBBLE_FRACTION, 4 * 60)
		);
		if (this.currentTime < threshold) return;
		this.#scrobbled = true;
		this.#report('stop', this.currentTime, true);
	}

	#reportStop(completed: boolean) {
		if (!this.current) return;
		this.#report('stop', this.currentTime, completed && !this.#scrobbled);
	}

	/**
	 * Brings playback back if the browser refused to start a track while the tab
	 * was in the background. Without it the queue stalls until the listener
	 * returns and presses play.
	 */
	#watchVisibility() {
		if (!browser) return;
		const resume = () => {
			if (!this.engaged || document.hidden) return;
			const element = this.#primary;
			if (element && element.src && element.paused) {
				void element.play().catch(() => undefined);
			}
		};

		/*
		 * Saves the position on the way out, so a reload or a tab the system
		 * takes away resumes where the listener was and not at the last
		 * ten-second tick.
		 *
		 * `pagehide` covers a reload and a navigation away. Hiding covers iOS,
		 * where Safari can freeze or discard a backgrounded tab without another
		 * event. A second write costs one request, and the endpoint replaces the
		 * row.
		 */
		const flush = () => this.#flushPlayState();
		const onVisibility = () => {
			if (document.hidden) flush();
			else resume();
		};

		document.addEventListener('visibilitychange', onVisibility);
		window.addEventListener('pagehide', flush);
		this.#lifecycleOff.push(() => document.removeEventListener('visibilitychange', onVisibility));
		this.#lifecycleOff.push(() => window.removeEventListener('pagehide', flush));
	}

	#startProgressReporting() {
		if (!browser) return;
		// Jellyfin expects periodic progress pings to keep the session alive.
		this.#progressTimer = setInterval(() => {
			if (this.playing && this.current) this.#report('progress', this.currentTime);
		}, 20_000);

		/*
		 * The stored position has to keep up with playback, not only with queue
		 * edits.
		 *
		 * Every other write follows a change (a track chosen, the queue edited,
		 * a pause), and listening changes nothing: after 34 seconds of
		 * uninterrupted playback the stored position was still 67.2s, and a full
		 * page load resumed that far back.
		 *
		 * Ten seconds is the most a crash or a killed tab loses. A reload or a
		 * backgrounded tab loses nothing: `#watchVisibility` flushes on the way
		 * out.
		 */
		this.#positionTimer = setInterval(() => {
			if (this.playing && this.current) this.#writePlayState();
		}, 10_000);
	}

	#report(event: 'start' | 'progress' | 'stop', position: number, completed = false) {
		if (!browser || !this.current || this.settings?.reportPlayback === false || this.current.live) return;
		const body = JSON.stringify({ songId: this.current.id, event, position, completed });
		// `keepalive`, so a report fired during unload still leaves the browser.
		void fetch('/api/playback', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body,
			keepalive: true
		}).catch(() => undefined);
	}

	// ── Persistence ────────────────────────────────────────────────────────

	/** Debounced, for a burst of queue edits or a scrub. */
	#persist() {
		if (!browser) return;
		this.#changes += 1;
		if (this.#persistTimer) clearTimeout(this.#persistTimer);
		this.#persistTimer = setTimeout(() => this.#writePlayState(), 1200);
	}

	/**
	 * The write made on the way out: what this browser changed, or the position
	 * of a track it is playing. See `#unsaved`.
	 */
	#flushPlayState() {
		if (this.queue.length > 0 && (this.#unsaved || this.playing)) this.#writePlayState(true);
	}

	/**
	 * Writes the queue and the position now. `keepalive` is for the writes made
	 * on the way out, where an ordinary fetch is cancelled with the page.
	 */
	#writePlayState(keepalive = false) {
		if (!browser) return;
		if (this.#persistTimer) clearTimeout(this.#persistTimer);
		this.#persistTimer = null;
		// A station is not a track the music server can return by id, so a queue
		// holding one is not saved, and the queue saved before it stays.
		if (this.queue.some((song) => song.live)) return;
		const upTo = this.#changes;
		// While a restore holds only the current track, a write carries the queue
		// it stands for. Written as it stood, a play pressed before the rest
		// arrived saved a one-track queue over the saved one.
		const partial = this.#partial && this.queue === this.#partial.queue ? this.#partial : null;
		const payload: PersistPayload = {
			songIds: partial ? partial.ids : this.queue.map((song) => song.id),
			index: partial ? partial.index : this.index,
			position: this.currentTime,
			repeat: this.repeat,
			shuffle: this.shuffle,
			...(this.shuffle && this.#unshuffledIds ? { orderIds: this.#unshuffledIds } : {})
		};
		const body = JSON.stringify(payload);
		void fetch('/api/play-state', {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			body,
			// Browsers cap all in-flight keepalive bodies at 64KB and reject
			// anything past it. A queue is capped at 1000 ids, about 39KB of JSON
			// at the length of a Navidrome or Jellyfin id, but the server accepts
			// ids up to 255 characters. Over the limit the request is sent
			// without keepalive, which the unload may cut short.
			keepalive: keepalive && body.length <= KEEPALIVE_LIMIT
		})
			.then(async (response) => {
				if (!response.ok) return;
				this.#written = Math.max(this.#written, upTo);
				const at = Number((await response.json()).updatedAt);
				if (Number.isFinite(at)) this.#savedAt = Math.max(this.#savedAt, at);
			})
			.catch(() => undefined);
	}

	/**
	 * How audio is asked for, as a string for the URL. In the URL and not a
	 * header, so the browser's cache keys on it: the original file, already
	 * held, would otherwise answer the first request after transcoding was
	 * switched on.
	 *
	 * Opus carries a mark for the form its bytes take (`server/ogg.ts`). A
	 * browser keeps a stream for an hour, in part where the track was left
	 * early, and asks for the rest by range: the part of an Opus transcode
	 * kept from before its serials were fixed is not continued by one sent
	 * since. Change the mark with any change to the bytes sent for a codec.
	 */
	get deliveryMode(): string {
		const settings = this.settings;
		if (!settings?.transcode) return 'raw';
		const mode = `${settings.transcodeCodec}-${settings.transcodeBitrateKbps}`;
		return settings.transcodeCodec === 'opus' ? `${mode}-s1` : mode;
	}

	/**
	 * Switches transcoding on or off without interrupting what is playing.
	 *
	 * The track is re-opened in the new mode at the position it had reached. On
	 * some servers a transcode starts at the beginning whatever the request
	 * asks for, so the seek is re-applied through `#pendingSeek` once the new
	 * source is ready. What was buffered ahead is in the old mode and is
	 * dropped.
	 */
	async setTranscoding(on: boolean): Promise<void> {
		const settings = this.settings;
		if (!settings || settings.transcode === on) return;
		settings.transcode = on;
		this.#persistSettings({ transcode: on });
		this.#invalidatePreload();

		await this.#reopenCurrent();
	}

	/**
	 * Re-opens the current track from its address as it now is (another
	 * delivery mode, or a cast address), at the position it had reached and
	 * playing if it was.
	 */
	async #reopenCurrent(): Promise<void> {
		const element = this.#primary;
		const song = this.current;
		if (!element || !song) return;

		const position = this.currentTime;
		const wasPlaying = this.playing;
		this.loading = true;
		this.#openAt(element, song, position);
		if (wasPlaying) await element.play().catch(() => undefined);
	}

	#persistSettings(patch: Partial<UserSettings>) {
		if (!browser) return;
		void fetch('/api/settings', {
			method: 'PATCH',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(patch)
		}).catch(() => undefined);
	}

	#invalidatePreload() {
		this.#abandonCrossfade();
		this.#preloadedFor = null;
		if (this.#secondary) this.#secondary.removeAttribute('src');
	}

	// ── OS media keys / lock screen ────────────────────────────────────────

	#updateMediaSession(song: Song) {
		if (!browser || !('mediaSession' in navigator)) return;
		navigator.mediaSession.metadata = new MediaMetadata({
			title: song.title,
			artist: song.artist ?? '',
			album: song.album ?? '',
			artwork: song.coverArt
				? [256, 512].map((size) => ({
						src: coverUrl(song.coverArt, size),
						sizes: `${size}x${size}`,
						type: 'image/jpeg'
					}))
				: []
		});

		navigator.mediaSession.setActionHandler('play', () => void this.play());
		navigator.mediaSession.setActionHandler('pause', () => this.pause());
		navigator.mediaSession.setActionHandler('previoustrack', () => void this.previous());
		navigator.mediaSession.setActionHandler('nexttrack', () => void this.next());
		navigator.mediaSession.setActionHandler('seekto', (details) => {
			if (details.seekTime !== undefined) this.seek(details.seekTime);
		});
	}

	#syncMediaSessionState() {
		if (!browser || !('mediaSession' in navigator)) return;
		navigator.mediaSession.playbackState = this.playing ? 'playing' : 'paused';
	}

	/**
	 * Restores a queue persisted server-side. Does not autoplay.
	 *
	 * `partial` is given when `songs` is only the current track and the rest of
	 * the saved queue is still being looked up. `completeRestore` puts it in.
	 */
	async restore(
		songs: Song[],
		state: { index: number; position: number; repeat: RepeatMode; shuffle: boolean; orderIds?: string[]; updatedAt?: number },
		partial?: { ids: string[]; index: number }
	) {
		if (songs.length === 0) return;
		this.queue = songs;
		this.#partial = partial ? { queue: this.queue, ids: partial.ids, index: partial.index } : null;
		this.index = Math.min(Math.max(0, state.index), songs.length - 1);
		this.repeat = state.repeat;
		this.shuffle = state.shuffle;
		this.#unshuffledIds = state.shuffle && state.orderIds?.length ? state.orderIds : null;
		this.duration = this.current?.duration ?? 0;
		this.currentTime = state.position;
		this.#pendingSeek = state.position;
		if (state.updatedAt !== undefined) {
			this.#savedAt = state.updatedAt;
			this.#written = this.#changes;
		} else {
			// A queue handed over by another browser has no saved copy yet.
			this.#changes += 1;
		}
		// No src is assigned: browsers block autoplay, and the file is not
		// fetched until the first play() asks for it.
	}

	/**
	 * Puts the rest of a partly restored queue in, around the track already
	 * there, without touching what is playing.
	 *
	 * The current track keeps its object, so nothing that follows it sees a
	 * change of track. Nothing is done if the queue was replaced meanwhile.
	 */
	completeRestore(songs: Song[]) {
		const partial = this.#partial;
		this.#partial = null;
		if (!partial || this.queue !== partial.queue) return;
		const current = this.queue[0];
		// The occurrence nearest the saved position, for a queue that holds one
		// track twice. Tracks deleted since the save shift it earlier.
		let at = -1;
		songs.forEach((song, i) => {
			if (song.id === current.id && (at < 0 || Math.abs(i - partial.index) < Math.abs(at - partial.index))) at = i;
		});
		if (at < 0) return;
		const queue = [...songs];
		queue[at] = current;
		this.queue = queue;
		this.index = at;
	}
}

export const player = new Player();
