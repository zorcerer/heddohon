/**
 * The player sheet on a phone turning into the dock as it closes, and back
 * out of it as it opens.
 *
 * The sheet shrinks into the dock's outline while its contents fade, and the
 * cover flies from the top of the sheet to the thumbnail in the dock. Before,
 * it slid off the foot of the screen and left the dock behind, unrelated.
 *
 * Everything that moves obeys the glass rules in `app.css`. The sheet's
 * wrapper is transformed, and a transform is not a backdrop root, so the panel
 * keeps its blur. Opacity goes on the panel's contents, never on the panel or
 * anything around it. The flying cover is an image of its own, over
 * everything, holding no glass.
 *
 * The CSS slide stays for what this does not cover: a wider screen, reduced
 * motion, and nothing playing (so no dock row to land in).
 */
import { tick } from 'svelte';
import { DUR, EASE_OUT_CSS } from './motion';
import { takeRelease } from './sheet.svelte';

/**
 * `morphing` holds the wrapper where the transform can move it (untranslated,
 * visible, no CSS transition) for the length of the animation. `parking` is
 * the one frame after a close in which the closed state lands without its
 * transition, so the sheet does not slide off from where the morph left it.
 */
export const sheetMorph = $state<{ phase: 'morphing' | 'parking' | null }>({ phase: null });

let running: Animation[] = [];
let ghost: HTMLImageElement | null = null;
let hiddenArt: HTMLElement | null = null;

function cleanUp() {
	for (const animation of running) animation.cancel();
	running = [];
	ghost?.remove();
	ghost = null;
	if (hiddenArt) hiddenArt.style.visibility = '';
	hiddenArt = null;
}

/** The cover's image in `root`, if it has one decoded to show. */
function coverIn(root: Element | null): HTMLImageElement | null {
	const image = root?.querySelector<HTMLImageElement>('img.current');
	return image && image.complete && image.naturalWidth > 0 ? image : null;
}

function place(el: HTMLElement, box: DOMRect) {
	el.style.left = `${box.left}px`;
	el.style.top = `${box.top}px`;
	el.style.width = `${box.width}px`;
	el.style.height = `${box.height}px`;
}

/**
 * Starts the morph for a sheet that is `opening` or closing. Called in the
 * update that changes `panelOpen`, so the wrapper is held by `morphing` before
 * the CSS slide can start.
 */
export function morphSheet(opening: boolean) {
	cleanUp();
	const from = opening ? 0 : takeRelease();
	sheetMorph.phase = 'morphing';
	void tick().then(() => run(opening, from));
}

