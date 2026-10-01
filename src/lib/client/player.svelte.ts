/**
 * The playback engine.
 *
 * Design notes that matter for high-resolution audio:
 *
 *  - Playback runs through a plain HTMLAudioElement, never through a Web Audio
 *    graph. An AudioContext resamples everything to its own sample rate, which
 *    would silently convert a 24/192 master down to whatever the context was
 *    opened at. Handing the raw stream to the media element instead lets the
 *    browser pass it to the platform mixer at its native rate.
 *  - Nothing is transcoded anywhere in the chain: the server proxies the
 *    original file bytes, and the element decodes them.
 *  - Two elements alternate so the next track can be buffered while the current
 *    one is still playing, which is what makes the handoff gapless-ish. See the
 *    honest caveat in the README: HTMLAudioElement cannot do sample-accurate
 *    gapless, so this is a tight handoff, not true gapless decoding.
 *  - The exception is audio processing, off unless a browser switches it on
 *    (`processing.svelte.ts`): the equaliser routes both elements through a
 *    graph at the output device's rate (`audiochain.ts`).
 */
import { browser } from '$app/environment';
import { untrack } from 'svelte';
import type { Song } from '$lib/types';
import type { UserSettings } from '$lib/server/settings';
import { AudioChain } from './audiochain';
import { coverUrl, streamUrl } from './format';

export type RepeatMode = 'off' | 'all' | 'one';

/**
 * A single silent sample. Played and immediately paused on the first real user
 * gesture so the second audio element carries its own activation — Safari and
 * Firefox grant autoplay per element, not per document, and the element that
 * takes over at a track boundary has otherwise never been touched by the user.
 *
 * A file rather than a `data:` URL. It was one until the Content-Security-
 * Policy arrived, whose `media-src 'self'` refuses `data:`: the sample never
 * loaded, the second element was never unlocked, and a phone could stop at the
 * first track boundary it reached in the background.
 */
const SILENCE = '/silence.wav';
/** A play counts as a scrobble past this fraction, matching Subsonic convention. */
const SCROBBLE_FRACTION = 0.5;
const SCROBBLE_MIN_SECONDS = 30;
/**
 * How many times a dropped stream is picked back up before the listener is told
 * about it, and how long to wait between tries.
 *
 * A stream can stop arriving for reasons that have nothing to do with the file:
 * a reverse proxy with a read timeout, an intermediary that caps how long one
 * response may take, a connection pool briefly emptied by a page full of cover
 * art, a phone changing network. The file is still there and the listener is
 * still listening, so the right response is to ask for the rest of it from
 * where we were — not to stop the music and put up a message.
 */
const RECOVERY_ATTEMPTS = 4;
const RECOVERY_BACKOFF_MS = 600;
/** How often, and how many times, a resume asks again for a position it cannot seek to yet. */
const SEEK_HOLD_MS = 1000;
const SEEK_HOLD_ATTEMPTS = 30;

/** Whether `time` is inside a range the element can seek to. */
function seekableTo(element: HTMLMediaElement, time: number): boolean {
	for (let i = 0; i < element.seekable.length; i++) {
		if (element.seekable.start(i) <= time && time <= element.seekable.end(i)) return true;
	}
	return false;
}
/**
 * Largest body sent with `keepalive`, in bytes. Half the 64KB the browser
 * allows across every in-flight keepalive request, so a play-state write and a
 * playback report leaving together both fit.
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
 * down before it pauses. The fade is stepped from `timeupdate`, which Chromium
 * fires about four times a second, so 12 seconds is about 48 steps.
 */
export const SLEEP_MINUTES = [15, 30, 45, 60, 90] as const;
const SLEEP_FADE_SECONDS = 12;

/**
 * How long the output takes to reach silence before a pause, a skip or a seek
 * through the graph, and to come back after. Pausing or moving an element
 * cuts its waveform mid-cycle, which is heard as a click; 150ms is short
 * enough to read as the press and long enough to be a fade.
 */
const DUCK_MS = 150;

/**
 * A sleep timer: pause at a time on the clock, or when the current track ends.
 * Transient, like `queueOpen`: a reload drops it.
 */
export type SleepTimer = { kind: 'at'; at: number; minutes: number } | { kind: 'track' };

/**
 * Whether `next` comes straight after `current` on the same album: the next
 * track on the same disc, or the first track of the next disc. A file without
 * a disc number is on disc 1.
 */
