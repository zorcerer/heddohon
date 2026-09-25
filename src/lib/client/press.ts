/**
 * Starts the press effect on a `.hh-button` where it is pressed; the effect
 * itself is in `app.css`. One listener on the document, installed once by
 * the root layout, rather than a handler on every button.
 */
import { prefersReducedMotion } from './sleeve-transition.svelte';

export function installPress(): () => void {
	const onDown = (event: PointerEvent) => {
		if (event.button !== 0 || prefersReducedMotion()) return;
		const button = (event.target as Element | null)?.closest?.('.hh-button');
		if (!(button instanceof HTMLElement) || (button as HTMLButtonElement).disabled) return;
		const box = button.getBoundingClientRect();
		button.style.setProperty('--press-x', `${event.clientX - box.left}px`);
		button.style.setProperty('--press-y', `${event.clientY - box.top}px`);
		// Off and on again, with a style read between, so a press during the last
		// one's ripple starts a new one.
		button.classList.remove('pressed');
		void button.offsetWidth;
		button.classList.add('pressed');
	};
	const onEnd = (event: AnimationEvent) => {
		if (event.animationName === 'press-ripple' && event.target instanceof HTMLElement) {
			event.target.classList.remove('pressed');
		}
	};
	document.addEventListener('pointerdown', onDown, { passive: true });
	document.addEventListener('animationend', onEnd);
	return () => {
		document.removeEventListener('pointerdown', onDown);
		document.removeEventListener('animationend', onEnd);
	};
}
