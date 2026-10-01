/**
 * Audio processing in this browser: whether the Web Audio path
 * (`audiochain.ts`) is on, the equaliser's ten bands, and the headphone
 * correction ahead of them.
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
import { MAX_CORRECTION_BYTES, parseParametricEq, sanitizeCorrection, type CorrectionProfile } from '$lib/autoeq';
import { EQ_FREQUENCIES, EQ_RANGE_DB } from './audiochain';
import { player } from './player.svelte';

const STORAGE_KEY = 'heddohon:audio-processing';
/** A correction from the database is asked for again after this, so a revised measurement arrives by itself. */
const CORRECTION_REFRESH_MS = 24 * 60 * 60 * 1000;

const flat = () => EQ_FREQUENCIES.map(() => 0);

/** Starting points, in dB per band from 31 Hz to 16 kHz. */
export const EQ_PRESETS: Record<string, { label: string; gains: number[] }> = {
	flat: { label: 'Flat', gains: flat() },
	bass: { label: 'Bass', gains: [6, 5, 4, 2, 0, 0, 0, 0, 0, 0] },
	treble: { label: 'Treble', gains: [0, 0, 0, 0, 0, 0, 2, 4, 5, 6] },
	vocal: { label: 'Vocal', gains: [-2, -2, -1, 0, 2, 4, 4, 2, 0, -1] },
	loudness: { label: 'Loudness', gains: [5, 4, 2, 0, -1, 0, 0, 2, 4, 5] }
};

/** A correction as it is kept, with when it was last fetched. */
type SavedCorrection = CorrectionProfile & { fetchedAt: number };

interface Saved {
	enabled: boolean;
	gains: number[];
	correction: SavedCorrection | null;
}

/** A stored or fetched profile with every value checked again; null when no filter is left. */
function profileFrom(input: unknown, fetchedAt: number): SavedCorrection | null {
	const correction = sanitizeCorrection(input);
	if (!correction) return null;
	const raw = input as Record<string, unknown>;
	return {
		...correction,
		name: typeof raw.name === 'string' && raw.name ? raw.name.slice(0, 200) : 'Imported correction',
		source: typeof raw.source === 'string' && raw.source ? raw.source.slice(0, 200) : null,
		id: typeof raw.id === 'string' && raw.id ? raw.id.slice(0, 300) : null,
		fetchedAt
	};
}

function read(): Saved {
	try {
		const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
		const gains =
			Array.isArray(saved?.gains) && saved.gains.length === EQ_FREQUENCIES.length
				? saved.gains.map((gain: unknown) => clampGain(Number(gain)))
				: flat();
		const correction = profileFrom(saved?.correction, Number(saved?.correction?.fetchedAt) || 0);
		return { enabled: saved?.enabled === true, gains, correction };
	} catch {
		return { enabled: false, gains: flat(), correction: null };
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
	/** The headphone correction ahead of the bands, or null. */
	correction = $state<SavedCorrection | null>(null);
	/**
	 * Whether the ten bands are set aside: a headphone correction is in use.
	 * The correction is worked out for a flat signal ahead of it, preamp
	 * included, and bands on top of it would move the result off its target
	 * and could take it past full scale. The bands keep their values and come
	 * back when the correction is removed.
	 */
	bandsOff = $derived(this.correction !== null);
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
		this.correction = saved.correction;
		if (this.enabled) this.#route();
	}

	/** What the graph's bands are given: flat while a correction is in use. */
	#bands(): number[] {
		return this.bandsOff ? flat() : this.gains;
	}

	#route() {
		player.enableProcessing(this.#bands());
		player.setCorrection(this.correction);
	}

	/** Called from the switch itself, so the context starts inside the press. */
	setEnabled(on: boolean) {
		this.enabled = on;
		this.#write();
		// Off holds the graph level and flat until the next load, which leaves it out.
		if (on) this.#route();
		else {
			player.setEqualiser(flat());
			player.setCorrection(null);
		}
	}

	/** Sets the correction, or removes it for null. */
	setCorrection(profile: CorrectionProfile | null) {
		this.correction = profile ? profileFrom(profile, Date.now()) : null;
		if (this.enabled) {
			player.setCorrection(this.correction);
			player.setEqualiser(this.#bands());
		}
		this.#write();
	}

	/**
	 * Reads a ParametricEQ.txt chosen in Settings. False when it holds no
	 * filter that can be used, and the correction in place is kept.
	 */
	async importCorrection(file: File): Promise<boolean> {
		if (file.size > MAX_CORRECTION_BYTES) return false;
		const correction = parseParametricEq(await file.text());
		if (!correction) return false;
		const name = file.name.replace(/\.txt$/i, '').replace(/\s*ParametricEQ$/i, '').trim();
		this.setCorrection({ ...correction, name: name || 'Imported correction', source: null, id: null });
		return true;
	}

	/** Fetches a profile from the database by the id a search returned, and sets it. */
	async chooseCorrection(id: string): Promise<boolean> {
		const profile = await fetchProfile(id);
		if (!profile) return false;
		this.setCorrection(profile);
		return true;
	}

	/**
	 * Asks the database again for the chosen profile once it is a day old, so
	 * a measurement revised upstream replaces the copy kept here. A failure
	 * keeps the copy. Called where the database is on (`+layout.svelte`).
	 */
	async refreshCorrection() {
		const held = this.correction;
		if (!held?.id || Date.now() - held.fetchedAt < CORRECTION_REFRESH_MS) return;
		const profile = await fetchProfile(held.id);
		// Changed or removed while the request was out: that choice stands.
		if (profile && this.correction === held) this.setCorrection(profile);
	}

	setGain(band: number, value: number) {
		if (band < 0 || band >= EQ_FREQUENCIES.length || this.bandsOff) return;
		this.gains[band] = clampGain(value);
		this.#apply();
	}

	applyPreset(key: string) {
		const preset = EQ_PRESETS[key];
		if (!preset || this.bandsOff) return;
		this.gains = [...preset.gains];
		this.#apply();
	}

	#apply() {
		if (this.enabled) player.setEqualiser(this.#bands());
		this.#write();
	}

	#write() {
		try {
			localStorage.setItem(STORAGE_KEY, JSON.stringify({ enabled: this.enabled, gains: this.gains, ...(this.correction ? { correction: this.correction } : {}) }));
		} catch {
			// Storage refused (a private window with it off): the choice lasts until reload.
		}
	}
}

async function fetchProfile(id: string): Promise<CorrectionProfile | null> {
	try {
		const response = await fetch(`/api/autoeq/profile?id=${encodeURIComponent(id)}`);
		if (!response.ok) return null;
		return profileFrom(await response.json(), Date.now());
	} catch {
		return null;
	}
}

export const processing = new AudioProcessing();
