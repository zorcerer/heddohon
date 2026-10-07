/**
 * The motion tokens in `app.css`, for Svelte transitions and `animate:`.
 *
 * Svelte's transitions take an easing function, not a CSS curve, so the curves
 * are solved here from the four numbers the stylesheet uses, and both move
 * identically.
 */
import { afterNavigate } from '$app/navigation';
import { onDestroy } from 'svelte';
import { prefersReducedMotion, sleeveTransition } from './sleeve-transition.svelte';

export const DUR = {
	press: 120,
	hover: 220,
	state: 340,
	travel: 480
} as const;

/**
 * A CSS `cubic-bezier()` as an easing function: x is time, y is progress.
 * Newton's method on x, falling back to bisection where the slope is flat.
 */
function bezier(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
	const cx = 3 * x1;
	const bx = 3 * (x2 - x1) - cx;
	const ax = 1 - cx - bx;
	const cy = 3 * y1;
	const by = 3 * (y2 - y1) - cy;
	const ay = 1 - cy - by;
	const x = (s: number) => ((ax * s + bx) * s + cx) * s;
	const y = (s: number) => ((ay * s + by) * s + cy) * s;
	const dx = (s: number) => (3 * ax * s + 2 * bx) * s + cx;

	return (t: number) => {
		if (t <= 0) return 0;
		if (t >= 1) return 1;
		let s = t;
		for (let i = 0; i < 8; i++) {
			const error = x(s) - t;
			if (Math.abs(error) < 1e-5) return y(s);
			const slope = dx(s);
			if (Math.abs(slope) < 1e-6) break;
			s -= error / slope;
		}
		let lo = 0;
		let hi = 1;
		s = t;
		for (let i = 0; i < 24; i++) {
			if (x(s) < t) lo = s;
			else hi = s;
			s = (lo + hi) / 2;
		}
		return y(s);
	};
}

/** `--ease-out`: leaves at speed, settles slowly. */
export const easeOut = bezier(0.22, 1, 0.36, 1);
/** The same curve as a CSS string, for the Web Animations API, which does not read custom properties. */
export const EASE_OUT_CSS = 'cubic-bezier(0.22, 1, 0.36, 1)';
/** `--ease-exit`: gathers speed and goes. */
export const easeExit = bezier(0.55, 0, 1, 0.45);

/** A duration, or 0 for someone who has asked for less motion. */
export function motion(duration: number): number {
	return prefersReducedMotion() ? 0 : duration;
}

/**
 * Brings a page's heading block in from left to right: each line is revealed
 * by a soft edge crossing it as it slides 0.5rem into place, 60ms apart, then
 * the controls fade and slide in the same way.
 *
 * The reveal is a mask moved across the line (a gradient three times the
 * line's width: opaque, fading, clear), so it applies only to `lines`, which
 * must hold no glass: a mask on an ancestor of glass drops its blur.
 * `controls` may be glass and get opacity and translate on their own element.
 *
 * Returns a function that cancels whatever is still running.
 */
function sweepIn(lines: HTMLElement[], controls: HTMLElement[] = []): () => void {
	if (prefersReducedMotion()) return () => {};
	const running: Animation[] = [];
	const mask = 'linear-gradient(90deg, #000 33.3%, transparent 66.6%)';

	lines.forEach((line, index) => {
		line.style.setProperty('mask-image', mask);
		line.style.setProperty('-webkit-mask-image', mask);
		line.style.setProperty('mask-size', '300% 100%');
		line.style.setProperty('-webkit-mask-size', '300% 100%');
		line.style.setProperty('mask-repeat', 'no-repeat');
		line.style.setProperty('-webkit-mask-repeat', 'no-repeat');
		const animation = line.animate(
			[
				{ maskPosition: '100% 0', webkitMaskPosition: '100% 0', translate: '-0.5rem 0' },
				{ maskPosition: '0% 0', webkitMaskPosition: '0% 0', translate: '0 0' }
			],
			{ duration: DUR.travel, delay: index * 60, easing: EASE_OUT_CSS, fill: 'backwards' }
		);
		const clear = () => {
			for (const name of ['mask-image', 'mask-size', 'mask-repeat']) {
				line.style.removeProperty(name);
				line.style.removeProperty(`-webkit-${name}`);
			}
		};
		animation.finished.then(clear, clear);
		running.push(animation);
	});

	const after = lines.length * 60 + 80;
	controls.forEach((control, index) => {
		running.push(
			control.animate(
				[
					{ opacity: 0, translate: '-0.5rem 0' },
					{ opacity: 1, translate: '0 0' }
				],
				{ duration: DUR.state, delay: after + index * 40, easing: EASE_OUT_CSS, fill: 'backwards' }
			)
		);
	});

	return () => {
		for (const animation of running) animation.cancel();
	};
}

