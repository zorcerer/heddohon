/**
 * A headphone correction: a preamp and a list of parametric filters, as the
 * AutoEq project publishes one per measured headphone and as Equalizer APO
 * reads it. Shared by the server, which parses what it fetches
 * (`server/autoeq.ts`), and the browser, which parses an imported file and
 * builds the filters (`client/audiochain.ts`).
 *
 *   Preamp: -6.1 dB
 *   Filter 1: ON LSC Fc 105 Hz Gain 6.4 dB Q 0.70
 *   Filter 2: ON PK Fc 8800 Hz Gain 5.1 dB Q 1.42
 *
 * `PK` is a peaking filter, `LSC` a low shelf and `HSC` a high shelf. `LS`
 * and `HS`, Equalizer APO's shelves without a Q, are read as the same. A
 * filter marked `OFF` is left out.
 */

interface CorrectionFilter {
	type: 'peaking' | 'lowshelf' | 'highshelf';
	/** Hz. */
	frequency: number;
	/** dB. */
	gain: number;
	q: number;
}

export interface Correction {
	/** dB, added to the graph's preamp. */
	preamp: number;
	filters: CorrectionFilter[];
}

/** A correction with where it came from, as the browser keeps it. */
export interface CorrectionProfile extends Correction {
	/** The headphone, or the imported file's name. */
	name: string;
	/** Who measured it and on which rig, for a profile from the database. */
	source: string | null;
	/** Its path in the database, or null for an imported file. */
	id: string | null;
}

/** AutoEq writes ten filters; 20 leaves room for a hand-written file. Each is one biquad per channel. */
const MAX_CORRECTION_FILTERS = 20;
/** The largest file read. AutoEq's are about 500 bytes. */
export const MAX_CORRECTION_BYTES = 16 * 1024;

const GAIN_DB = 30;
/** A shelf written without a Q has the slope `BiquadFilterNode` gives every shelf. */
const SHELF_Q = Math.SQRT1_2;

const TYPES: Record<string, CorrectionFilter['type']> = {
	PK: 'peaking',
	PEQ: 'peaking',
	LSC: 'lowshelf',
	LS: 'lowshelf',
	HSC: 'highshelf',
	HS: 'highshelf'
};

const PREAMP = /^Preamp:\s*(-?\d+(?:\.\d+)?)\s*dB/i;
const FILTER =
	/^Filter(?:\s+\d+)?:\s*(ON|OFF)\s+([A-Z]+)\s+Fc\s+(\d+(?:\.\d+)?)\s*Hz\s+Gain\s+(-?\d+(?:\.\d+)?)\s*dB(?:\s+Q\s+(\d+(?:\.\d+)?))?/i;

function within(value: number, min: number, max: number): number | null {
	return Number.isFinite(value) && value >= min && value <= max ? value : null;
}

function filterFrom(type: unknown, frequency: unknown, gain: unknown, q: unknown): CorrectionFilter | null {
	if (type !== 'peaking' && type !== 'lowshelf' && type !== 'highshelf') return null;
	const hz = within(Number(frequency), 10, 24_000);
	const db = within(Number(gain), -GAIN_DB, GAIN_DB);
	const width = within(Number(q), 0.1, 30);
	if (hz === null || db === null || width === null) return null;
	return { type, frequency: hz, gain: db, q: width };
}

/**
 * Reads a ParametricEQ.txt. Null when it holds no filter that can be used: a
 * line that is not a preamp or a filter is passed over, and a value outside
 * what a headphone correction holds (10 Hz to 24 kHz, 30 dB either way, Q 0.1
 * to 30) drops its filter.
 */
export function parseParametricEq(text: string): Correction | null {
	let preamp = 0;
	const filters: CorrectionFilter[] = [];
	for (const raw of text.slice(0, MAX_CORRECTION_BYTES).split(/\r?\n/)) {
		const line = raw.trim();
		const gain = PREAMP.exec(line);
		if (gain) {
			preamp = within(Number(gain[1]), -GAIN_DB, GAIN_DB) ?? 0;
			continue;
		}
		const match = FILTER.exec(line);
		if (!match || match[1].toUpperCase() !== 'ON') continue;
		const filter = filterFrom(TYPES[match[2].toUpperCase()], match[3], match[4], match[5] ?? SHELF_Q);
		if (filter && filters.length < MAX_CORRECTION_FILTERS) filters.push(filter);
	}
	return filters.length > 0 ? { preamp, filters } : null;
}

/** A correction from storage or from the server, with every value checked again. Null when nothing usable is left. */
export function sanitizeCorrection(input: unknown): Correction | null {
	const raw = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
	if (!Array.isArray(raw.filters)) return null;
	const filters = raw.filters
		.slice(0, MAX_CORRECTION_FILTERS)
		.map((entry) => {
			const filter = (typeof entry === 'object' && entry !== null ? entry : {}) as Record<string, unknown>;
			return filterFrom(filter.type, filter.frequency, filter.gain, filter.q);
		})
		.filter((filter): filter is CorrectionFilter => filter !== null);
	if (filters.length === 0) return null;
	return { preamp: within(Number(raw.preamp), -GAIN_DB, GAIN_DB) ?? 0, filters };
}
