/**
 * Pulls a usable accent colour out of cover art.
 *
 * This runs in the browser rather than on the server on purpose. Extracting it
 * server-side would need an image decoder in the Node process — `sharp` and
 * friends are tens of megabytes of native code, which is a poor trade for one
 * decorative colour. Covers are served same-origin from `/api/cover`, so the
 * canvas is never tainted and a 32x32 draw costs well under a millisecond.
 *
 * The colour is tamed hard on the way out: saturation is held under 38% and
 * lightness pulled into a mid band. The target is a record seen through a dark
 * pane of glass rather than a coloured light shone at the screen — at the 58%
 * this used to allow, a saturated sleeve did not tint the interface so much as
 * take it over. The floor still matters as much as the ceiling: below roughly
 * 18% every hue collapses into the same grey and the effect stops reading as
 * colour at all, so the range is narrow at both ends rather than simply lower.
 */
import { coverUrl } from './format';

export interface ArtworkColor {
	/** Degrees, 0–360. */
	hue: number;
	/** Percent, clamped to a restrained range. */
	saturation: number;
	/** Percent, clamped to a mid band so text stays readable over it. */
	lightness: number;
}

/** Frost, used until something is playing and for artwork with no usable hue. */
export const DEFAULT_ARTWORK_COLOR: ArtworkColor = { hue: 193, saturation: 22, lightness: 52 };

const SAMPLE_SIZE = 32;
const HUE_BUCKETS = 24;
/** Below this share of sampled pixels the image is effectively greyscale. */
const MIN_CHROMATIC_SHARE = 0.06;

const cache = new Map<string, ArtworkColor | null>();
const MAX_CACHE_ENTRIES = 120;

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

function loadImage(src: string): Promise<HTMLImageElement> {
	return new Promise((resolve, reject) => {
		const image = new Image();
		image.decoding = 'async';
		image.onload = () => resolve(image);
		image.onerror = () => reject(new Error(`Could not load ${src}`));
		image.src = src;
	});
}

/** Returns hue in degrees, saturation and lightness as 0–1. */
function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
	const red = r / 255;
	const green = g / 255;
	const blue = b / 255;
	const max = Math.max(red, green, blue);
	const min = Math.min(red, green, blue);
	const lightness = (max + min) / 2;
	const delta = max - min;

	if (delta === 0) return [0, 0, lightness];

	const saturation = delta / (1 - Math.abs(2 * lightness - 1));
	let hue: number;
	if (max === red) hue = ((green - blue) / delta) % 6;
	else if (max === green) hue = (blue - red) / delta + 2;
	else hue = (red - green) / delta + 4;

	hue *= 60;
	if (hue < 0) hue += 360;
	return [hue, saturation, lightness];
}

function analyse(pixels: Uint8ClampedArray): ArtworkColor | null {
	// Hues are angles, so they are accumulated as unit vectors — averaging the
	// raw degrees would put the mean of 350° and 10° at 180°, the exact opposite
	// of the right answer.
	const weight = new Float64Array(HUE_BUCKETS);
	const vectorX = new Float64Array(HUE_BUCKETS);
	const vectorY = new Float64Array(HUE_BUCKETS);
	const saturationSum = new Float64Array(HUE_BUCKETS);
	const lightnessSum = new Float64Array(HUE_BUCKETS);

	let sampled = 0;
	let chromatic = 0;

	for (let i = 0; i < pixels.length; i += 4) {
		if (pixels[i + 3] < 200) continue;
		sampled += 1;

		const [hue, saturation, lightness] = rgbToHsl(pixels[i], pixels[i + 1], pixels[i + 2]);

		// Near-black, near-white and near-grey pixels carry no usable hue, and
		// letterboxing or a white sleeve would otherwise dominate the count.
		if (lightness < 0.12 || lightness > 0.92 || saturation < 0.14) continue;

		// Favour saturated pixels at mid lightness: those are the ones a person
		// would name if asked what colour the sleeve is.
		const pixelWeight = saturation * (1 - Math.abs(lightness - 0.5) * 1.2);
		if (pixelWeight <= 0) continue;

		chromatic += 1;
		const bucket = Math.min(HUE_BUCKETS - 1, Math.floor((hue / 360) * HUE_BUCKETS));
		const radians = (hue * Math.PI) / 180;
		weight[bucket] += pixelWeight;
		vectorX[bucket] += Math.cos(radians) * pixelWeight;
		vectorY[bucket] += Math.sin(radians) * pixelWeight;
		saturationSum[bucket] += saturation * pixelWeight;
		lightnessSum[bucket] += lightness * pixelWeight;
	}

	if (sampled === 0 || chromatic / sampled < MIN_CHROMATIC_SHARE) return null;

	let best = 0;
	for (let i = 1; i < HUE_BUCKETS; i += 1) {
		if (weight[i] > weight[best]) best = i;
	}
	if (weight[best] <= 0) return null;

	const hue =
		((Math.atan2(vectorY[best], vectorX[best]) * 180) / Math.PI + 360) % 360;

	return {
		hue,
		saturation: clamp((saturationSum[best] / weight[best]) * 100, 18, 38),
		lightness: clamp((lightnessSum[best] / weight[best]) * 100, 38, 62)
	};
}

