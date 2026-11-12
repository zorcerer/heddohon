/**
 * What a song sounds like, from its samples: loudness, tempo, key, and a
 * vector to find songs that sound alike (issue #313, part of #312).
 *
 * Pure: mono samples in, numbers out. Nothing here reads a file, the music
 * server or the database; `decode.ts` brings the samples and `store.ts` keeps
 * the answer. The played audio is never touched (invariant 9): this works on
 * a decoded copy of an excerpt.
 *
 * The methods and their numbers were chosen in a spike on 2026-11-12, over
 * 248 freely licensed songs: about 0.8s of one core for 90s of audio at
 * 22.05kHz, where the decode costs about 0.17s. The figures quoted below are
 * from it.
 *
 * Frames are taken from the samples one at a time and folded into running
 * sums, so memory follows the frame size, not the length of the excerpt.
 */

/**
 * Raised whenever any output changes for the same samples, so stored results
 * from an earlier version are analysed again (`store.ts`).
 */
export const FEATURES_VERSION = 1;

/** Values in `SongFeatures.vector`; see `timbre` for what each is. */
export const VECTOR_LENGTH = 32;

export interface SongKey {
	/** Pitch class of the tonic, 0 for C to 11 for B. */
	tonic: number;
	minor: boolean;
}

export interface SongFeatures {
	version: number;
	/** Integrated loudness by ITU-R BS.1770, in LUFS. -70 for silence. */
	loudness: number;
	/** Largest absolute sample, 0 to 1 for samples in range. */
	peak: number;
	/** Null where nothing in the excerpt reads as a beat. */
	tempo: number | null;
	/** How far the chosen beat stands above the others: 1 is no beat, 3 and up is a clear one. */
	tempoConfidence: number;
	/** Null for silence or a sound with no pitch. */
	key: SongKey | null;
	/** Correlation of the chroma with the chosen key's profile, -1 to 1. */
	keyConfidence: number;
	/** `VECTOR_LENGTH` values, raw: compare them only after scaling each across the library. */
	vector: Float32Array;
}

// ── Frames ─────────────────────────────────────────────────────────────────

/** In-place radix-2 FFT; `re.length` is a power of two. */
function fft(re: Float64Array, im: Float64Array): void {
	const n = re.length;
	for (let i = 1, j = 0; i < n; i++) {
		let bit = n >> 1;
		for (; j & bit; bit >>= 1) j ^= bit;
		j ^= bit;
		if (i < j) {
			[re[i], re[j]] = [re[j], re[i]];
			[im[i], im[j]] = [im[j], im[i]];
		}
	}
	for (let len = 2; len <= n; len <<= 1) {
		const angle = (-2 * Math.PI) / len;
		const wr = Math.cos(angle);
		const wi = Math.sin(angle);
		const half = len / 2;
		for (let start = 0; start < n; start += len) {
			let cr = 1;
			let ci = 0;
			for (let k = 0; k < half; k++) {
				const a = start + k;
				const b = a + half;
				const tr = re[b] * cr - im[b] * ci;
				const ti = re[b] * ci + im[b] * cr;
				re[b] = re[a] - tr;
				im[b] = im[a] - ti;
				re[a] += tr;
				im[a] += ti;
				const next = cr * wr - ci * wi;
				ci = cr * wi + ci * wr;
				cr = next;
			}
		}
	}
}

/**
 * Calls `each` with the magnitude spectrum of every Hann-windowed frame of
 * `size` samples, `hop` apart. One buffer is reused: `each` reads it before
 * returning.
 */
function frames(x: Float32Array, size: number, hop: number, each: (magnitude: Float64Array) => void): void {
	const window = new Float64Array(size);
	for (let i = 0; i < size; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size);
	const re = new Float64Array(size);
	const im = new Float64Array(size);
	const magnitude = new Float64Array(size / 2 + 1);
	for (let start = 0; start + size <= x.length; start += hop) {
		for (let i = 0; i < size; i++) {
			re[i] = x[start + i] * window[i];
			im[i] = 0;
		}
		fft(re, im);
		for (let k = 0; k <= size / 2; k++) magnitude[k] = Math.hypot(re[k], im[k]);
		each(magnitude);
	}
}

