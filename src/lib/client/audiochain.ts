/**
 * The optional Web Audio path: the equaliser, ReplayGain that can raise a
 * track, and a crossfade whose ramps run on the audio thread.
 *
 * Off unless it is switched on in this browser (`processing.svelte.ts`).
 * While off, nothing here is created and the two audio elements play straight
 * to the output, as `player.svelte.ts` describes.
 *
 *   element A ─ side gain ─┐
 *                          ├─ preamp ─ correction ─ 10 peaking bands ─ level ─ duck ─ output
 *   element B ─ side gain ─┘
 *
 * The side gains carry each track's ReplayGain and the crossfade; the level
 * carries the volume, mute and the sleep timer's fade; the duck goes to
 * silence and back around a pause, a skip and a seek. The correction is the
 * headphone's own filters (`$lib/autoeq`), none unless one is chosen.
 *
 * Measured in Chromium, Firefox and WebKit on 29 September 2026 (issue #32):
 *
 *  - An element joins a graph once. A second `createMediaElementSource` on it
 *    throws in Chromium and WebKit, in a new context as well, so switching this
 *    off takes effect at the next page load and a context is never reopened.
 *  - The context opens at its default rate, the output device's. The browser
 *    converts a playing element to that rate on its way out in any case; a
 *    context opened at the track's rate would be converted again.
 *  - Ten bands, a preamp and two gains cost 0.29% to 0.44% of real time for
 *    stereo at 48 kHz.
 *  - `AudioContext.setSinkId` exists in Chromium only. Firefox sends the graph
 *    to a chosen output through a stream played by an element of its own.
 */
import type { Correction } from '$lib/autoeq';

/** Band centres in Hz, the ISO octaves from 31 Hz to 16 kHz. */
export const EQ_FREQUENCIES = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000] as const;
/** One octave wide at each centre. */
const EQ_Q = 1.41;
/** Bands are set within this many dB either way. */
export const EQ_RANGE_DB = 12;
/**
 * How long a change of level takes to settle, as the time constant of
 * `setTargetAtTime`. A level written in one step clicks; 15ms is below what
 * is heard as a fade.
 */
const LEVEL_SMOOTHING_S = 0.015;
/** How long the context runs on after a pause before it lets the device go. */
const SUSPEND_AFTER_MS = 30_000;
/** Points on each crossfade curve. */
const CURVE_POINTS = 256;

type SinkContext = AudioContext & { setSinkId?: (id: string) => Promise<void> };

