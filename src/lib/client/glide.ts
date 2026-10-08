/**
 * Carries what is on a page across a change of its layout: each element
 * starts drawn where it was and moves to where it now is, by a transform.
 *
 * The layout itself changes in one step. That costs one layout and one paint
 * where animating the width costs both on every frame, and left alone it
 * reads as a jump: a grid of albums takes a new column count in one frame,
 * and the buttons at the end of a heading are somewhere else. Measured before
 * the change and again after it, an element is given the offset that puts it
 * back where it was, and the offset is run down to nothing, which the
 * compositor does without the page being laid out or painted again. The root
 * layout uses it for the player panel on a wide screen; the styles there say
 * what else was tried.
 *
 * What is carried, looking down from the pages (the children of `root`):
 *
 *  - An element that kept its size and moved, as one piece with everything in
 *    it: a page narrower than its column, a row of buttons, a duration at the
 *    end of a track's row, a word that went to the next line.
 *  - A card, which changes size as well: a child of anything marked
 *    `data-glide`, and a picture. It is scaled as one piece, text and all, by
 *    the ratio its box changed by, which on the album grid is within a fifth.
 *
 * An element that changed size and is neither is left to take its new box at
 * once, and what is in it is looked at in the same way: a heading given more
 * room does not move, and the buttons at its far end do.
 */
import { DUR, EASE_OUT_CSS } from './motion';

/** The animations this makes, so a second glide can end the first one's. */
const ID = 'glide';
/** Below these a move is not worth an animation: half a pixel, and a fifth of a percent of size. */
const MOVED_PX = 0.5;
const SCALED = 0.002;
/** A box within this of its old size is the same size. Widths are fractions of a pixel in a grid. */
const SAME_PX = 1;
/** How far below a page the looking goes. A track's row is five down, its controls seven. */
const MAX_DEPTH = 10;
/**
 * The most elements moved at once. Each is a layer for the compositor: a
 * screen of albums is about 40 and a screen of tracks about 100. Past this the
 * rest take their places at once, which a page that dense does anyway.
 */
const MAX_MOVED = 300;

interface Noted {
	element: HTMLElement;
	box: DOMRect;
	/** Scaled as one piece where its size changes. */
	unit: boolean;
	children: Noted[];
}

const PICTURES = new Set(['IMG', 'PICTURE', 'VIDEO', 'CANVAS']);

function note(element: HTMLElement, depth: number, height: number): Noted {
	const box = element.getBoundingClientRect();
	const unit = PICTURES.has(element.tagName) || element.parentElement?.hasAttribute('data-glide') === true;
	const noted: Noted = { element, box, unit, children: [] };
	// A change of width moves rows up and down the page. One that arrives from
	// further than a screen away is not seen arriving, so what is in it is not
	// looked at.
	const far = box.height > 0 && (box.bottom < -height || box.top > 2 * height);
	if (!unit && !far && depth < MAX_DEPTH) {
		for (const child of element.children) {
			if (child instanceof HTMLElement) noted.children.push(note(child, depth + 1, height));
		}
	}
	return noted;
}

/** An element's own `translate`, in pixels, which the offset is added to. Null where it is not in pixels. */
function resting(element: HTMLElement): [number, number] | null {
	const value = getComputedStyle(element).translate;
	if (!value || value === 'none') return [0, 0];
	const parts = value.split(' ');
	if (!parts.every((part) => part.endsWith('px'))) return null;
	return [parseFloat(parts[0]), parseFloat(parts[1] ?? '0')];
}

/**
 * Notes where everything under `root` is, to be called before the layout
 * changes. The function returned is called once it has: it puts everything
 * back where it was, held there, and returns the function that lets it go.
 * The two are apart so that the frame the page is laid out in, which is a
 * long one, is drawn with nothing moved, and the moving starts in the next:
 * started in the long frame, a move is part-way through when it is first
 * seen.
 *
 * A glide still running is taken from where its elements are drawn, since a
 * box is measured with its transform. A second press during the slide turns
 * everything round from there.
 */
export function glideFrom(root: HTMLElement): () => () => void {
	const height = window.innerHeight;
	const pages: Noted[] = [];
	for (const page of root.children) {
		if (page instanceof HTMLElement) pages.push(note(page, 0, height));
	}

	return () => {
		// Ended before the new places are read: a box is measured with its transform.
		for (const animation of document.getAnimations()) if (animation.id === ID) animation.cancel();

		/*
		 * Read first, written after. Starting an animation leaves the page's
		 * styles to be worked out again, and a box read after that waits for it:
		 * read and started one element at a time, headless WebKit spent 430 to
		 * 900ms in the first frame on the album grid, against 250ms for the
		 * layout alone.
		 */
		const plan: { element: HTMLElement; x: number; y: number; sx: number; sy: number }[] = [];
		const carry = ({ element, box: from, unit, children }: Noted) => {
			if (plan.length >= MAX_MOVED) return;
			const to = element.getBoundingClientRect();
			// Not drawn before or not drawn now. It has no box of its own to move;
			// what is in it may have (`display: contents`).
			if (from.width === 0 || from.height === 0 || to.width === 0 || to.height === 0) {
				children.forEach(carry);
				return;
			}
			const kept = Math.abs(from.width - to.width) <= SAME_PX && Math.abs(from.height - to.height) <= SAME_PX;
			if (!unit && !kept) {
				children.forEach(carry);
				return;
			}
			// Neither on the screen before nor on it now: it moves unseen.
			if ((from.bottom < 0 || from.top > height) && (to.bottom < 0 || to.top > height)) return;
			const x = from.left - to.left;
			const y = from.top - to.top;
			const sx = unit ? from.width / to.width : 1;
			const sy = unit ? from.height / to.height : 1;
			const scaled = Math.abs(sx - 1) >= SCALED || Math.abs(sy - 1) >= SCALED;
			if (Math.abs(x) < MOVED_PX && Math.abs(y) < MOVED_PX && !scaled) return;
			plan.push({ element, x, y, sx, sy });
		};
		pages.forEach(carry);

		// `translate` and `scale`, not `transform`, which an element may have
		// one of that is to stay as it is. They apply before it.
		const rests = plan.map(({ element }) => resting(element) ?? [0, 0]);
		const held = plan.map(({ element, x, y, sx, sy }, i) => {
			const rest = rests[i];
			const start: Keyframe = { translate: `${rest[0] + x}px ${rest[1] + y}px` };
			const end: Keyframe = { translate: `${rest[0]}px ${rest[1]}px` };
			if (Math.abs(sx - 1) >= SCALED || Math.abs(sy - 1) >= SCALED) {
				start.scale = `${sx} ${sy}`;
				end.scale = '1 1';
				start.transformOrigin = end.transformOrigin = 'top left';
			}
			const animation = element.animate([start, end], { id: ID, duration: DUR.travel, easing: EASE_OUT_CSS });
			// Held on its first frame, which is the element where it was.
			animation.pause();
			return animation;
		});
		return () => {
			// One ended since by a later glide is left ended.
			for (const animation of held) if (animation.playState === 'paused') animation.play();
		};
	};
}
