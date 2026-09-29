/**
 * Audio processing in this browser: whether the Web Audio path
 * (`audiochain.ts`) is on, and the equaliser's ten bands.
 *
 * Kept in this browser's `localStorage`, like the audio output, and not in the
 * account's settings: an equaliser corrects the headphones or speakers it is
 * set for, and those differ from one device to the next.
 *
 * Off by default. Turning it on routes the player's two audio elements
 * through a graph at once; turning it off takes effect at the next page load,
 * since an element cannot be taken out of a graph again (`audiochain.ts`).
 */
import { browser } from '$app/environment';
import { EQ_FREQUENCIES, EQ_RANGE_DB } from './audiochain';
import { player } from './player.svelte';

const STORAGE_KEY = 'heddohon:audio-processing';

const flat = () => EQ_FREQUENCIES.map(() => 0);

/** Starting points, in dB per band from 31 Hz to 16 kHz. */
export const EQ_PRESETS: Record<string, { label: string; gains: number[] }> = {
	flat: { label: 'Flat', gains: flat() },
	bass: { label: 'Bass', gains: [6, 5, 4, 2, 0, 0, 0, 0, 0, 0] },
	treble: { label: 'Treble', gains: [0, 0, 0, 0, 0, 0, 2, 4, 5, 6] },
	vocal: { label: 'Vocal', gains: [-2, -2, -1, 0, 2, 4, 4, 2, 0, -1] },
	loudness: { label: 'Loudness', gains: [5, 4, 2, 0, -1, 0, 0, 2, 4, 5] }
};

interface Saved {
	enabled: boolean;
	gains: number[];
}

function read(): Saved {
	try {
		const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
		const gains =
			Array.isArray(saved?.gains) && saved.gains.length === EQ_FREQUENCIES.length
				? saved.gains.map((gain: unknown) => clampGain(Number(gain)))
				: flat();
		return { enabled: saved?.enabled === true, gains };
	} catch {
		return { enabled: false, gains: flat() };
	}
}

function clampGain(value: number): number {
	return Number.isFinite(value) ? Math.min(EQ_RANGE_DB, Math.max(-EQ_RANGE_DB, Math.round(value))) : 0;
}

class AudioProcessing {
	/** Whether this browser has it switched on. */
	enabled = $state(false);
	/** dB per band, from 31 Hz to 16 kHz. */
	gains = $state<number[]>(flat());
	/** The preset the bands match, or null for bands set by hand. */
	preset = $derived(
		Object.keys(EQ_PRESETS).find((key) => EQ_PRESETS[key].gains.every((gain, i) => gain === this.gains[i])) ?? null
	);

	#started = false;

	/** Reads what this browser saved and, if it is on, routes the player. Called once the player has its elements. */
	init() {
		if (!browser || this.#started) return;
		this.#started = true;
		const saved = read();
		this.enabled = saved.enabled;
		this.gains = saved.gains;
		if (this.enabled) player.enableProcessing(this.gains);
	}

	/** Called from the switch itself, so the context starts inside the press. */
	setEnabled(on: boolean) {
		this.enabled = on;
		this.#write();
		// Off holds the graph level and flat until the next load, which leaves it out.
		if (on) player.enableProcessing(this.gains);
		else player.setEqualiser(flat());
	}

	setGain(band: number, value: number) {
		if (band < 0 || band >= EQ_FREQUENCIES.length) return;
		this.gains[band] = clampGain(value);
		this.#apply();
	}

	applyPreset(key: string) {
		const preset = EQ_PRESETS[key];
		if (!preset) return;
		this.gains = [...preset.gains];
		this.#apply();
	}

	#apply() {
		if (this.enabled) player.setEqualiser(this.gains);
		this.#write();
	}

	#write() {
		try {
			localStorage.setItem(STORAGE_KEY, JSON.stringify({ enabled: this.enabled, gains: this.gains }));
		} catch {
			// Storage refused (a private window with it off): the choice lasts until reload.
		}
	}
}

export const processing = new AudioProcessing();