// ── Loudness ───────────────────────────────────────────────────────────────

/** A biquad's coefficients, normalised so `a[0]` is 1. */
interface Biquad {
	b: [number, number, number];
	a: [number, number, number];
}

/**
 * BS.1770's K-weighting, designed for any rate as pyloudnorm does it: the
 * standard gives coefficients for 48kHz only, and the excerpt is 22.05kHz.
 */
function kWeighting(rate: number): [Biquad, Biquad] {
	const normalise = (b: number[], a: number[]): Biquad => ({
		b: [b[0] / a[0], b[1] / a[0], b[2] / a[0]],
		a: [1, a[1] / a[0], a[2] / a[0]]
	});
	// The high shelf: +4dB above about 1.7kHz, the head's effect.
	const gain = 3.999843853973347;
	const shelfQ = 0.7071752369554196;
	const shelfAt = 1681.974450955533;
	const A = 10 ** (gain / 40);
	let w0 = (2 * Math.PI * shelfAt) / rate;
	let alpha = Math.sin(w0) / (2 * shelfQ);
	let cos = Math.cos(w0);
	const shelf = normalise(
		[
			A * (A + 1 + (A - 1) * cos + 2 * Math.sqrt(A) * alpha),
			-2 * A * (A - 1 + (A + 1) * cos),
			A * (A + 1 + (A - 1) * cos - 2 * Math.sqrt(A) * alpha)
		],
		[A + 1 - (A - 1) * cos + 2 * Math.sqrt(A) * alpha, 2 * (A - 1 - (A + 1) * cos), A + 1 - (A - 1) * cos - 2 * Math.sqrt(A) * alpha]
	);
	// The high pass at about 38Hz.
	const passQ = 0.5003270373238773;
	const passAt = 38.13547087602444;
	w0 = (2 * Math.PI * passAt) / rate;
	alpha = Math.sin(w0) / (2 * passQ);
	cos = Math.cos(w0);
	const pass = normalise([(1 + cos) / 2, -(1 + cos), (1 + cos) / 2], [1 + alpha, -2 * cos, 1 - alpha]);
	return [shelf, pass];
}

/**
 * Integrated loudness: K-weighted mean square over 400ms blocks every 100ms,
 * blocks under -70 LUFS dropped, then blocks more than 10 LU under the mean
 * of the rest. A 1kHz sine at 0.1 reads -23.3 (the standard gives -23.0 at
 * 48kHz; the filters drift at 22.05kHz).
 */
function loudness(x: Float32Array, rate: number): number {
	const [first, second] = kWeighting(rate);
	const block = Math.round(0.4 * rate);
	const step = Math.round(0.1 * rate);
	// Squares of the weighted signal, summed per 100ms step; a block is four.
	const steps: number[] = [];
	let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
	let u1 = 0, u2 = 0, v1 = 0, v2 = 0;
	let sum = 0;
	for (let i = 0; i < x.length; i++) {
		const y = first.b[0] * x[i] + first.b[1] * x1 + first.b[2] * x2 - first.a[1] * y1 - first.a[2] * y2;
		x2 = x1;
		x1 = x[i];
		y2 = y1;
		y1 = y;
		const v = second.b[0] * y + second.b[1] * u1 + second.b[2] * u2 - second.a[1] * v1 - second.a[2] * v2;
		u2 = u1;
		u1 = y;
		v2 = v1;
		v1 = v;
		sum += v * v;
		if ((i + 1) % step === 0) {
			steps.push(sum);
			sum = 0;
		}
	}
	const perBlock = block / step;
	const blocks: number[] = [];
	for (let s = 0; s + perBlock <= steps.length; s++) {
		let total = 0;
		for (let j = s; j < s + perBlock; j++) total += steps[j];
		blocks.push(total / block);
	}
	const lufs = (meanSquare: number) => -0.691 + 10 * Math.log10(meanSquare);
	const audible = blocks.filter((m) => m > 0 && lufs(m) > -70);
	if (audible.length === 0) return -70;
	const relative = lufs(audible.reduce((s, m) => s + m, 0) / audible.length) - 10;
	const gated = audible.filter((m) => lufs(m) > relative);
	return lufs(gated.reduce((s, m) => s + m, 0) / gated.length);
}