function run(opening: boolean, pulled: number) {
	const wrapper = document.querySelector<HTMLElement>('.app > .player');
	const panel = wrapper?.querySelector<HTMLElement>('aside.panel');
	const dock = document.querySelector<HTMLElement>('.phone-dock');
	const dockArt = dock?.querySelector<HTMLElement>('.art') ?? null;
	if (!wrapper || !panel || !dock || !dockArt) {
		sheetMorph.phase = null;
		return;
	}

	const duration = opening ? DUR.travel : 440;
	const sheet = wrapper.getBoundingClientRect();
	const target = dock.getBoundingClientRect();
	// Both covers are measured before anything is animated. With `fill: 'both'`
	// the wrapper's first keyframe applies when it is created, and the sheet's
	// cover measured after it came out squashed to the dock: 367 by 74 instead
	// of 367 by 517 at 393 by 852. The flying cover then opened into a strip
	// across the dock. Closing after a pull, the pull was counted twice.
	const sheetArt = panel.querySelector<HTMLElement>('.stage .art');
	const big = sheetArt?.getBoundingClientRect();
	const small = dockArt.getBoundingClientRect();
	const sx = target.width / sheet.width;
	const sy = target.height / sheet.height;
	const docked = `translate(${target.left - sheet.left}px, ${target.top - sheet.top}px) scale(${sx}, ${sy})`;
	const lifted = `translate(0px, ${pulled}px) scale(1, 1)`;

	// The corners are drawn in the panel's own space, which is scaled by a
	// different amount each way. These radii come out as the dock's once scaled.
	const radius = getComputedStyle(panel).borderTopLeftRadius;
	const dockRadius = Number.parseFloat(getComputedStyle(dock).borderTopLeftRadius);
	const squashed = `${dockRadius / sx}px / ${dockRadius / sy}px`;

	const options: KeyframeAnimationOptions = { duration, easing: EASE_OUT_CSS, fill: 'both' };
	wrapper.style.transformOrigin = '0 0';
	running.push(
		wrapper.animate({ transform: opening ? [docked, 'none'] : [lifted, docked] }, options),
		panel.animate({ borderRadius: opening ? [squashed, radius] : [radius, squashed] }, options)
	);

	// Gone by 30 percent on the way down, and in from halfway on the way up: the
	// controls are not shown squeezed to a 60px strip.
	const fade = opening
		? [{ opacity: 0 }, { opacity: 0, offset: 0.5 }, { opacity: 1 }]
		: [{ opacity: 1 }, { opacity: 0, offset: 0.3 }, { opacity: 0 }];
	for (const part of panel.querySelectorAll<HTMLElement>(':scope > .grabber, :scope > .stage, :scope > .chrome')) {
		running.push(part.animate(fade, { duration, easing: 'linear', fill: 'both' }));
	}

	// The cover, between the top of the sheet and the thumbnail in the dock.
	const image = coverIn(sheetArt) ?? coverIn(dockArt);
	// The sheet's own cover is hidden for the whole morph, so the flying one is
	// the only cover on screen. The fade alone left it showing, squashed, for
	// the first 30 percent of a close (down to 0.32 of its height at 120ms) and
	// from halfway through an open.
	if (sheetArt) {
		hiddenArt = sheetArt;
		sheetArt.style.visibility = 'hidden';
	}
	if (sheetArt && big && image) {
		const start = opening ? small : new DOMRect(big.left, big.top + pulled, big.width, big.height);
		const end = opening ? big : small;
		ghost = document.createElement('img');
		ghost.src = image.currentSrc || image.src;
		ghost.alt = '';
		ghost.setAttribute('aria-hidden', 'true');
		ghost.className = 'hh-cover-ghost';
		place(ghost, start);
		document.body.append(ghost);
		// The sheet's cover rounds its top corners only, on the image itself.
		const bigRadius = getComputedStyle(sheetArt.querySelector('img') ?? sheetArt).borderRadius;
		const smallRadius = getComputedStyle(dockArt).borderRadius;
		const box = (rect: DOMRect, r: string) => ({
			left: `${rect.left}px`,
			top: `${rect.top}px`,
			width: `${rect.width}px`,
			height: `${rect.height}px`,
			borderRadius: r
		});
		running.push(
			ghost.animate(
				opening ? [box(start, smallRadius), box(end, bigRadius)] : [box(start, bigRadius), box(end, smallRadius)],
				options
			)
		);
	}

	// Finished by the animation, or by the clock if the animation is held up. A
	// page that stops drawing frames (a backgrounded tab, or headless WebKit,
	// where this was found) leaves it pending, and a sheet held mid-morph
	// cannot be pressed.
	const mine = ++generation;
	const done = () => {
		if (mine === generation) finish(opening);
	};
	const fallback = setTimeout(done, duration + 200);
	void running[0].finished.then(
		() => {
			clearTimeout(fallback);
			done();
		},
		() => clearTimeout(fallback)
	);
}

/** Which morph is current, so a finish from an earlier one does nothing. */
let generation = 0;

function finish(opening: boolean) {
	generation++;
	const wrapper = document.querySelector<HTMLElement>('.app > .player');
	if (opening) {
		sheetMorph.phase = null;
		cleanUp();
		if (wrapper) wrapper.style.transformOrigin = '';
		return;
	}
	// Closed: the closed state lands with its transition held off, so the sheet
	// is hidden where it is and does not slide away. Styles are read once with
	// `parking` on, which settles the closed state before the class comes off.
	// Waiting a frame for it would never end where no frames are drawn.
	sheetMorph.phase = 'parking';
	void tick().then(() => {
		cleanUp();
		if (wrapper) {
			wrapper.style.transformOrigin = '';
			void getComputedStyle(wrapper).visibility;
		}
		if (sheetMorph.phase === 'parking') sheetMorph.phase = null;
	});
}
