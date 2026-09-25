<script lang="ts">
	/**
	 * A pointer-driven scrub bar. It deliberately does not use <input range>:
	 * the buffered-ahead band and the oversized hit area are hard to express
	 * there, and keyboard support is easy enough to add by hand.
	 */
	import { DUR } from '$lib/client/motion';

	let {
		value,
		max,
		buffered = 0,
		onseek,
		ariaLabel = 'Seek',
		formatValue = (v: number) => String(Math.round(v)),
		unit = 0
	}: {
		value: number;
		max: number;
		buffered?: number;
		onseek: (seconds: number) => void;
		ariaLabel?: string;
		formatValue?: (value: number) => string;
		/**
		 * The smallest change in `value` worth drawing, on top of one pixel. The
		 * track scrubber passes 1, for whole seconds. The volume slider, whose
		 * value runs from 0 to 1, passes nothing: with a floor of one it drew
		 * every level below full as 0.
		 */
		unit?: number;
	} = $props();

	let track = $state<HTMLDivElement | null>(null);
	let dragging = $state(false);
	let dragValue = $state(0);

	let width = $state(0);

	/*
	 * The position the bar draws, moved on whole pixels, or on whole `unit`s
	 * where a unit is longer than a pixel (whole seconds on the track scrubber).
	 *
	 * `timeupdate` sets `value` about four times a second, and each change
	 * repainted the player panel, which redraws its backdrop blur. A three
	 * minute track on a 300px bar moves 0.4px per update, so most of those
	 * repaints changed nothing visible. Measured in Chromium at 1440x900 while
	 * playing: the browser used 10 to 17 percent of a core with the blur and 2
	 * to 3 percent without it. On whole seconds the bar changes in the same
	 * frame as the elapsed and remaining times, which change once a second.
	 */
	const step = $derived(width > 0 && max > 0 ? Math.max(unit, max / width) : unit);
	const ticked = $derived(step > 0 ? Math.floor(value / step) * step : value);

	// While dragging, the thumb follows the pointer rather than the element's
	// clock, so it does not jump back on every timeupdate.
	const shown = $derived(dragging ? dragValue : ticked);
	const percent = $derived(max > 0 ? Math.min(100, Math.max(0, (shown / max) * 100)) : 0);
	// The same for the buffered band, which `progress` moves while the file loads.
	const bufferedPercent = $derived(
		max > 0 ? Math.min(100, ((step > 0 ? Math.floor(buffered / step) * step : buffered) / max) * 100) : 0
	);

	/*
	 * The fill and the thumb glide to a new position when it jumps (a click, a
	 * key, a new track going back to 0, the volume muted to nothing and back),
	 * over the state length, rather than cutting to it. The whole-second ticks of
	 * playback do not glide: a transition on each would repaint the player
	 * panel and its blur for a third of every second, which is what drawing on
	 * whole seconds exists to avoid. A drag follows the pointer exactly.
	 */
	let gliding = $state(false);
	let glideTimer: ReturnType<typeof setTimeout> | undefined;
	let lastShown: number | null = null;
	let downX = 0;

	function glide() {
		gliding = true;
		clearTimeout(glideTimer);
		glideTimer = setTimeout(() => (gliding = false), DUR.state + 40);
	}

	$effect(() => {
		const now = shown;
		if (lastShown !== null && !dragging && Math.abs(now - lastShown) > Math.max(step, 0) * 1.5) glide();
		lastShown = now;
	});

	function valueFromEvent(event: PointerEvent): number {
		if (!track || max <= 0) return 0;
		const rect = track.getBoundingClientRect();
		const ratio = (event.clientX - rect.left) / rect.width;
		return Math.min(max, Math.max(0, ratio * max));
	}

	function onPointerDown(event: PointerEvent) {
		if (max <= 0) return;
		// A press glides to where it landed; moving from there is a drag.
		glide();
		downX = event.clientX;
		dragging = true;
		dragValue = valueFromEvent(event);
		track?.setPointerCapture(event.pointerId);
	}

	function onPointerMove(event: PointerEvent) {
		if (!dragging) return;
		if (gliding && Math.abs(event.clientX - downX) > 3) gliding = false;
		dragValue = valueFromEvent(event);
	}

	function onPointerUp(event: PointerEvent) {
		if (!dragging) return;
		dragging = false;
		track?.releasePointerCapture(event.pointerId);
		onseek(valueFromEvent(event));
	}

	function onKeyDown(event: KeyboardEvent) {
		if (max <= 0) return;
		const step = event.shiftKey ? 30 : 5;
		if (event.key === 'ArrowRight') onseek(Math.min(max, value + step));
		else if (event.key === 'ArrowLeft') onseek(Math.max(0, value - step));
		else if (event.key === 'Home') onseek(0);
		else if (event.key === 'End') onseek(max);
		else return;
		event.preventDefault();
	}
</script>

<div
	class="seek"
	class:dragging
	class:gliding
	bind:this={track}
	bind:clientWidth={width}
	role="slider"
	tabindex="0"
	aria-label={ariaLabel}
	aria-valuemin="0"
	aria-valuemax={Math.round(max)}
	aria-valuenow={Math.round(shown)}
	aria-valuetext={formatValue(shown)}
	onpointerdown={onPointerDown}
	onpointermove={onPointerMove}
	onpointerup={onPointerUp}
	onpointercancel={onPointerUp}
	onkeydown={onKeyDown}
>
	<div class="rail">
		<div class="buffered" style:width="{bufferedPercent}%"></div>
		<div class="played" style:width="{percent}%"></div>
	</div>
	<div class="thumb" style:left="{percent}%"></div>
</div>

<style>
	.seek {
		position: relative;
		/* Generous hit area, thin visual rail. */
		height: 1.25rem;
		display: flex;
		align-items: center;
		cursor: pointer;
		touch-action: none;
	}

	.rail {
		position: relative;
		width: 100%;
		height: 4px;
		border-radius: var(--r-pill);
		background: var(--bg-active);
		overflow: hidden;
		transition: height var(--transition);
	}

	.seek:hover .rail,
	.seek.dragging .rail,
	.seek:focus-visible .rail {
		height: 6px;
	}

	.buffered,
	.played {
		position: absolute;
		inset: 0 auto 0 0;
		border-radius: var(--r-pill);
	}

	.buffered {
		background: var(--border-strong);
	}

	.played {
		background: var(--accent);
	}

	.gliding .played {
		transition: width var(--dur-state) var(--ease-out);
	}

	.thumb {
		position: absolute;
		top: 50%;
		width: 0.75rem;
		height: 0.75rem;
		margin-left: -0.375rem;
		border-radius: 50%;
		background: var(--text-strong);
		border: 2px solid var(--bg-surface);
		transform: translateY(-50%) scale(0);
		transition: transform var(--transition);
		pointer-events: none;
	}

	.gliding .thumb {
		transition:
			transform var(--transition),
			left var(--dur-state) var(--ease-out);
	}

	.seek:hover .thumb,
	.seek.dragging .thumb,
	.seek:focus-visible .thumb {
		transform: translateY(-50%) scale(1);
	}
</style>