// ── Tempo ──────────────────────────────────────────────────────────────────

/**
 * Beats per minute from the onset envelope's autocorrelation between 60 and
 * 180, weighted toward 120 as most trackers are, the peak placed between
 * frames by a parabola: a frame is 23ms, a step of 6 BPM at 120, and clicks
 * at 120 read 117.5 without it. Within 0.5 BPM on click tracks at 95, 120 and
 * 140. On music without a beat (ambient, solo piano) it still finds a peak,
 * near 120; `confidence` is what tells the two apart.
 */
function tempo(envelope: Float64Array, framesPerSecond: number): { tempo: number | null; confidence: number } {
	const mean = envelope.reduce((s, v) => s + v, 0) / (envelope.length || 1);
	const onset = envelope.map((v) => Math.max(0, v - mean));
	const at = (lag: number) => {
		let s = 0;
		for (let i = lag; i < onset.length; i++) s += onset[i] * onset[i - lag];
		return s;
	};
	const lo = Math.round((framesPerSecond * 60) / 180);
	const hi = Math.round((framesPerSecond * 60) / 60);
	if (onset.length <= hi) return { tempo: null, confidence: 1 };
	let best = 0;
	let bestLag = 0;
	let total = 0;
	for (let lag = lo; lag <= hi; lag++) {
		const bpm = (framesPerSecond * 60) / lag;
		const weighted = at(lag) * Math.exp(-0.5 * (Math.log2(bpm / 120) / 0.9) ** 2);
		total += weighted;
		if (weighted > best) {
			best = weighted;
			bestLag = lag;
		}
	}
	if (best <= 0) return { tempo: null, confidence: 1 };
	let lag = bestLag;
	if (bestLag > lo && bestLag < hi) {
		const a = at(bestLag - 1);
		const b = at(bestLag);
		const c = at(bestLag + 1);
		const curve = a - 2 * b + c;
		if (curve < 0) lag = bestLag + (0.5 * (a - c)) / curve;
	}
	return { tempo: (framesPerSecond * 60) / lag, confidence: best / (total / (hi - lo + 1)) };
}

// ── Key ────────────────────────────────────────────────────────────────────

/**
 * Albrecht and Shanahan's (2013) key profiles. On The Art of the Fugue, all of
 * it in D minor, they read 13 of 20 as D minor and the other 7 as its
 * dominant; Krumhansl and Kessler's, the usual ones, read 1 of 20.
 */
const MAJOR = [0.238, 0.006, 0.111, 0.006, 0.137, 0.094, 0.016, 0.214, 0.009, 0.08, 0.008, 0.081];
const MINOR = [0.22, 0.006, 0.104, 0.123, 0.019, 0.103, 0.012, 0.214, 0.062, 0.022, 0.061, 0.052];

function correlation(a: ArrayLike<number>, b: ArrayLike<number>, shift: number): number {
	let ma = 0, mb = 0;
	for (let i = 0; i < 12; i++) {
		ma += a[(i + shift) % 12];
		mb += b[i];
	}
	ma /= 12;
	mb /= 12;
	let n = 0, da = 0, db = 0;
	for (let i = 0; i < 12; i++) {
		const x = a[(i + shift) % 12] - ma;
		const y = b[i] - mb;
		n += x * y;
		da += x * x;
		db += y * y;
	}
	return da === 0 || db === 0 ? 0 : n / Math.sqrt(da * db);
}