/**
 * The cover, if a copy of it is already on the page.
 *
 * `extract` used to always fetch its own 96px copy, which nothing else on the
 * page uses: a separate request, and the colour arrived only once it came back.
 * Measured on an album-to-album navigation, the room held the previous album's
 * colour for 556ms after the click and then moved. The hero of the page being
 * opened is a copy of the same cover, already decoded and on screen, so it can
 * be drawn straight into the sampling canvas.
 *
 * Matched on the path rather than the whole URL: the size is part of the query,
 * and with `srcset` the size actually loaded depends on the display.
 */
function onPage(coverArt: string): HTMLImageElement | null {
	const prefix = `/api/cover/${encodeURIComponent(coverArt)}?`;
	for (const image of document.images) {
		if (!image.complete || image.naturalWidth === 0) continue;
		if ((image.currentSrc || image.src).includes(prefix)) return image;
	}
	return null;
}

async function extract(coverArt: string): Promise<ArtworkColor | null> {
	return colorOfImage(onPage(coverArt) ?? (await loadImage(coverUrl(coverArt, 96))));
}

/**
 * The colour of an image that is already decoded.
 *
 * For a page whose cover does not come from `/api/cover`: a shared link serves
 * its cover from a route of its own, which `extract` has no id to build. The
 * image has to be same-origin, or the canvas is tainted and this returns null.
 */
export function colorOfImage(image: HTMLImageElement): ArtworkColor | null {
	const canvas = document.createElement('canvas');
	canvas.width = SAMPLE_SIZE;
	canvas.height = SAMPLE_SIZE;
	const context = canvas.getContext('2d', { willReadFrequently: true });
	if (!context) return null;

	context.drawImage(image, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
	try {
		return analyse(context.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE).data);
	} catch {
		// A tainted canvas should be impossible for same-origin covers, but a
		// decorative colour is never worth throwing over.
		return null;
	}
}

/** Memoised so re-visiting an album does not re-decode its cover. */
export async function artworkColor(coverArt: string | null | undefined): Promise<ArtworkColor | null> {
	if (!coverArt || typeof document === 'undefined') return null;

	const cached = cache.get(coverArt);
	if (cached !== undefined) return cached;

	const color = await extract(coverArt).catch(() => null);

	if (cache.size >= MAX_CACHE_ENTRIES) {
		const oldest = cache.keys().next().value;
		if (oldest !== undefined) cache.delete(oldest);
	}
	cache.set(coverArt, color);
	return color;
}

/**
 * Writes the tint onto an element. Everything below it in the tree picks the new
 * colour up, because the properties are declared `inherits: true`.
 */
