<script lang="ts">
	/**
	 * A pointer-driven scrub bar. It deliberately does not use <input range>:
	 * the buffered-ahead band and the oversized hit area are hard to express
	 * there, and keyboard support is easy enough to add by hand.
	 */
	let {
		value,
		max,
		buffered = 0,
		onseek,
		ariaLabel = 'Seek',
		formatValue = (v: number) => String(Math.round(v))
	}: {
		value: number;
		max: number;
		buffered?: number;
		onseek: (seconds: number) => void;
		ariaLabel?: string;
		formatValue?: (value: number) => string;
	} = $props();

	let track = $state<HTMLDivElement | null>(null);
	let dragging = $state(false);
	let dragValue = $state(0);

	// While dragging, the thumb follows the pointer rather than the element's
	// clock, so it does not jump back on every timeupdate.
	const shown = $derived(dragging ? dragValue : value);
	const percent = $derived(max > 0 ? Math.min(100, Math.max(0, (shown / max) * 100)) : 0);
	const bufferedPercent = $derived(max > 0 ? Math.min(100, (buffered / max) * 100) : 0);

	function valueFromEvent(event: PointerEvent): number {
		if (!track || max <= 0) return 0;
		const rect = track.getBoundingClientRect();
		const ratio = (event.clientX - rect.left) / rect.width;
		return Math.min(max, Math.max(0, ratio * max));
	}

	function onPointerDown(event: PointerEvent) {
		if (max <= 0) return;
		dragging = true;
		dragValue = valueFromEvent(event);
		track?.setPointerCapture(event.pointerId);
	}

	function onPointerMove(event: PointerEvent) {
		if (!dragging) return;
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
	bind:this={track}
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

	.seek:hover .thumb,
	.seek.dragging .thumb,
	.seek:focus-visible .thumb {
		transform: translateY(-50%) scale(1);
	}
</style>