/**
 * Chroma over its own 8192-sample frames (2.7Hz a bin at 22.05kHz, so a bass
 * note has bins of its own), from 80Hz to 2kHz, log magnitude, each frame
 * normalised. Over 2048-sample frames weighted by power, the bass and its
 * overtones outvoted the rest and the fugue read G major 17 times in 20.
 */
function key(x: Float32Array, rate: number): { key: SongKey | null; confidence: number } {
	const size = 8192;
	const chroma = new Float64Array(12);
	const classOf = new Int8Array(size / 2 + 1).fill(-1);
	for (let k = 1; k <= size / 2; k++) {
		const f = (k * rate) / size;
		if (f >= 80 && f <= 2000) classOf[k] = (((Math.round(12 * Math.log2(f / 440)) % 12) + 12 + 9) % 12); // A is 9
	}
	const frame = new Float64Array(12);
	frames(x, size, size / 2, (magnitude) => {
		frame.fill(0);
		let total = 0;
		for (let k = 1; k < magnitude.length; k++) {
			if (classOf[k] < 0) continue;
			const v = Math.log1p(magnitude[k]);
			frame[classOf[k]] += v;
			total += v;
		}
		if (total > 0) for (let i = 0; i < 12; i++) chroma[i] += frame[i] / total;
	});
	let best: SongKey | null = null;
	let score = -1;
	for (let tonic = 0; tonic < 12; tonic++) {
		for (const [profile, minor] of [[MAJOR, false], [MINOR, true]] as const) {
			const c = correlation(chroma, profile, tonic);
			if (c > score) {
				score = c;
				best = { tonic, minor };
			}
		}
	}
	// A flat chroma (silence, noise) correlates with nothing.
	return score > 0 ? { key: best, confidence: score } : { key: null, confidence: 0 };
}

// ── Timbre ─────────────────────────────────────────────────────────────────

const hzToMel = (f: number) => 2595 * Math.log10(1 + f / 700);
const melToHz = (m: number) => 700 * (10 ** (m / 2595) - 1);

/**
 * Triangular mel bands, each as the bins it covers and their weights: a bin
 * feeds two bands at most, so 40 bands cost about two multiplies a bin.
 * Applied as a dense matrix it was 60% of the analysis.
 */
function melBands(size: number, rate: number, count: number, lo: number, hi: number): { from: number; weights: Float64Array }[] {
	const points = Array.from({ length: count + 2 }, (_, i) => (melToHz(hzToMel(lo) + ((hzToMel(hi) - hzToMel(lo)) * i) / (count + 1)) * size) / rate);
	return Array.from({ length: count }, (_, m) => {
		const from = Math.floor(points[m]) + 1;
		const to = Math.ceil(points[m + 2]);
		const weights = new Float64Array(Math.max(0, to - from));
		for (let k = from; k < to; k++) {
			if (k > points[m] && k <= points[m + 1]) weights[k - from] = (k - points[m]) / (points[m + 1] - points[m]);
			else if (k > points[m + 1] && k < points[m + 2]) weights[k - from] = (points[m + 2] - k) / (points[m + 2] - points[m + 1]);
		}
		return { from, weights };
	});
}

