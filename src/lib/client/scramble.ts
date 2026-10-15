/**
 * Terminal's change of track: the new title resolves out of other glyphs, from
 * its first letter to its last, and is whole when the time is up.
 *
 * It writes into the element's own text node, which Svelte made and still
 * holds, so the next title Svelte writes lands in the same node. The text to
 * end on is read from `data-text` on every frame and not kept from the start:
 * a second change of track during the first one's 340ms would otherwise end
 * on the title before it.
 *
 * For a fixed-width face only. In a proportional one every frame is a
 * different width, and the line jitters.
 */
const GLYPHS = 'abcdefghijklmnopqrstuvwxyz0123456789#%&/<>[]{}=+*-';

/** The glyphs change every third frame: at 60 a second they are a blur, not letters. */
const HOLD_FRAMES = 3;

/** Starts the effect on `element` and returns what stops it, leaving the finished text. */
export function scramble(element: HTMLElement, duration: number): () => void {
	const text = element.firstChild;
	if (!(text instanceof Text)) return () => {};
	const final = () => element.dataset.text ?? text.data;
	const started = performance.now();
	let frame = 0;
	let count = 0;
	let noise = '';

	const step = (now: number) => {
		const target = final();
		const progress = Math.min(1, (now - started) / duration);
		if (progress >= 1) {
			text.data = target;
			return;
		}
		if (count++ % HOLD_FRAMES === 0) {
			noise = Array.from(target, (letter) =>
				letter === ' ' ? ' ' : GLYPHS[Math.floor(Math.random() * GLYPHS.length)]
			).join('');
		}
		const settled = Math.floor(target.length * progress);
		text.data = target.slice(0, settled) + noise.slice(settled, target.length);
		frame = requestAnimationFrame(step);
	};
	frame = requestAnimationFrame(step);

	return () => {
		cancelAnimationFrame(frame);
		text.data = final();
	};
}