/** The cover and the track list of a heading's page; see `heroSweep`. */
function arrive(block: HTMLElement, withCover: boolean): () => void {
	if (prefersReducedMotion()) return () => {};
	const running: Animation[] = [];
	const cover = withCover ? block.closest('.hero')?.querySelector<HTMLElement>('.art, .portrait') : null;
	if (cover) {
		running.push(
			cover.animate(
				[
					{ opacity: 0, scale: '0.96', filter: 'blur(10px)' },
					{ opacity: 1, scale: '1', filter: 'blur(0px)' }
				],
				{ duration: DUR.travel, easing: EASE_OUT_CSS, fill: 'backwards' }
			)
		);
	}
	const rows = [...document.querySelectorAll<HTMLElement>('.content .tracks > li')];
	rows.forEach((row, index) => {
		running.push(
			row.animate(
				[
					{ opacity: 0, translate: '0 -0.6rem' },
					{ opacity: 1, translate: '0 0' }
				],
				{ duration: DUR.state, delay: 160 + Math.min(index, 14) * 28, easing: EASE_OUT_CSS, fill: 'backwards' }
			)
		);
	});
	return () => {
		for (const animation of running) animation.cancel();
	};
}

/**
 * A page heading that sweeps in (`sweepIn`) whenever the page is reached by a
 * navigation, including between two pages of one kind, which reuses the
 * component, and never on a server-rendered first paint. Called while the
 * component initialises; attach what it returns to the heading block.
 *
 * The block's children are its lines, and the buttons and links inside its
 * `.actions` are its controls. A line holding glass (a rename form) is left
 * out of the sweep, and the controls are animated one by one, since a mask or
 * opacity on an ancestor of glass drops its blur.
 *
 * The page's other parts arrive with it: the cover beside the heading fades
 * up from a blur (unless the sleeve morph carried it in from a card), and the
 * track list's rows drop into place from just above, 28ms apart for the first
 * 14.
 */
export function heroSweep(): (node: HTMLElement) => () => void {
	let block: HTMLElement | null = null;
	let cancel: (() => void) | null = null;
	afterNavigate(({ from }) => {
		if (!from || !block) return;
		cancel?.();
		const children = [...block.children] as HTMLElement[];
		const actions = children.find((el) => el.classList.contains('actions')) ?? null;
		const lines = children.filter(
			(el) => el !== actions && !el.matches('.hh-button, .hh-input, .hh-glass') && !el.querySelector('.hh-button, .hh-input, .hh-glass')
		);
		const controls = actions ? ([...actions.querySelectorAll('button, a')] as HTMLElement[]) : [];
		const stopSweep = sweepIn(lines, controls);
		const others = arrive(block, sleeveTransition.activeId === null);
		cancel = () => {
			stopSweep();
			others();
		};
	});
	onDestroy(() => cancel?.());
	return (node) => {
		block = node;
		return () => {
			if (block === node) block = null;
		};
	};
}

/*
 * ── The glyph in a pressed control ──────────────────────────────────────
 *
 * A press is answered on the icon, in a way that says what the control did:
 * skip throws its glyph the way the queue went and brings a new one in from
 * behind, shuffle turns its arrows over, repeat goes once round, a toggle
 * pops. The icon moves and the button does not: a button in the player sits
 * on glass, and `app.css` keeps transforms off glass. Opacity goes on the svg,
 * which holds none.
 */

/** The spring from `--ease-spring`, which a script cannot name as a variable. */
function springCss(): string {
	if (typeof document === 'undefined') return EASE_OUT_CSS;
	const value = getComputedStyle(document.documentElement).getPropertyValue('--ease-spring').trim();
	return value || EASE_OUT_CSS;
}

function glyphOf(control: Element | null): SVGElement | null {
	return control?.querySelector('svg') ?? null;
}

/**
 * Next (1) or previous (-1): the glyph leaves the way the queue moved, and
 * its replacement slides in from the other side and settles on the spring.
 */
export function skipGlyph(control: Element | null, direction: 1 | -1): void {
	const glyph = glyphOf(control);
	const duration = motion(DUR.travel);
	if (!glyph || duration === 0) return;
	const travel = `${direction * 0.7}rem`;
	const from = `${-direction * 0.7}rem`;
	glyph.animate(
		[
			{ translate: '0 0', opacity: 1 },
			{ translate: `${travel} 0`, opacity: 0, offset: 0.35 },
			{ translate: `${from} 0`, opacity: 0, offset: 0.36 },
			{ translate: '0 0', opacity: 1 }
		],
		{ duration, easing: EASE_OUT_CSS }
	);
}

/** Turns the glyph over about its vertical axis: the shuffle arrows changing sides. */
export function flipGlyph(control: Element | null): void {
	const glyph = glyphOf(control);
	const duration = motion(DUR.travel);
	if (!glyph || duration === 0) return;
	glyph.animate([{ transform: 'rotateY(180deg)' }, { transform: 'rotateY(0deg)' }], {
		duration,
		easing: springCss()
	});
}

/** Once round, the way the repeat arrows point. */
export function turnGlyph(control: Element | null): void {
	const glyph = glyphOf(control);
	const duration = motion(DUR.travel);
	if (!glyph || duration === 0) return;
	glyph.animate([{ rotate: '-180deg' }, { rotate: '0deg' }], { duration, easing: springCss() });
}

/** Swells from under size and settles: a toggle taking effect. */
export function popGlyph(control: Element | null): void {
	const glyph = glyphOf(control);
	const duration = motion(DUR.state);
	if (!glyph || duration === 0) return;
	glyph.animate([{ scale: 0.7 }, { scale: 1 }], { duration, easing: springCss() });
}
