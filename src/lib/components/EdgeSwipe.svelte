<script lang="ts">
	import { afterNavigate } from '$app/navigation';
	import { ownBack } from '#lib/client/own-back.svelte.ts';
	import { player } from '#lib/client/player.svelte.ts';
	import { prefersReducedMotion } from '#lib/client/sleeve-transition.svelte.ts';

	/*
	 * Back by a swipe from the left edge, in the iPhone home-screen app, where
	 * the history is the app's own (`own-back.svelte.ts`) and iOS has nothing
	 * to swipe back to. The page alone follows the finger: the dock and the
	 * player are outside it and stay where they are. Let go past a third of
	 * the width, or flicked, it goes the rest of the way and the page behind
	 * comes in; short of that it goes back.
	 *
	 * Written here and not taken from Svelte Bits, which has no such gesture;
	 * the exception is in the styling notes.
	 */
	let { target }: { target: HTMLElement | null } = $props();

	/** How far in from the edge a touch starts a swipe, in CSS pixels. */
	const EDGE = 24;
	/** Movement before the swipe decides between across and up or down. */
	const DECIDE = 8;
	const COMMIT_SHARE = 1 / 3;
	/** px per ms; a flick goes back however short it is. */
	const FLICK = 0.5;
	const SETTLE_MS = 220;

	let start: { x: number; y: number; at: number; id: number } | null = null;
	let axis: 'x' | 'y' | null = null;
	let dx = 0;
	let leaving = false;

	const ready = () => ownBack.active && ownBack.depth > 0 && player.sheetLayout && !player.panelOpen && !leaving;

	function place(offset: number, ms = 0) {
		if (!target) return;
		target.style.transition = ms ? `translate ${ms}ms var(--ease-out)` : 'none';
		target.style.translate = offset ? `${offset}px 0` : '';
	}

	function clear() {
		if (!target) return;
		target.style.transition = '';
		target.style.translate = '';
	}

	function down(event: TouchEvent) {
		const touch = event.touches[0];
		if (event.touches.length !== 1 || !touch || touch.clientX > EDGE || !ready()) return;
		start = { x: touch.clientX, y: touch.clientY, at: event.timeStamp, id: touch.identifier };
		axis = null;
		dx = 0;
	}

	function move(event: TouchEvent) {
		if (!start) return;
		const touch = [...event.touches].find((each) => each.identifier === start!.id);
		if (!touch) return;
		const x = touch.clientX - start.x;
		const y = touch.clientY - start.y;
		if (!axis) {
			if (Math.abs(x) < DECIDE && Math.abs(y) < DECIDE) return;
			axis = x > 0 && Math.abs(x) > Math.abs(y) ? 'x' : 'y';
			if (axis === 'y') {
				start = null;
				return;
			}
		}
		// Across: the page follows, and does not scroll under the finger.
		event.preventDefault();
		dx = Math.max(0, x);
		place(dx);
	}

	function up(event: TouchEvent) {
		if (!start || axis !== 'x') {
			start = null;
			return;
		}
		const width = innerWidth;
		const speed = dx / Math.max(1, event.timeStamp - start.at);
		start = null;
		if (dx > width * COMMIT_SHARE || speed > FLICK) {
			leaving = true;
			const ms = prefersReducedMotion() ? 0 : SETTLE_MS;
			place(width, ms);
			setTimeout(() => {
				if (!ownBack.back()) {
					leaving = false;
					clear();
				}
			}, ms);
		} else {
			place(0, prefersReducedMotion() ? 0 : SETTLE_MS);
			setTimeout(clear, SETTLE_MS);
		}
	}

	function cancel() {
		if (start && axis === 'x') {
			place(0, SETTLE_MS);
			setTimeout(clear, SETTLE_MS);
		}
		start = null;
	}

	// The page behind has arrived: it is drawn in place, with the arrival the layout gives every page.
	afterNavigate(() => {
		if (!leaving) return;
		leaving = false;
		clear();
	});

	$effect(() => {
		if (!ownBack.active) return;
		// `move` is not passive: it holds the page still while it slides.
		const options = { passive: false } as const;
		addEventListener('touchstart', down, { passive: true });
		addEventListener('touchmove', move, options);
		addEventListener('touchend', up);
		addEventListener('touchcancel', cancel);
		return () => {
			removeEventListener('touchstart', down);
			removeEventListener('touchmove', move);
			removeEventListener('touchend', up);
			removeEventListener('touchcancel', cancel);
		};
	});
</script>
