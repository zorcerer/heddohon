/**
 * The motion tokens in `app.css`, for Svelte transitions and `animate:`.
 *
 * Svelte runs its own transitions in JavaScript and takes an easing function
 * rather than a CSS curve, so the curves are solved here from the same four
 * numbers the stylesheet uses. A transition written with these and a CSS
 * transition written with the tokens move identically.
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

/**
 * `--ease-spring`: the damped spring the stylesheet samples with `linear()`,
 * computed rather than sampled (damping ratio 0.7, 4.6 percent overshoot).
 */
export function easeSpring(t: number): number {
	if (t <= 0) return 0;
	if (t >= 1) return 1;
	const zeta = 0.7;
	const damped = Math.sqrt(1 - zeta * zeta);
	// The time at which the spring is within 0.1 percent of rest, for unit
	// natural frequency; the curve is stretched so that is t = 1.
	const time = t * 10.28;
	return 1 - Math.exp(-zeta * time) * (Math.cos(damped * time) + (zeta / damped) * Math.sin(damped * time));
}

/** A duration, or 0 for someone who has asked for less motion. */
export function motion(duration: number): number {
	return prefersReducedMotion() ? 0 : duration;
}

/**
 * Brings a page's heading block in from left to right: each line is revealed
 * by a soft edge crossing it as it slides 0.5rem into place, one line after
 * another, 60ms apart; then the controls fade and slide in the same way.
 *
 * The reveal is a mask moved across the line (a gradient three times the
 * line's width, opaque, then fading, then clear), so it applies only to
 * `lines`, which must hold no glass: a mask on an ancestor of glass drops its
 * blur. `controls` may be glass themselves and get opacity and translate on
 * their own element, which leaves their blur alone.
 *
 * Returns a function that cancels whatever is still running.
 */
export function sweepIn(lines: HTMLElement[], controls: HTMLElement[] = []): () => void {
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
 * navigation, including from one page of its kind to another, which reuses
 * the component, and never on a server-rendered first paint. Called while
 * the component initialises; attach what it returns to the heading block.
 *
 * The block's children are its lines, and the buttons and links inside its
 * `.actions` are its controls. A line holding glass (a rename form's buttons
 * and field) is left out of the sweep rather than masked, and the controls
 * are animated one by one rather than through a group around them, since
 * both a mask and opacity on an ancestor of glass drop its blur.
 *
 * With it, the page's other parts arrive: the cover beside the heading fades
 * up from a blur (not when the sleeve has carried it in from a card: the
 * morph is its arrival), and the rows of the page's track list drop into
 * place from just above, one after another, 28ms apart for the first 14.
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
