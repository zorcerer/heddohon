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
 */
import { browser } from '$app/environment';
import { untrack } from 'svelte';
import type { Song } from '$lib/types';
import type { UserSettings } from '$lib/server/settings';
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
/**
 * The sleep timer's lengths in minutes, and how long the level takes to come
 * down before it pauses. The fade is stepped from `timeupdate`, which Chromium
 * fires about four times a second, so 12 seconds is about 48 steps.
 */
export const SLEEP_MINUTES = [15, 30, 45, 60, 90] as const;
const SLEEP_FADE_SECONDS = 12;

/**
 * A sleep timer: pause at a time on the clock, or when the current track ends.
 * Transient, like `queueOpen`: a reload drops it.
 */
export type SleepTimer = { kind: 'at'; at: number; minutes: number } | { kind: 'track' };

/** Fisher-Yates, in place on a copy. */
function shuffled<T>(items: T[]): T[] {
	const out = [...items];
	for (let i = out.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[out[i], out[j]] = [out[j], out[i]];
	}
	return out;
}

interface PersistPayload {
	songIds: string[];
	index: number;
	position: number;
	repeat: RepeatMode;
	shuffle: boolean;
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
	 * Whether this browser applies a `volume` set from script.
	 *
	 * iOS does not: the level belongs to the hardware buttons, a write is
	 * ignored and a read gives 1, as Apple's Safari audio guide documents. A
	 * crossfade there started the incoming track at full level, up to 12s
	 * before the outgoing one ended, which is heard as the end of a song being
	 * skipped. Read from a spare element so the playing ones are not touched.
	 */
	rampsVolume = $state(true);

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

	/** Replaces the queue and starts at `startAt`. */
	async playNow(songs: Song[], startAt = 0) {
		if (songs.length === 0) return;
		this.direction = 1;
		this.queue = [...songs];
		this.index = Math.min(Math.max(0, startAt), songs.length - 1);
		this.#preloadedFor = null;
		await this.#loadCurrent(true);
		this.#persist();
	}

	/** Replaces the queue with a shuffled copy and starts it. */
	async playShuffled(songs: Song[]) {
		if (songs.length === 0) return;
		this.shuffle = true;
		await this.playNow(shuffled(songs));
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

	clearQueue() {
		this.stop();
		this.queue = [];
		this.index = 0;
		this.#persist();
	}

	async jumpTo(position: number) {
		if (position < 0 || position >= this.queue.length) return;
		this.direction = position >= this.index ? 1 : -1;
		this.index = position;
		this.#invalidatePreload();
		await this.#loadCurrent(true);
		this.#persist();
	}

	// ── Transport ──────────────────────────────────────────────────────────

	async toggle() {
		if (!this.#primary || !this.current) return;
		if (this.playing) this.pause();
		else await this.play();
	}

	async play() {
		if (!this.#primary || !this.current) return;

		// Runs before the first await, so it is still inside the click that got us
		// here — which is the only moment the browser will grant the second
		// element an activation.
		this.#primeSecondary();
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
		try {
			await this.#primary.play();
			this.error = null;
		} catch (err) {
			// A tab that is not on screen can have play() refused even mid-queue.
			// Rather than stopping there until the user comes back and presses
			// play, remember the intent — `visibilitychange` and `canplay` both
			// retry it.
			if (typeof document !== 'undefined' && document.hidden) {
				this.playing = false;
				return;
			}
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
		this.#primary?.pause();
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

		await this.#loadCurrent(true);
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
		await this.#loadCurrent(true);
		this.#persist();
	}

	seek(seconds: number) {
		if (!this.#primary || !Number.isFinite(seconds)) return;
		this.#abandonCrossfade();
		const target = Math.min(Math.max(0, seconds), this.duration || seconds);
		try {
			this.#primary.currentTime = target;
			this.currentTime = target;
			this.#persist();
		} catch {
			// Seeking before metadata is ready throws; ignore and let the user retry.
		}
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
	 * Shuffling rewrites the queue rather than keeping a shadow order, so what
	 * the queue panel shows is always what will actually play next. Turning it
	 * off does not restore the original order — that would be a lie about a
	 * queue the user may have edited since.
	 */
	toggleShuffle() {
		this.shuffle = !this.shuffle;
		if (this.shuffle && this.queue.length > 1) {
			// The track that is playing stays put; everything else is reordered
			// around it, so turning shuffle on never interrupts the audio.
			const current = this.queue[this.index];
			const rest = shuffled(this.queue.filter((_, i) => i !== this.index));
			this.queue = [current, ...rest];
			this.index = 0;
		}
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
			this.#primary.src = streamUrl(song.id, this.deliveryMode);
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
		if (this.#fadeTimer !== null) return;
		const settings = this.settings;
		if (!settings || settings.transition !== 'crossfade') return;
		// Without a ramp this would be two tracks at full level. The `ended`
		// handler makes the tight handoff instead, from the buffered element.
		if (!this.rampsVolume) return;
		// Repeating one track would have to fade an element into itself.
		if (this.repeat === 'one') return;
		// The next track would start before the `ended` handler could stop there.
		if (this.sleep?.kind === 'track') return;

		const outgoing = this.#primary;
		const incoming = this.#secondary;
		if (!outgoing || !incoming || !this.playing) return;

		const next = this.upNext ?? (this.repeat === 'all' ? this.queue[0] : null);
		if (!next || this.#preloadedFor !== next.id) return;
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
	}

	/**
	 * Abandons an overlap the listener interrupted — a pause, a skip, a seek, a
	 * change to the queue. The buffered track has to go back to its start,
	 * because whatever happens next expects to play it from the top rather than
	 * from wherever the ramp had reached.
	 */
	#abandonCrossfade() {
		if (this.#fadeTimer === null) return;
		this.#clearFadeTimer();
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
			element.src = `${streamUrl(song.id, this.deliveryMode)}&attempt=${this.#seekHolds}`;
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
			element.src = streamUrl(song.id, this.deliveryMode);
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
	 * ones. Raising a quiet track would need Web Audio between the element and
	 * the speakers, which changes the whole playback path, including the
	 * background playback iOS allows a plain `<audio>` element.
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
			shuffle: this.shuffle
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

		const element = this.#primary;
		const song = this.current;
		if (!element || !song) return;

		const position = this.currentTime;
		const wasPlaying = this.playing;
		this.loading = true;
		this.#pendingSeek = position;
		element.src = streamUrl(song.id, this.deliveryMode);
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
		state: { index: number; position: number; repeat: RepeatMode; shuffle: boolean },
		partial?: { ids: string[]; index: number }
	) {
		if (songs.length === 0) return;
		this.queue = songs;
		this.#partial = partial ? { queue: this.queue, ids: partial.ids, index: partial.index } : null;
		this.index = Math.min(Math.max(0, state.index), songs.length - 1);
		this.repeat = state.repeat;
		this.shuffle = state.shuffle;
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