export function applyArtworkColor(target: HTMLElement, color: ArtworkColor | null): void {
	const next = color ?? DEFAULT_ARTWORK_COLOR;

	// Take the short way round the colour wheel. Left alone, a move from 350° to
	// 10° animates the long way and sweeps the entire spectrum on its way to a
	// neighbouring hue.
	//
	// The starting point is read from the *computed* value rather than the inline
	// one, because --art-h is a registered property and therefore animated: while
	// a crossfade is still in flight the inline value is the destination, not what
	// is on screen. Measuring from the destination makes a track skipped
	// mid-transition take the long way round.
	const previous = Number.parseFloat(
		getComputedStyle(target).getPropertyValue('--art-h') || target.style.getPropertyValue('--art-h')
	);
	const from = Number.isFinite(previous) ? previous : next.hue;
	const shortest = ((next.hue - from + 540) % 360) - 180;

	target.style.setProperty('--art-h', (from + shortest).toFixed(1));
	target.style.setProperty('--art-s', `${next.saturation.toFixed(1)}%`);
	target.style.setProperty('--art-l', `${next.lightness.toFixed(1)}%`);

	// The wash on the rail and the player cross-fades between two fixed colours
	// rather than following the interpolation above. Same destination, and the
	// hue takes the short way round there as well: `from` is already unwound.
	if (typeof document !== 'undefined') {
		const landing = { ...next, hue: from + shortest };
		requestMorph(landing);
	}
}

/**
 * Hands the two cross-fading surfaces their before and after.
 *
 * They are found by class rather than passed in: the tint is applied at the
 * document root by one caller that has no business knowing which elements
 * happen to paint it, and there are never more than two of them on screen.
 *
 * The two layers take turns: the new colour goes into the one that is hidden,
 * and `--tint-mix` moves towards it from wherever it is. `app.css`, by
 * `.hh-tint-morph`, records the reset this replaced and the dark frame it is
 * taken to have caused.
 *
 * The layer on screen is written as well, with the colour it is already
 * showing. Until the first change it has no colour of its own and reads the
 * room's `--art-*`, which start moving at the same moment. Only called with
 * no fade in progress (see `requestMorph`), so neither write lands on a layer
 * that is visible with a different colour.
 */
function morphTintLayers(from: ArtworkColor, to: ArtworkColor): void {
	const surfaces = document.querySelectorAll<HTMLElement>('.hh-tint-morph');
	for (const surface of surfaces) {
		// `--tint-mix` starts at 1 in `app.css`, so the second layer is the one
		// on screen for a surface that has not changed colour yet.
		const front = fronts.get(surface) ?? 'b';
		const back = front === 'a' ? 'b' : 'a';
		paintTintLayer(surface, front, from);
		paintTintLayer(surface, back, to);
		surface.style.setProperty('--tint-mix', back === 'b' ? '1' : '0');
		fronts.set(surface, back);
	}
}

function paintTintLayer(surface: HTMLElement, layer: 'a' | 'b', color: ArtworkColor): void {
	surface.style.setProperty(`--tint-${layer}-h`, color.hue.toFixed(1));
	surface.style.setProperty(`--tint-${layer}-s`, `${color.saturation.toFixed(1)}%`);
	surface.style.setProperty(`--tint-${layer}-l`, `${color.lightness.toFixed(1)}%`);
}

/** Which layer each surface is fading towards, or showing. */
const fronts = new WeakMap<HTMLElement, 'a' | 'b'>();

/** The colour the surfaces are showing, or fading towards. */
let shown: ArtworkColor = DEFAULT_ARTWORK_COLOR;

/**
 * The fade in progress: the colour it left, and when it ends. Matches
 * `--dur-colour` in `app.css`.
 */
const TINT_FADE_MS = 900;
let fading: { from: ArtworkColor; until: number } | null = null;
/** The latest colour asked for while a fade was running, applied when it ends. */
let pending: ArtworkColor | null = null;
let pendingTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Starts a fade to `to`, or arranges one, without repainting a layer that is
 * on screen.
 *
 * During a fade both layers are partly visible, so there is no hidden layer to
 * write a new colour into. Writing it into the one fading out changed a
 * visible wash from one colour to another between two frames. Measured at a
 * track change on an album page: the room was sent to the page's cover and
 * back 17ms apart, the second write turned a layer at nearly full opacity from
 * red to blue in one frame, and that was the dark flash reported on the rail
 * and the player.
 *
 * So a change during a fade does one of three things. Back to the colour being
 * left: the fade reverses, which moves only opacity. The colour already being
 * faded to: nothing. Anything else: it waits for the fade to end, and only the
 * latest such colour is applied.
 *
 * A navigation also asks for the same colour twice, once when the card hands
 * it over and once when the page offers its cover; the second is the "nothing"
 * case. Restarting the fade on it cut the first short.
 */
