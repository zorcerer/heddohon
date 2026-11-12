/**
 * Sound analysis on signals whose answers are known (issue #313): a tone of a
 * known level, chords of a known key, clicks at a known tempo, and silence.
 *
 * It imports `src/lib/server/analysis/features.ts` itself, which Node runs
 * with its types stripped from 22.18 on. On an older Node the tests skip,
 * saying so.
 *
 *   node --test tests/e2e/analysis-features.test.mjs
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const typescript = Boolean(process.features.typescript);
const { analyse, FEATURES_VERSION, VECTOR_LENGTH } = typescript ? await import('../../src/lib/server/analysis/features.ts') : {};
const skip = typescript ? false : `Node ${process.version} does not strip TypeScript types (22.18 and later do)`;

const RATE = 22050;
const KEYS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const named = (key) => (key ? `${KEYS[key.tonic]} ${key.minor ? 'minor' : 'major'}` : null);

/** `seconds` of the sum of sines at `hz`, each at `amplitude`. */
function tones(hz, amplitude, seconds = 30) {
	return Float32Array.from({ length: RATE * seconds }, (_, i) => hz.reduce((s, f) => s + amplitude * Math.sin((2 * Math.PI * f * i) / RATE), 0));
}

/** Short decaying noise bursts at `bpm`, from a fixed seed. */
function clicks(bpm, seconds = 30) {
	const x = new Float32Array(RATE * seconds);
	const every = Math.round((RATE * 60) / bpm);
	let seed = 1;
	const noise = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
	for (let start = 0; start < x.length; start += every) {
		for (let i = 0; i < 400 && start + i < x.length; i++) x[start + i] = 0.5 * noise() * Math.exp(-i / 80);
	}
	return x;
}

describe('sound analysis', { skip }, () => {
	test('measures a 1kHz sine at 0.1 as -23 LUFS, peaking at 0.1', () => {
		const r = analyse(tones([1000], 0.1), RATE);
		assert.ok(Math.abs(r.loudness + 23) < 0.5, `loudness ${r.loudness}`);
		assert.ok(Math.abs(r.peak - 0.1) < 0.005, `peak ${r.peak}`);
		assert.equal(r.version, FEATURES_VERSION);
		assert.equal(r.vector.length, VECTOR_LENGTH);
	});

	test('reads 6dB quieter as 6 LU quieter', () => {
		const loud = analyse(tones([1000], 0.2), RATE).loudness;
		const quiet = analyse(tones([1000], 0.1), RATE).loudness;
		assert.ok(Math.abs(loud - quiet - 6.02) < 0.1, `${loud} and ${quiet}`);
	});

	test('reads A, C# and E as A major, and D, F and A as D minor', () => {
		assert.equal(named(analyse(tones([220, 277.18, 329.63, 440, 554.37, 659.25], 0.05), RATE).key), 'A major');
		assert.equal(named(analyse(tones([146.83, 174.61, 220, 293.66, 349.23, 440], 0.05), RATE).key), 'D minor');
	});

	for (const bpm of [95, 120, 140]) {
		test(`finds clicks at ${bpm} BPM within 1 BPM, as a clear beat`, () => {
			const r = analyse(clicks(bpm), RATE);
			assert.ok(r.tempo !== null && Math.abs(r.tempo - bpm) < 1, `tempo ${r.tempo}`);
			assert.ok(r.tempoConfidence > 2, `confidence ${r.tempoConfidence}`);
		});
	}

	test('gives silence no tempo and no key, at -70 LUFS', () => {
		const r = analyse(new Float32Array(RATE * 30), RATE);
		assert.equal(r.tempo, null);
		assert.equal(r.key, null);
		assert.equal(r.loudness, -70);
		assert.equal(r.peak, 0);
		assert.ok(r.vector.every(Number.isFinite), 'a value in the vector is not a number');
	});

	test('takes an excerpt shorter than a beat search without failing', () => {
		const r = analyse(tones([440], 0.1, 1), RATE);
		assert.equal(r.tempo, null);
		assert.ok(r.vector.every(Number.isFinite));
	});

	test('gives the same samples the same answer', () => {
		const x = clicks(120);
		assert.deepEqual(analyse(x, RATE), analyse(x, RATE));
	});

	test('analyses 90 seconds in under 1.5 seconds', () => {
		const x = clicks(120, 90);
		for (let i = 0; i < x.length; i++) x[i] += 0.05 * Math.sin((2 * Math.PI * 220 * i) / RATE);
		const started = performance.now();
		analyse(x, RATE);
		const took = performance.now() - started;
		assert.ok(took < 1500, `${Math.round(took)}ms`);
	});
});