/** A running mean and spread (Welford), so frames need not be kept. */
class Running {
	count = 0;
	mean = 0;
	#m2 = 0;
	add(v: number): void {
		this.count++;
		const d = v - this.mean;
		this.mean += d / this.count;
		this.#m2 += d * (v - this.mean);
	}
	get spread(): number {
		return this.count > 1 ? Math.sqrt(this.#m2 / this.count) : 0;
	}
}

// ── All of it ──────────────────────────────────────────────────────────────

/**
 * Analyses `samples` (mono, `rate` Hz, nominally -1 to 1). Meant for an
 * excerpt of about 90s; shorter is fine, and under about 3s gives no tempo.
 *
 * The vector holds, in order: 13 MFCC means, 13 MFCC spreads, the spectral
 * centroid's mean and spread in Hz, the 85% rolloff's mean in Hz, the mean
 * spectral flatness, the frame level's spread over its mean, and the tempo
 * confidence. Their scales differ by orders of magnitude, so a comparison
 * scales each value across the library first (`similar.ts`).
 */
export function analyse(samples: Float32Array, rate: number): SongFeatures {
	const size = 2048;
	const hop = 512;
	const framesPerSecond = rate / hop;
	const bins = size / 2 + 1;

	let peak = 0;
	for (let i = 0; i < samples.length; i++) {
		const v = Math.abs(samples[i]);
		if (v > peak) peak = v;
	}

	const bands = melBands(size, rate, 40, 30, Math.min(8000, rate / 2));
	const cosine = Array.from({ length: 13 }, (_, k) => Float64Array.from({ length: bands.length }, (_, i) => Math.cos((Math.PI * k * (i + 0.5)) / bands.length)));
	const mfcc = Array.from({ length: 13 }, () => new Running());
	const centroid = new Running();
	const rolloff = new Running();
	const flatness = new Running();
	const level = new Running();
	const envelope: number[] = [];
	const previous = new Float64Array(bins);
	const mel = new Float64Array(bands.length);
	const power = new Float64Array(bins);
	let first = true;

	frames(samples, size, hop, (magnitude) => {
		// Onset strength: how much the log spectrum rose since the last frame.
		let flux = 0;
		for (let k = 1; k < bins; k++) {
			const now = Math.log1p(100 * magnitude[k]);
			if (!first && now > previous[k]) flux += now - previous[k];
			previous[k] = now;
		}
		envelope.push(first ? 0 : flux);
		first = false;

		let total = 0;
		let weighted = 0;
		let logSum = 0;
		for (let k = 0; k < bins; k++) {
			const p = magnitude[k] * magnitude[k];
			power[k] = p;
			total += p;
			weighted += ((k * rate) / size) * p;
			logSum += Math.log(p + 1e-12);
		}
		if (total <= 0) return;
		centroid.add(weighted / total);
		let accumulated = 0;
		let k = 0;
		for (; k < bins && accumulated < 0.85 * total; k++) accumulated += power[k];
		rolloff.add((k * rate) / size);
		flatness.add(Math.exp(logSum / bins) / (total / bins));
		level.add(Math.sqrt(total / bins));
		for (let m = 0; m < bands.length; m++) {
			const { from, weights } = bands[m];
			let e = 0;
			for (let i = 0; i < weights.length; i++) e += weights[i] * power[from + i];
			mel[m] = Math.log(e + 1e-10);
		}
		for (let c = 0; c < 13; c++) {
			let s = 0;
			for (let m = 0; m < mel.length; m++) s += cosine[c][m] * mel[m];
			mfcc[c].add(s);
		}
	});

	const beat = tempo(Float64Array.from(envelope), framesPerSecond);
	const found = key(samples, rate);

	const vector = new Float32Array(VECTOR_LENGTH);
	let i = 0;
	for (const c of mfcc) vector[i++] = c.mean;
	for (const c of mfcc) vector[i++] = c.spread;
	vector[i++] = centroid.mean;
	vector[i++] = centroid.spread;
	vector[i++] = rolloff.mean;
	vector[i++] = flatness.mean;
	vector[i++] = level.mean > 0 ? level.spread / level.mean : 0;
	vector[i++] = beat.confidence;

	return {
		version: FEATURES_VERSION,
		loudness: loudness(samples, rate),
		peak,
		tempo: beat.tempo,
		tempoConfidence: beat.confidence,
		key: found.key,
		keyConfidence: found.confidence,
		vector
	};
}