function requestMorph(to: ArtworkColor): void {
	const now = Date.now();
	if (fading && now >= fading.until) fading = null;

	if (!fading) {
		pending = null;
		if (sameColor(shown, to)) return;
		morphTintLayers(shown, to);
		fading = { from: shown, until: now + TINT_FADE_MS };
		shown = to;
		return;
	}

	if (sameColor(shown, to)) {
		pending = null;
		return;
	}
	if (sameColor(fading.from, to)) {
		pending = null;
		reverseTintLayers();
		// A reversed transition runs for as long as the forward one had run.
		const ran = TINT_FADE_MS - (fading.until - now);
		fading = { from: shown, until: now + ran };
		shown = to;
		return;
	}
	pending = to;
	if (pendingTimer === null) {
		pendingTimer = setTimeout(() => {
			pendingTimer = null;
			const next = pending;
			pending = null;
			if (next) requestMorph(next);
		}, fading.until - now + 20);
	}
}

/** Sends every surface back towards the layer it was fading away from. */
function reverseTintLayers(): void {
	for (const surface of document.querySelectorAll<HTMLElement>('.hh-tint-morph')) {
		const back = (fronts.get(surface) ?? 'b') === 'a' ? 'b' : 'a';
		surface.style.setProperty('--tint-mix', back === 'b' ? '1' : '0');
		fronts.set(surface, back);
	}
}

/**
 * Equal to a tenth of a degree and a tenth of a percent, which is what is
 * written out. Hues are compared round the wheel: the room's hue is unwound
 * to take the short way, so the same colour can arrive as 128 or 488.
 */
function sameColor(a: ArtworkColor, b: ArtworkColor): boolean {
	const turn = (((a.hue - b.hue) % 360) + 360) % 360;
	return (
		(turn < 0.05 || turn > 359.95) &&
		Math.abs(a.saturation - b.saturation) < 0.05 &&
		Math.abs(a.lightness - b.lightness) < 0.05
	);
}

/**
 * Which request owns the room.
 *
 * Resolving a colour is asynchronous, and a navigation starts more than one:
 * the page being left withdraws its cover and the page arriving offers its own,
 * both in the same update. Without this the last one to *resolve* won, which is
 * not the same as the last one asked for. A cover already on the page resolves
 * in a microtask while one that has to be fetched takes hundreds of
 * milliseconds, so the loser could be the one that matters, and the room would
 * settle on the colour of a page nobody is looking at.
 */
let generation = 0;

/** Convenience for the common case: resolve a cover and tint an element with it. */
export async function tintFrom(target: HTMLElement, coverArt: string | null | undefined): Promise<void> {
	const mine = ++generation;
	const color = await artworkColor(coverArt);
	if (mine !== generation) return;
	applyArtworkColor(target, color);
}

/**
 * A colour for a page with no cover behind it.
 *
 * Only the hue is drawn. Saturation and lightness are fixed inside the bands
 * `analyse` clamps a real cover into, so the result is the kind of colour a
 * record could have produced rather than one the rest of the interface has
 * never had to stay readable over. The saturation sits in the upper half of
 * that band: at the 22% the idle default uses, a random hue is still mostly
 * grey, which is the right answer for "nothing is playing" and the wrong one
 * for "pick a colour".
 */
export function randomArtworkColor(): ArtworkColor {
	return { hue: Math.floor(Math.random() * 360), saturation: 30, lightness: 52 };
}

/**
 * Takes the room to a colour that did not come from a cover.
 *
 * This claims the generation, which is the whole reason it exists rather than
 * callers reaching for `applyArtworkColor`. Resolving a cover is asynchronous,
 * and a caller that wants to hold a colour is competing with whatever is
 * already in flight. On a page with no cover that is a resolve of `null`,
 * which lands a microtask later and would put the room straight back to frost.
 * Bumping the counter makes that one a loser, the same way a newer cover makes
 * an older one a loser.
 */
export function holdArtworkColor(target: HTMLElement, color: ArtworkColor): void {
	generation++;
	applyArtworkColor(target, color);
}