export function followsOnAlbum(current: Song, next: Song): boolean {
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
 * comes back twice. An entry removed since is left out. Entries added since
 * ("Play next", "Add to queue") go straight after the current track, in the
 * order they were in, since they were queued to come up; where the current
 * track is itself one of them, the added entries lead the queue.
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

export class Player {
	/** The queue in play order. Shuffling rewrites this, so it is always literal. */
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
	 * fires `pause` about 17ms before the incoming one fires `play` (measured in
	 * Chromium), and anything that followed `playing` saw playback stop and
	 * start again. The room's colour did: it went to the open page's cover and
	 * back within one fade, which showed as a flash on the rail and the player.
	 */
	engaged = $state(false);
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
	 * Whether the player panel is showing. Open by default: it replaced a bottom
	 * bar that was always on screen, so a player you have to go and find would
	 * be a step backwards. Deliberately not a stored setting — it is transient
	 * layout state, the same as `queueOpen`, and the stored settings are the
	 * ones that describe how the library behaves.
	 */
	panelOpen = $state(true);
	/**
	 * Whether the client has told us how wide the screen is.
	 *
	 * The default above is right for a screen with room for a column and wrong
	 * for one where the panel is a sheet over the page: there, open-by-default
	 * would cover the library on arrival. But it cannot simply default to closed
	 * either, because the server renders this markup before anything knows the
	 * viewport, and a panel that appears at hydration would reflow the whole
	 * grid on every page load.
	 *
	 * So the server renders the column, and the narrow-screen layout keeps the
	 * sheet hidden until this flips — which happens in `attach()`, before the
	 * first client render, so a phone never paints a sheet it was not asked for.
	 */
	viewportKnown = $state(false);
	/**
	 * Whether the panel is a sheet over the page (a phone, or a window under
	 * 60rem) rather than a column beside it. False until `attach()` has read
	 * the width, the same as `viewportKnown`. The phone dock and the sheet's
	 * drag read it; CSS decides everything that can be decided without it.
	 */
	sheetLayout = $state(false);
	sleep = $state<SleepTimer | null>(null);
	/**
	 * Which way the queue last moved: 1 forward (next, the end of a track, a
	 * new queue), -1 back (previous). The now-playing text slides in from that
	 * side. The index alone cannot tell a step back from the last track to the
	 * first from a wrap forward past the end.
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
	 * looked up: the queue it was restored as, and the saved ids and index it
	 * stands in for. Cleared by `completeRestore`, or by anything that replaces
	 * the queue.
	 */
	#partial: { queue: Song[]; ids: string[]; index: number } | null = null;
	/**
	 * While shuffle is on, the ids in the order the queue had before it was
	 * shuffled, so turning shuffle off can put it back (`unshuffled`). Saved with
	 * the queue, so it survives a reload.
	 */
	#unshuffledIds: string[] | null = null;
	/**
	 * Set while a resume waits for the position to become seekable; see
	 * `#holdForSeek`. The retries on `canplay` and on the tab coming back leave
	 * the element alone while it is set, or they would play it from the start.
	 */
	#holding = false;
	#seekHolds = 0;
	#holdTimer: ReturnType<typeof setTimeout> | null = null;
	/** Consecutive attempts to pick the current track back up after a drop. */
	#recoveries = 0;
	#recoveryTimer: ReturnType<typeof setTimeout> | null = null;
	/** Ramp timer while two tracks overlap, and when the ramp started. */
	#fadeTimer: ReturnType<typeof setInterval> | null = null;
	#fadeStartedAt = 0;
	#fadeSeconds = 0;
	/**
	 * The graph both elements play through while audio processing is on, and
	 * whether a crossfade is scheduled on it. Its ramps run on the audio
	 * thread, so there is no timer to hold while one runs.
	 */
	#chain: AudioChain | null = null;
	#chainFading = false;
	/** Fades to silence in flight; see `#duck`. The output comes back when the last one is lifted. */
	#ducks = 0;
	/** The latest press that changes the track, and the latest seek, while each waits for its fade. */
	#changeSerial = 0;
	#seekSerial = 0;
	/** Whether this page plays through the graph. */
	processing = $state(false);
	/** The output last chosen, for a graph opened after the choice. */
	#outputId = '';

	/**
	 * Whether this browser applies a `volume` set from script.
	 *
	 * iOS does not: the level belongs to the hardware buttons, a write is
	 * ignored and a read gives 1, as Apple's Safari audio guide documents. A
	 * crossfade there started the incoming track at full level, up to 12s
	 * before the outgoing one ended, which is heard as the end of a song being
	 * skipped. Read from a spare element so the playing ones are not touched.
	 */
	rampsVolume = $state(true);

	/**
	 * Whether the system offers a speaker or a TV to play on: a Chromecast
	 * through Chrome's Remote Playback API (Chrome on Android), or AirPlay
	 * through Safari. The cast button shows only while this holds.
	 */
	castAvailable = $state(false);
	/** Whether the audio is playing on one of those rather than here. */
	casting = $state(false);
	/**
	 * Cast addresses by track id while casting (`server/cast.ts`), and when
	 * they were issued. The receiver fetches the stream itself, without this
	 * browser's cookie, so each track goes to it as a signed address.
	 */
	#castUrls: Map<string, string> | null = null;
	#castUrlsAt = 0;

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
	 * Opens the system's picker for a speaker or a TV. Called from the press:
	 * both pickers need it.
	 *
	 * Chrome sends the receiver the element's address when a device is picked,
	 * so the track is moved to its cast address first. Safari opens its picker
	 * only inside the press itself, so there the address changes after a
	 * speaker is chosen, when the element reports a wireless target.
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
			// Closed without a choice, or refused: the rest of the queue goes
			// back to this browser's own addresses.
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

		// Whether there is anything to pick. Chrome on the desktop has the API
		// and refuses to watch, which leaves the button hidden.
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
	 * Moves playback to cast addresses: the current track re-opened from its
	 * own where it had got to, and nothing buffered ahead. While casting, one
	 * element plays every track, since the receiver follows the element it was
	 * picked from; the preloaded handoff and the crossfade, which alternate
	 * two, are left out.
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
		const ids = [...new Set(this.queue.slice(this.index, this.index + 1000).map((song) => song.id))].filter(
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

	/** Where the element fetches a track from: its cast address while casting. */
	#srcOf(song: Song): string {
		return this.#castUrls?.get(song.id) ?? streamUrl(song.id, this.deliveryMode);
	}

	/**
	 * Sends both elements to the audio output `deviceId`, or to the system's
	 * default for `''`. Both, since they swap roles at every track change and
	 * the one pre-buffering now is the one playing next. Rejects where the
	 * browser refuses the device; `client/output.svelte.ts` handles that.
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
	 * turning processing off applies at the next load. A browser that refuses
	 * a context leaves playback as it was.
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

	detach() {
		for (const off of this.#detachers) off();
		this.#detachers = [];
		for (const off of this.#lifecycleOff) off();
		this.#lifecycleOff = [];
		if (this.#progressTimer) clearInterval(this.#progressTimer);
		if (this.#positionTimer) clearInterval(this.#positionTimer);
		this.#cancelHold();
		this.#cancelRecovery();
		this.#abandonCrossfade();
		// Clearing the debounce timer on its own threw away whatever the last
		// change had scheduled. Write it instead.
		if (this.queue.length > 0) this.#writePlayState(true);
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
	 * one, off for one in its own order. Only `playShuffled` used to touch it,
	 * and after one shuffled play the button stayed lit, and was saved lit, over
	 * every album played in order from then on.
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

	/** Queues songs directly after the current track. */
	playNext(songs: Song[]) {
		if (songs.length === 0) return;
		if (this.queue.length === 0) {
			void this.playNow(songs);
			return;
		}
		this.queue = [
			...this.queue.slice(0, this.index + 1),
			...songs,
			...this.queue.slice(this.index + 1)
		];
		this.#invalidatePreload();
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
	 * Moves one entry to another position. The playing track keeps playing
	 * wherever it ends up, and `index` follows it.
	 *
	 * The buffered next track is only dropped when the move changed which track
	 * is next; reordering further down the queue keeps it.
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
	 * still loading. It was decided by `playing`, which follows the element
	 * and lags a press: a pause pressed just after a skip, with the next track
	 * still loading, left `playing` true for up to a second, so the play
	 * pressed next paused again and nothing played. A play that was refused
	 * (engaged, neither playing nor loading) is tried again.
	 */
	async toggle() {
		if (!this.#primary || !this.current) return;
		if (this.engaged && (this.playing || this.loading)) this.pause();
		else await this.play();
	}

	async play() {
		if (!this.#primary || !this.current) return;

		// Runs before the first await, so it is still inside the click that got us
		// here — which is the only moment the browser will grant the second
		// element an activation.
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
		// A track picked up mid-way starts mid-cycle too, so through the graph it
		// comes up from silence. A track starting from its top does not need to.
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
			// A tab that is not on screen can have play() refused even mid-queue.
			// Rather than stopping there until the user comes back and presses
			// play, remember the intent — `visibilitychange` and `canplay` both
			// retry it.
			if (typeof document !== 'undefined' && document.hidden) {
				this.playing = false;
				return;
			}
			// A pause pressed while the play was starting. That is the listener
			// changing their mind, not a failure to report.
			if (err instanceof DOMException && err.name === 'AbortError' && !this.engaged) return;
			this.error = err instanceof Error ? err.message : 'Playback failed';
			this.playing = false;
		}
	}

	/**
	 * Unlocks the second audio element with a single silent sample.
	 *
	 * Chromium grants autoplay per document, so it never needed this. Safari and
	 * Firefox grant it per element, and the element that takes over at a track
	 * boundary has never been touched by the user — so the first automatic
	 * advance would be refused, which is what "the next song does not start until
	 * I focus the tab" looks like from the outside.
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
		this.#cancelHold();
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
		// A skip discards the overlap; the end of a track consummates it.
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
				// Natural end of the queue: stop rather than wrap.
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
		// Standard transport behaviour: restart the track unless we are near the
		// very beginning, in which case step back.
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
		if (!this.#primary || !Number.isFinite(seconds)) return;
		this.#abandonCrossfade();
		const target = Math.min(Math.max(0, seconds), this.duration || seconds);
		const element = this.#primary;
		const move = () => {
			try {
				element.currentTime = target;
				this.currentTime = target;
				this.#persist();
			} catch {
				// Seeking before metadata is ready throws; ignore and let the user retry.
			}
		};
		if (!this.#fades()) {
			move();
			return;
		}
		// The bar goes to the target at once; the element follows once the output
		// is silent. Of several seeks inside one fade, a drag along the bar, only
		// the last moves it.
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
	 * element is paused or moved at once, as before.
	 */
	#fades(): boolean {
		const element = this.#primary;
		return this.#chain !== null && this.#chain.context.state === 'running' && element !== null && !element.paused;
	}

	/**
	 * Takes the output to silence over `DUCK_MS` and resolves once it is there.
	 * Each call is matched by one `#lift`. While any is in flight `timeupdate`
	 * and `ended` are not acted on: the queue may already have moved on from
	 * the track the element is still playing out.
	 */
	#duck(): Promise<void> {
		this.#ducks++;
		this.#chain?.duck(DUCK_MS / 1000);
		return new Promise((resolve) => setTimeout(resolve, DUCK_MS));
	}

	/**
	 * Ends one fade. When it was the last in flight the output comes back: at
	 * once if `now` or if nothing is playing, and over `DUCK_MS` under a track
	 * that carries on from where it was.
	 */
	#lift(now = false) {
		this.#ducks = Math.max(0, this.#ducks - 1);
		if (this.#ducks > 0) return;
		const element = this.#primary;
		this.#chain?.unduck(now || !element || element.paused ? 0 : DUCK_MS / 1000);
	}

	/**
	 * Loads the current track after a press that changed it, fading out what
	 * is playing first where `#fades`. Of several presses inside one fade only
	 * the last loads. A pause pressed inside the fade is kept: the track loads
	 * and does not start.
	 */
	async #changeTrack() {
		if (!this.#fades()) {
			await this.#loadCurrent(true);
			return;
		}
		const serial = ++this.#changeSerial;
		// A skip is a decision to keep listening, as it is without the fade,
		// including one pressed while a pause was still fading out.
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

	seekByFraction(fraction: number) {
		if (this.duration > 0) this.seek(fraction * this.duration);
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
	 * Shuffling rewrites the queue, so what the queue panel shows is always what
	 * will actually play next. The order it had is kept beside it, and turning
	 * shuffle off puts the queue back in that order around the playing track,
	 * with edits made in the meantime kept (`unshuffled`). It used to leave the
	 * queue shuffled, which read as the button doing nothing.
	 */
	toggleShuffle() {
		this.shuffle = !this.shuffle;
		if (this.shuffle) {
			// A queue still being restored holds only its current track; the saved
			// ids are its real order.
			this.#unshuffledIds = this.#partial ? [...this.#partial.ids] : this.queue.map((song) => song.id);
			if (this.queue.length > 1) {
				// The track that is playing stays put; everything else is reordered
				// around it, so turning shuffle on never interrupts the audio.
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
				// queue itself is left as it is: it is the one track, and replacing
				// the array would make `completeRestore` think the queue was changed.
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
		// The queue shows inside the panel now, so asking for it has to open the
		// thing it lives in — otherwise the toggle silently does nothing.
		if (this.queueOpen) this.panelOpen = true;
	}

	togglePanel() {
		this.panelOpen = !this.panelOpen;
	}

	/**
	 * Sets the sleep timer: a number of minutes from now, `'track'` for the end
	 * of the current track, or `null` to cancel it. Cancelling during the fade
	 * puts the level back at once.
	 */
	setSleep(choice: number | 'track' | null) {
		if (choice === null) this.sleep = null;
		else if (choice === 'track') this.sleep = { kind: 'track' };
		else this.sleep = { kind: 'at', at: Date.now() + choice * 60_000, minutes: choice };
		this.#applyVolume();
	}

	/**
	 * Where the panel is a sheet over the page rather than a column beside it,
	 * it starts closed — arriving at your library with the player covering it is
	 * not a player, it is a door. The breakpoint is the one the layout uses to
	 * switch between the two, and it is watched rather than read once so that
	 * rotating a tablet does not leave the sheet stuck open over the content.
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
		// `#lifecycleOff`, not `#detachers`: the latter is emptied every time
		// `#bind` moves to the other audio element, so after the first gapless
		// track change this listener was gone and rotating a tablet no longer
		// switched the panel between a column and a sheet.
		this.#lifecycleOff.push(() => sheet.removeEventListener('change', apply));
	}

	// ── Internals ──────────────────────────────────────────────────────────

	/**
	 * Loads the current track.
	 *
	 * `resume` is for the one caller that means it: a queue restored from the
	 * server has a position recorded with it, and the first `play()` is what
	 * finally loads the file. Every other caller is a track the listener just
	 * chose, and those start at the beginning. Without the distinction the
	 * restored position survived into the next explicit load, so pressing Play
	 * on an album after a reload started its first track wherever the previous
	 * session had stopped. Harmless while the stored position was a second or
	 * two stale; now that it tracks playback, it would be minutes.
	 */
	async #loadCurrent(autoplay: boolean, resume = false) {
		const song = this.current;
		if (!song || !this.#primary) return;

		if (!resume) this.#pendingSeek = null;
		this.#cancelHold();

		// The ramp addresses `#primary` and `#secondary` by reference, and the
		// swap below exchanges them. A timer that outlived that swap would go on
		// ramping the two elements in the wrong direction.
		this.#endCrossfade();

		this.#cancelRecovery();
		this.#recoveries = 0;
		this.#scrobbled = false;
		this.#startReported = false;
		this.currentTime = 0;
		this.duration = song.duration || 0;
		this.error = null;

		// If the next track was already buffered into the secondary element, swap
		// the elements instead of re-fetching. This is what makes the transition
		// tight rather than a fresh network round trip mid-song.
		if (this.#preloadedFor === song.id && this.#secondary?.src) {
			this.#swapElements();
		} else {
			this.loading = true;
			// A track that has come into the queue since casting began needs an
			// address of its own first.
			if (this.#castUrls && !this.#castUrls.has(song.id)) {
				await this.#ensureCastUrls();
				if (this.current !== song || !this.#primary) return;
			}
			this.#primary.src = this.#srcOf(song);
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
	 * squares sum to one throughout. A linear pair would sum to one in
	 * *amplitude* instead, which dips about 3 dB in the middle and is heard as a
	 * hole rather than a join.
	 *
	 * The ramp runs on an interval rather than `requestAnimationFrame`: rAF is
	 * throttled to a stop in a background tab, which is precisely where an
	 * unattended queue does its crossfading.
	 */
	#maybeCrossfade() {
		if (this.#fadeTimer !== null || this.#chainFading) return;
		const settings = this.settings;
		if (!settings || settings.transition !== 'crossfade') return;
		if (this.#castUrls) return;
		// Without a ramp this would be two tracks at full level. The `ended`
		// handler makes the tight handoff instead, from the buffered element.
		// The graph's gains are applied where `volume` is not, as on iOS.
		if (!this.rampsVolume && !this.#chain) return;
		// Repeating one track would have to fade an element into itself.
		if (this.repeat === 'one') return;
		// The next track would start before the `ended` handler could stop there.
		if (this.sleep?.kind === 'track') return;

		const outgoing = this.#primary;
		const incoming = this.#secondary;
		if (!outgoing || !incoming || !this.playing) return;

		const next = this.upNext ?? (this.repeat === 'all' ? this.queue[0] : null);
		if (!next || this.#preloadedFor !== next.id) return;
		// Two tracks written to run into each other (a live album, a mix) get the
		// tight handoff, unless the account asks for a fade there too.
		if (!settings.crossfadeWithinAlbum && this.current && followsOnAlbum(this.current, next)) return;
		// Not buffered far enough to start without a stall; the `ended` handler
		// will make an ordinary cut instead.
		if (incoming.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) return;

		const remaining = this.duration - this.currentTime;
		const seconds = Math.min(settings.crossfadeSeconds, Math.max(1, this.duration / 2));
		if (!Number.isFinite(remaining) || remaining > seconds || remaining <= 0) return;

		// `timeupdate` is coarse, so the window is usually entered a little late.
		// Ramping over what is actually left, rather than over the configured
		// length, keeps the end of the ramp on the end of the track.
		this.#fadeSeconds = remaining;
		this.#fadeStartedAt = Date.now();
		incoming.currentTime = 0;

		const chain = this.#chain;
		if (chain) {
			// The whole ramp at once, on the audio thread. The elements stay at
			// full `volume`; the level is the graph's.
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
		// when the two tracks were mastered at different loudness.
		outgoing.volume = level * this.#gainFor(this.current) * Math.cos((t * Math.PI) / 2);
		incoming.volume = level * this.#gainFor(this.#preloadedSong()) * Math.sin((t * Math.PI) / 2);

		// The ramp only moves the two gains. Advancing the queue stays the job of
		// the outgoing element's `ended` event — which fires at the end of the
		// ramp by construction, since the fade is started with `remaining`
		// seconds left and runs for exactly that long. Letting the ramp advance
		// as well raced that event, and skipped a track whenever it won.
		if (t >= 1) this.#clearFadeTimer();
	}

	/**
	 * Stops the ramp and leaves both elements exactly as they are.
	 *
	 * This is the consummated ending: the outgoing track has run out, the
	 * incoming one is already playing at full level, and the element swap is
	 * about to make it the primary. Rewinding anything here would restart the
	 * track the listener is already hearing.
	 */
	#endCrossfade() {
		this.#clearFadeTimer();
		this.#chainFading = false;
	}

	/**
	 * Abandons an overlap the listener interrupted — a pause, a skip, a seek, a
	 * change to the queue. The buffered track has to go back to its start,
	 * because whatever happens next expects to play it from the top rather than
	 * from wherever the ramp had reached.
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
				// Seeking an element whose src was just dropped throws; harmless.
			}
		}
		this.#applyVolume();
	}

	/**
	 * Waits, silent, for a position the element cannot seek to yet, and asks
	 * for the track again.
	 *
	 * A transcode is read whole on the server before it can be answered in
	 * ranges (`transcodes.ts`), which takes seconds; until then it arrives as a
	 * stream without ranges, and a seek into it lands nowhere. Resuming a track
	 * at a position (after a dropped stream, a restored queue, or transcoding
	 * switched on mid-track) then played it from the start: heard as the song
	 * starting over, most often with the tab in the background, where a stream
	 * is most often dropped. So the element is paused and asked again every
	 * second, up to 30 times (a 10-minute AAC transcode was read whole in 17s),
	 * with a query the server ignores so that the browser does not answer from
	 * its own copy. After that it plays from the start, as it did.
	 */
	#cancelHold() {
		if (this.#holdTimer !== null) clearTimeout(this.#holdTimer);
		this.#holdTimer = null;
		this.#holding = false;
		this.#seekHolds = 0;
	}

	#holdForSeek(element: HTMLAudioElement) {
		const song = this.current;
		if (!song) return;
		this.#holding = true;
		this.loading = true;
		element.pause();
		if (this.#holdTimer !== null) clearTimeout(this.#holdTimer);
		this.#holdTimer = setTimeout(() => {
			this.#holdTimer = null;
			if (this.#primary !== element || this.current !== song || this.#pendingSeek === null || !this.engaged) {
				this.#holding = false;
				return;
			}
			this.#seekHolds += 1;
			const src = this.#srcOf(song);
			element.src = `${src}${src.includes('?') ? '&' : '?'}attempt=${this.#seekHolds}`;
			element.load();
		}, SEEK_HOLD_MS);
	}

	/**
	 * Asks for the rest of the current track from where it stopped arriving.
	 *
	 * `playing` is deliberately left alone. This is a gap in the audio, not a
	 * stop: flipping the transport to a play button would tell the listener the
	 * opposite of what is happening, and `loading` already puts a spinner on the
	 * button. The position is carried across by the same `#pendingSeek` the
	 * server-restored queue uses, because the seek cannot happen until the
	 * reloaded element knows how long the file is.
	 */
	#recoverStream() {
		const element = this.#primary;
		const song = this.current;
		if (!element || !song) return;

		const position = this.currentTime;
		this.#recoveries += 1;
		this.loading = true;
		this.#cancelRecovery();
		// Backing off matters: a proxy that just cut one response will cut the
		// next one too if we ask again immediately.
		this.#recoveryTimer = setTimeout(() => {
			this.#recoveryTimer = null;
			// The listener pressed pause while we were waiting. Their call wins.
			if (!this.engaged || this.#primary !== element) return;
			this.#pendingSeek = position;
			element.src = this.#srcOf(song);
			element.load();
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
	 * Starts the server reading the next track's transcode as this one
	 * starts, with a HEAD request that downloads nothing.
	 *
	 * The server answers a transcode in ranges only once it has read it whole
	 * (`transcodes.ts`), and until then as a stream without ranges, which a
	 * browser cannot seek into or pick back up at a position. The next track is
	 * preloaded 20 seconds before its turn; started here, its read is whole by
	 * then (2.7 to 17 seconds measured), so the element that plays it has ranges
	 * from the first byte and a stream that drops can be resumed. Original
	 * files are answered in ranges by the music server itself and need none of
	 * this.
	 */
	#warmNext() {
		if (!browser || !this.settings?.transcode) return;
		const next = this.upNext ?? (this.repeat === 'all' ? this.queue[0] : null);
		if (!next || next.id === this.current?.id) return;
		void fetch(streamUrl(next.id, this.deliveryMode), { method: 'HEAD' }).catch(() => undefined);
	}

	/** Buffers the upcoming track so the handoff does not wait on the network. */
	#maybePreloadNext() {
		if (!this.settings?.preloadNext || this.settings.transition === 'off') return;
		// Casting follows one element; see `#beginCast`.
		if (this.#castUrls) return;
		const next = this.upNext ?? (this.repeat === 'all' ? this.queue[0] : null);
		if (!next || !this.#secondary) return;
		if (this.#preloadedFor === next.id) return;
		// Only worth doing once we are actually close to the end.
		if (this.duration > 0 && this.duration - this.currentTime > 20) return;

		this.#preloadedFor = next.id;
		this.#secondary.src = streamUrl(next.id, this.deliveryMode);
		this.#secondary.preload = 'auto';
		this.#secondary.load();
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
			// The element's own duration is authoritative; the server's is a hint.
			if (Number.isFinite(element.duration) && element.duration > 0) {
				this.duration = element.duration;
			}
			this.loading = false;
			// A queue restored from the server resumes where it left off, but the
			// seek can only happen once the element knows how long the file is.
			if (this.#pendingSeek !== null) {
				const target = this.#pendingSeek;
				const wanted = target > 1 && target < this.duration - 1;
				if (wanted && !seekableTo(element, target) && this.#seekHolds < SEEK_HOLD_ATTEMPTS) {
					this.#holdForSeek(element);
					return;
				}
				this.#pendingSeek = null;
				this.#seekHolds = 0;
				this.#holding = false;
				if (wanted) this.seek(target);
				if (this.engaged && element.paused) void element.play().catch(() => undefined);
			}
		});

		on('timeupdate', () => {
			if (this.#ducks > 0) return;
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
			// Sound is coming out, so whatever went wrong is behind us and the next
			// drop gets a full set of attempts of its own.
			this.#recoveries = 0;
			this.error = null;
		});

		on('canplay', () => {
			// The track is ready but we are not playing and the user never asked us
			// to stop: an earlier play() was refused, so try again now.
			if (this.engaged && element.paused && !this.#holding) void element.play().catch(() => undefined);
		});

		on('ended', () => {
			if (this.#ducks > 0) return;
			this.#reportStop(true);
			if (this.sleep?.kind === 'track') void this.#sleepAtTrackEnd();
			else void this.next(false);
		});

		on('error', () => {
			const code = element.error?.code;
			// A codec this browser cannot handle, or bytes it cannot decode, will
			// not start working because we asked again. Everything else is worth
			// another try: the usual cause is the transport, not the file.
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
		// Untracked. This reads the queue and the settings, and it is called
		// from inside effects (`attach`, the layout's settings effect). Tracked,
		// those reads made the effect that attaches the player depend on them,
		// so the settings arriving with every navigation re-ran it, and its
		// teardown detached the player: every page change stopped the music.
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
	 * Applied through each element's `volume`, which is a multiplier from 0 to 1,
	 * so a correction can lower a track and cannot raise one. Most commercial
	 * releases carry a negative track gain (about -6 to -10 dB against the
	 * 89 dB reference), so in practice loud records come down to meet quiet
	 * ones. With audio processing on, the correction is a gain in the graph
	 * instead (`audiochain.ts`), and a quiet track is raised as far as its peak
	 * allows. A track without a peak value is not raised.
	 *
	 * Track gain is used, with album gain as the fallback. The peak caps the
	 * factor so a correction cannot push the loudest sample past full scale. A
	 * file without data plays unchanged.
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
	 * `SLEEP_FADE_SECONDS`, then down to 0 on the same quarter-cosine the
	 * crossfade uses.
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
	 * Driven by `timeupdate` rather than a timer of its own: a timer in a
	 * background tab can be throttled, and `timeupdate` keeps firing for as long
	 * as there is sound to fade. A timer that runs out while paused does nothing
	 * until playback resumes, and `play()` clears it then.
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
	 * Stops at the end of a track, with the next one loaded and not playing, so
	 * pressing play carries on from where the queue had reached.
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
		// Half the track, capped at four minutes, and never before 30 seconds —
		// the same rule Subsonic clients and Last.fm have used for years.
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
	 * was in the background. Without this the queue silently stalls until the
	 * user returns and presses play again.
	 */
	#watchVisibility() {
		if (!browser) return;
		const resume = () => {
			if (!this.engaged || document.hidden) return;
			const element = this.#primary;
			if (element && element.src && element.paused && !this.#holding) {
				void element.play().catch(() => undefined);
			}
		};

		/*
		 * Save the position on the way out, so a reload or a tab the system
		 * takes away resumes where the listener was rather than at the last
		 * ten-second tick.
		 *
		 * Both events are needed. `pagehide` covers a reload and a real
		 * navigation away; hiding covers iOS, where Safari can freeze or discard
		 * a backgrounded tab without firing anything else first. Writing twice
		 * costs one request and the endpoint replaces the row either way.
		 */
		const flush = () => {
			if (this.queue.length > 0) this.#writePlayState(true);
		};
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
		 * The stored position has to keep up with playback, not just with queue
		 * edits.
		 *
		 * Every other write happens because something changed: a track was
		 * chosen, the queue was edited, playback was paused. Listening changes
		 * nothing, so a track played straight through left the server holding
		 * the position from just after it started. Measured before this: 34
		 * seconds of uninterrupted playback and the stored position had not
		 * moved off 67.2s, and the drift grows for as long as you listen. Any
		 * full page load then resumed that far back, which is what "it reset to
		 * the beginning" is.
		 *
		 * Ten seconds is the worst case lost to a crash or a killed tab. An
		 * ordinary reload or a backgrounded tab loses nothing, because
		 * `#watchVisibility` flushes on the way out.
		 */
		this.#positionTimer = setInterval(() => {
			if (this.playing && this.current) this.#writePlayState();
		}, 10_000);
	}

	#report(event: 'start' | 'progress' | 'stop', position: number, completed = false) {
		if (!browser || !this.current || this.settings?.reportPlayback === false) return;
		const body = JSON.stringify({ songId: this.current.id, event, position, completed });
		// `keepalive` so a report fired during unload still leaves the browser.
		void fetch('/api/playback', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body,
			keepalive: true
		}).catch(() => undefined);
	}

	// ── Persistence ────────────────────────────────────────────────────────

	/** Debounced so scrubbing does not hammer the server. */
	/** Debounced, for a burst of queue edits. */
	#persist() {
		if (!browser) return;
		if (this.#persistTimer) clearTimeout(this.#persistTimer);
		this.#persistTimer = setTimeout(() => this.#writePlayState(), 1200);
	}

	/**
	 * Writes the queue and the position immediately.
	 *
	 * `keepalive` is for the writes made on the way out, where the page is being
	 * unloaded or frozen and an ordinary fetch would be cancelled with it.
	 */
	#writePlayState(keepalive = false) {
		if (!browser) return;
		if (this.#persistTimer) clearTimeout(this.#persistTimer);
		this.#persistTimer = null;
		// While a restore holds only the current track, a write carries the queue
		// it stands in for. Written as it stands, a play pressed before the rest
		// arrived saved a queue of one track over the saved one.
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
			// Browsers cap the total of all in-flight keepalive bodies at 64KB
			// and reject anything past it outright. A queue is capped at 1000
			// ids, which is about 39KB of JSON at the length a Navidrome or
			// Jellyfin id actually is, but the server accepts ids up to 255
			// characters. Over the threshold, an ordinary request that the
			// unload may cut short beats one the browser will not send at all.
			keepalive: keepalive && body.length <= KEEPALIVE_LIMIT
		}).catch(() => undefined);
	}

	/**
	 * How audio is being asked for, as a string for the URL.
	 *
	 * Part of the URL rather than a header so the browser's own cache keys on
	 * it: the original file, already fetched and held, would otherwise answer
	 * the first request made after transcoding was switched on.
	 */
	get deliveryMode(): string {
		const settings = this.settings;
		if (!settings?.transcode) return 'raw';
		return `${settings.transcodeCodec}-${settings.transcodeBitrateKbps}`;
	}

	/**
	 * Switches transcoding on or off without interrupting what is playing.
	 *
	 * The track is re-opened in the new mode at the position it had reached. A
	 * transcode starts at the beginning of the file whatever the request asks
	 * for on some servers, so the seek is re-applied once the new source is
	 * ready rather than assumed; that is what `#pendingSeek` is for. Anything
	 * already buffered ahead is in the old mode and is thrown away.
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
		this.#pendingSeek = position;
		element.src = this.#srcOf(song);
		element.load();
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
	 * the saved queue is still being looked up; `completeRestore` puts it in.
	 */
	async restore(
		songs: Song[],
		state: { index: number; position: number; repeat: RepeatMode; shuffle: boolean; orderIds?: string[] },
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
		// Deliberately no src assignment: browsers block autoplay anyway, and
		// loading a 100 MB FLAC nobody asked for is rude. The first play() call
		// takes care of it.
	}

	/**
	 * Puts the rest of a partly restored queue in, around the track already
	 * there, without touching what is playing.
	 *
	 * The current track keeps its object, so nothing that follows it sees a
	 * change of track. Nothing is done if the queue was replaced in the
	 * meantime: the listener chose something else to play.
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
