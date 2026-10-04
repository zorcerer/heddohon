/**
 * Pulls an accent colour out of cover art.
 *
 * Done in the browser: on the server it would need an image decoder (`sharp`
 * is tens of megabytes of native code). Covers are same-origin from
 * `/api/cover`, so the canvas is not tainted, and a 32x32 draw costs under a
 * millisecond.
 *
 * Saturation is held under 38% and lightness pulled into a mid band. At the
 * 58% once allowed, a saturated sleeve took the interface over. Below roughly
 * 18% every hue reads as the same grey, so the range is narrow at both ends.
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
	// Hues are angles, accumulated as unit vectors: the mean of 350° and 10° in
	// raw degrees is 180°.
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

		// Saturated pixels at mid lightness weigh most: the colour a person would
		// name the sleeve by.
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
 * `extract` fetched its own 96px copy, and the colour arrived only when that
 * came back: on an album-to-album navigation the room held the previous
 * colour for 556ms after the click. The hero of the page being opened is the
 * same cover, already decoded, and is drawn straight into the sampling canvas.
 *
 * Matched on the path: the size is in the query, and with `srcset` the size
 * loaded depends on the display.
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
 * The colour of an image that is already decoded, for a page whose cover does
 * not come from `/api/cover` (a shared link serves its cover from its own
 * route). The image has to be same-origin, or the canvas is tainted and this
 * returns null.
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
		// A tainted canvas. A decorative colour is not worth throwing over.
		return null;
	}
}

/** Memoised so re-visiting an album does not re-decode its cover. */
async function artworkColor(coverArt: string | null | undefined): Promise<ArtworkColor | null> {
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

/** Writes the tint onto an element. Its subtree follows: the properties are declared `inherits: true`. */
export function applyArtworkColor(target: HTMLElement, color: ArtworkColor | null): void {
	const next = color ?? DEFAULT_ARTWORK_COLOR;

	// The short way round the colour wheel: left alone, 350° to 10° animates the
	// long way through the whole spectrum.
	//
	// The starting point is the computed value. --art-h is a registered,
	// animated property, so during a transition the inline value is the
	// destination, not what is on screen, and measuring from it sends a track
	// skipped mid-transition the long way round.
	const previous = Number.parseFloat(
		getComputedStyle(target).getPropertyValue('--art-h') || target.style.getPropertyValue('--art-h')
	);
	const from = Number.isFinite(previous) ? previous : next.hue;
	const shortest = ((next.hue - from + 540) % 360) - 180;

	target.style.setProperty('--art-h', (from + shortest).toFixed(1));
	target.style.setProperty('--art-s', `${next.saturation.toFixed(1)}%`);
	target.style.setProperty('--art-l', `${next.lightness.toFixed(1)}%`);

	// The wash on the rail and the player cross-fades between two fixed colours
	// instead of following the interpolation above, to the same destination by
	// the same short way: `from` is already unwound.
	if (typeof document !== 'undefined') {
		const landing = { ...next, hue: from + shortest };
		requestMorph(landing);
		if (target === document.documentElement) followCanvas();
	}
}

/** How long the room takes to reach a new colour: `--dur-colour` in app.css, and a frame or two. */
const CANVAS_SETTLED_MS = 1000;
let canvasTimer: ReturnType<typeof setTimeout> | undefined;
let swatch: CanvasRenderingContext2D | null = null;

/** A computed colour, in whatever notation the browser reports it, as `#rrggbb`. Null if it cannot be drawn. */
function asHex(colour: string): string | null {
	swatch ??= document.createElement('canvas').getContext('2d', { willReadFrequently: true });
	if (!swatch) return null;
	swatch.canvas.width = swatch.canvas.height = 1;
	swatch.fillStyle = '#000';
	swatch.fillStyle = colour;
	swatch.fillRect(0, 0, 1, 1);
	const [r, g, b] = swatch.getImageData(0, 0, 1, 1).data;
	return `#${[r, g, b].map((part) => part.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Keeps `theme-color` on the canvas colour (the `html` background in app.css,
 * the room's colour at the share its edges average).
 *
 * A phone paints its own bars in it: an installed app's status bar and a
 * browser tab's toolbar. Fixed at the dark theme's ground, it was a black band
 * above a room lit by a cover and above the light theme. Written at once and
 * again when the colour has finished moving, since its properties ease.
 */
export function followCanvas(): void {
	if (typeof document === 'undefined') return;
	const write = () => {
		const meta = document.querySelector('meta[name="theme-color"]');
		const colour = asHex(getComputedStyle(document.documentElement).backgroundColor);
		if (meta && colour) meta.setAttribute('content', colour);
	};
	write();
	clearTimeout(canvasTimer);
	canvasTimer = setTimeout(write, CANVAS_SETTLED_MS);
}

/**
 * Hands the two cross-fading surfaces their before and after.
 *
 * They are found by class: the tint is applied at the document root by a
 * caller that does not know which elements paint it, and at most two are on
 * screen.
 *
 * The two layers take turns: the new colour goes into the hidden one, and
 * `--tint-mix` moves towards it. `app.css`, by `.hh-tint-morph`, records the
 * reset this replaced.
 *
 * The layer on screen is written too, with the colour it already shows. Until
 * the first change it has no colour of its own and reads the room's
 * `--art-*`, which start moving at the same moment. Called only with no fade
 * in progress (see `requestMorph`), so neither write lands on a layer visible
 * in a different colour.
 */
function morphTintLayers(from: ArtworkColor, to: ArtworkColor): void {
	const surfaces = document.querySelectorAll<HTMLElement>('.hh-tint-morph');
	for (const surface of surfaces) {
		// `--tint-mix` starts at 1 in `app.css`, so the second layer is the one on
		// screen for a surface that has not changed colour yet.
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

/** The fade in progress: the colour it left, and when it ends. Matches `--dur-colour` in `app.css`. */
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
 * write into. At a track change on an album page the room was sent to the
 * page's cover and back 17ms apart, and the second write turned a layer at
 * nearly full opacity from red to blue in one frame: the dark flash reported
 * on the rail and the player.
 *
 * So a change during a fade does one of three things. Back to the colour being
 * left: the fade reverses, which moves only opacity. The colour already being
 * faded to: nothing. Anything else: it waits for the fade to end, and only the
 * latest such colour is applied.
 *
 * A navigation asks for the same colour twice, once when the card hands it
 * over and once when the page offers its cover. The second is the "nothing"
 * case: restarting the fade on it cut the first short.
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
 * written out. Hues are compared round the wheel: the room's hue is unwound to
 * take the short way, so one colour can arrive as 128 or 488.
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
 * the page being left withdraws its cover and the arriving page offers its
 * own. Without this the last to resolve won, not the last asked for. A cover
 * on the page resolves in a microtask and a fetched one in hundreds of
 * milliseconds, so the room could settle on the colour of the page left.
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
 * `analyse` clamps a real cover into, so the interface stays readable over it.
 * The saturation is in the upper half of the band: at the idle default's 22%
 * a random hue is still mostly grey.
 */
export function randomArtworkColor(): ArtworkColor {
	return { hue: Math.floor(Math.random() * 360), saturation: 30, lightness: 52 };
}

/**
 * Takes the room to a colour that did not come from a cover.
 *
 * It claims the generation, which `applyArtworkColor` alone does not. On a
 * page with no cover, a resolve of `null` already in flight lands a microtask
 * later and would put the room back to frost. Bumping the counter makes that
 * one lose, as a newer cover makes an older one lose.
 */
export function holdArtworkColor(target: HTMLElement, color: ArtworkColor): void {
	generation++;
	applyArtworkColor(target, color);
}