export class AudioChain {
	readonly context: SinkContext;
	#sides = new Map<HTMLMediaElement, GainNode>();
	#preamp: GainNode;
	/** The headphone correction's filters, between the preamp and the bands. */
	#correction: BiquadFilterNode[] = [];
	/** dB the preamp is lowered by for the bands' largest boost, and moved by for the correction. */
	#bandBoost = 0;
	#correctionPreamp = 0;
	#bands: BiquadFilterNode[];
	#level: GainNode;
	#duck: GainNode;
	/** Firefox's route to a chosen output, while one is chosen. */
	#stream: { node: MediaStreamAudioDestinationNode; element: HTMLAudioElement } | null = null;
	#suspendTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(elements: HTMLMediaElement[]) {
		this.context = new AudioContext();
		this.#preamp = this.context.createGain();
		this.#bands = EQ_FREQUENCIES.map((frequency) => {
			const band = this.context.createBiquadFilter();
			band.type = 'peaking';
			band.frequency.value = frequency;
			band.Q.value = EQ_Q;
			band.gain.value = 0;
			return band;
		});
		this.#level = this.context.createGain();

		let node: AudioNode = this.#preamp;
		for (const band of this.#bands) {
			node.connect(band);
			node = band;
		}
		node.connect(this.#level);
		this.#duck = this.context.createGain();
		this.#level.connect(this.#duck);
		this.#duck.connect(this.context.destination);

		for (const element of elements) {
			const side = this.context.createGain();
			this.context.createMediaElementSource(element).connect(side);
			side.connect(this.#preamp);
			this.#sides.set(element, side);
		}
	}

	/**
	 * Sets the ten bands, in dB. The preamp comes down by the largest boost, so
	 * a boosted band cannot take a full-scale track past full scale.
	 */
	setEqualiser(gains: readonly number[]) {
		const now = this.context.currentTime;
		this.#bands.forEach((band, i) => band.gain.setTargetAtTime(gains[i] ?? 0, now, LEVEL_SMOOTHING_S));
		this.#bandBoost = Math.max(0, ...gains);
		this.#setPreamp();
	}

	/**
	 * Puts a headphone correction ahead of the bands, or takes it out for null:
	 * one biquad per filter, and its preamp added to the graph's. AutoEq works
	 * the preamp out so that the filters cannot take a full-scale track past
	 * full scale. A shelf has the slope `BiquadFilterNode` gives every shelf,
	 * which is the Q of 0.71 AutoEq writes; its `Q` is not read.
	 */
	setCorrection(correction: Correction | null) {
		this.#preamp.disconnect();
		for (const filter of this.#correction) filter.disconnect();
		this.#correction = (correction?.filters ?? []).map((spec) => {
			const filter = this.context.createBiquadFilter();
			filter.type = spec.type;
			filter.frequency.value = spec.frequency;
			filter.gain.value = spec.gain;
			filter.Q.value = spec.q;
			return filter;
		});
		let node: AudioNode = this.#preamp;
		for (const filter of this.#correction) {
			node.connect(filter);
			node = filter;
		}
		node.connect(this.#bands[0]);
		this.#correctionPreamp = correction?.preamp ?? 0;
		this.#setPreamp();
	}

	#setPreamp() {
		const db = this.#correctionPreamp - this.#bandBoost;
		this.#preamp.gain.setTargetAtTime(10 ** (db / 20), this.context.currentTime, LEVEL_SMOOTHING_S);
	}

	/** The volume, mute and the sleep timer's fade, as one factor. */
	setLevel(value: number) {
		this.#level.gain.setTargetAtTime(value, this.context.currentTime, LEVEL_SMOOTHING_S);
	}

	/**
	 * Takes the output to silence over `seconds`, or at once for 0. An element
	 * paused, moved or given another source mid-cycle cuts the waveform where it
	 * stands, which is heard as a click; at silence there is nothing to cut.
	 */
	duck(seconds: number) {
		this.#rampDuck(0, seconds);
	}

	/** Brings the output back over `seconds`, or at once for 0. */
	unduck(seconds: number) {
		this.#rampDuck(1, seconds);
	}

	#rampDuck(to: number, seconds: number) {
		const gain = this.#duck.gain;
		const now = this.context.currentTime;
		gain.cancelScheduledValues(now);
		if (seconds <= 0) {
			gain.setValueAtTime(to, now);
			return;
		}
		gain.setValueAtTime(gain.value, now);
		gain.linearRampToValueAtTime(to, now + seconds);
	}

	/** One element's own gain: its track's ReplayGain. Cancels a ramp in progress on it. */
	setSide(element: HTMLMediaElement, value: number) {
		const gain = this.#sides.get(element)?.gain;
		if (!gain) return;
		const now = this.context.currentTime;
		gain.cancelScheduledValues(now);
		gain.setValueAtTime(gain.value, now);
		gain.setTargetAtTime(value, now, LEVEL_SMOOTHING_S);
	}

	/** Puts an element's gain at `value` at once, for a track about to start from silence. */
	holdSide(element: HTMLMediaElement, value: number) {
		const gain = this.#sides.get(element)?.gain;
		if (!gain) return;
		gain.cancelScheduledValues(this.context.currentTime);
		gain.value = value;
	}

	/**
	 * Ramps `outgoing` from `from` to silence and `incoming` from silence to
	 * `to` over `seconds`, on the equal-power pair `cos` and `sin` the element
	 * path uses. Scheduled on the audio thread, so a timer throttled in a
	 * background tab does not step it.
	 */
	crossfade(outgoing: HTMLMediaElement, incoming: HTMLMediaElement, from: number, to: number, seconds: number) {
		const down = this.#sides.get(outgoing)?.gain;
		const up = this.#sides.get(incoming)?.gain;
		if (!down || !up) return;
		const now = this.context.currentTime;
		const curve = (scale: number, shape: (x: number) => number) =>
			Float32Array.from({ length: CURVE_POINTS }, (_, i) => scale * shape(((i / (CURVE_POINTS - 1)) * Math.PI) / 2));
		for (const gain of [down, up]) gain.cancelScheduledValues(now);
		down.setValueCurveAtTime(curve(from, Math.cos), now, seconds);
		up.setValueCurveAtTime(curve(to, Math.sin), now, seconds);
	}

	/** Starts the context, or keeps it running. Called on every play. */
	resume() {
		if (this.#suspendTimer !== null) clearTimeout(this.#suspendTimer);
		this.#suspendTimer = null;
		if (this.context.state !== 'running') void this.context.resume().catch(() => undefined);
	}

	/** Lets the output device go once playback has stayed paused for `SUSPEND_AFTER_MS`. */
	suspendSoon() {
		if (this.#suspendTimer !== null) clearTimeout(this.#suspendTimer);
		this.#suspendTimer = setTimeout(() => {
			this.#suspendTimer = null;
			void this.context.suspend().catch(() => undefined);
		}, SUSPEND_AFTER_MS);
	}

	/**
	 * Sends the graph to the output `deviceId`, or to the system default for
	 * `''`. `setSinkId` on a routed element moves nothing, since its sound no
	 * longer leaves through the element.
	 */
	async setOutput(deviceId: string): Promise<void> {
		if (typeof this.context.setSinkId === 'function') {
			await this.context.setSinkId(deviceId);
			return;
		}
		if (!deviceId) {
			if (!this.#stream) return;
			this.#duck.disconnect();
			this.#duck.connect(this.context.destination);
			this.#stream.element.pause();
			this.#stream = null;
			return;
		}
		if (!this.#stream) {
			const node = this.context.createMediaStreamDestination();
			const element = new Audio();
			element.srcObject = node.stream;
			this.#stream = { node, element };
		}
		await this.#stream.element.setSinkId(deviceId);
		this.#duck.disconnect();
		this.#duck.connect(this.#stream.node);
		await this.#stream.element.play();
	}
}
