<!--
	ElasticSlider, from Svelte Bits (https://sveltebits.xyz), by David Haz:
	https://github.com/DavidHDev/svelte-bits/blob/c37078c5ff7af7b090e510e0a2d0fbb472c1d286/src/lib/components/library/Components/ElasticSlider/ElasticSlider.svelte
	Under the MIT + Commons Clause licence in LICENSE.md beside this file. Changes
	for Heddohon are marked "Heddohon:".
-->
<!-- @svelte-bits
{
  "title": "Elastic Slider",
  "description": "Slider that stretches with overshoot decay and bounce-back spring (motion).",
  "dependencies": ["motion"]
}
-->
<script lang="ts">
	import { type Snippet, onMount } from 'svelte';
	import { motionValue, animate } from 'motion';

	type Props = {
		// Heddohon: the value is bound, and reported as it moves and when it is let go.
		value?: number;
		onchange?: (value: number) => void;
		oncommit?: (value: number) => void;
		label?: string;
		valueText?: string;
		showValue?: boolean;
		disabled?: boolean;
		// Heddohon: a band for what has loaded, a drag drawn without reporting
		// it until it is let go (`live` false), and the step of the arrow keys.
		buffered?: number;
		live?: boolean;
		keyStep?: number;
		shiftKeyStep?: number;
		// Heddohon: whether it swells under the pointer; the stretch past an end stays.
		swell?: boolean;
		startingValue?: number;
		maxValue?: number;
		class?: string;
		isStepped?: boolean;
		stepSize?: number;
		leftIcon?: Snippet;
		rightIcon?: Snippet;
	};

	let {
		value = $bindable(50),
		onchange,
		oncommit,
		label,
		valueText,
		showValue = false,
		disabled = false,
		buffered = 0,
		live = true,
		keyStep,
		shiftKeyStep,
		swell = true,
		startingValue = 0,
		maxValue = 100,
		class: className = '',
		isStepped = false,
		stepSize = 1,
		leftIcon,
		rightIcon
	}: Props = $props();

	const MAX_OVERFLOW = 50;
	// Heddohon: the stretch and the swell are motion; with less motion asked for, the bar only moves.
	const reduced = () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

	function clamped(next: number): number {
		if (isStepped) next = Math.round(next / stepSize) * stepSize;
		return Math.min(Math.max(next, startingValue), maxValue);
	}
	function set(next: number) {
		next = clamped(next);
		if (next === value) return;
		value = next;
		onchange?.(next);
	}
	// Heddohon: where a drag that is not `live` has the bar, over the value given.
	let dragValue = $state<number | null>(null);
	const shown = $derived(dragValue ?? value);

	let region: 'left' | 'middle' | 'right' = 'middle';
	let sliderRef: HTMLDivElement;
	let trackWrapperEl: HTMLDivElement;
	// Heddohon: state, since the icons are now there only when given.
	let leftIconEl = $state<HTMLDivElement>();
	let rightIconEl = $state<HTMLDivElement>();
	let leftIconInner = $state<HTMLDivElement>();
	let rightIconInner = $state<HTMLDivElement>();
	let outerEl: HTMLDivElement;

	const clientX = motionValue(0);
	const overflow = motionValue(0);
	const scale = motionValue(1);

	function decay(v: number, max: number): number {
		if (max === 0) return 0;
		const entry = v / max;
		const sigmoid = 2 * (1 / (1 + Math.exp(-entry)) - 0.5);
		return sigmoid * max;
	}

	function applyTransforms() {
		if (!sliderRef || !trackWrapperEl || !outerEl) return;
		const o = overflow.get();
		const s = scale.get();
		const cx = clientX.get();
		const { left, width } = sliderRef.getBoundingClientRect();

		const opacity = swell ? 0.7 + ((s - 1) / 0.2) * 0.3 : 1;
		outerEl.style.transform = `scale(${s})`;
		outerEl.style.opacity = String(opacity);

		const sx = 1 + o / Math.max(width, 1);
		const sy = 1 + (Math.min(o, MAX_OVERFLOW) / MAX_OVERFLOW) * (0.8 - 1);
		const origin = cx < left + width / 2 ? 'right' : 'left';
		const height = 6 + ((s - 1) / 0.2) * 6;
		const margin = ((s - 1) / 0.2) * -3;
		trackWrapperEl.style.transform = `scaleX(${sx}) scaleY(${sy})`;
		trackWrapperEl.style.transformOrigin = origin;
		trackWrapperEl.style.height = `${height}px`;
		trackWrapperEl.style.marginTop = `${margin}px`;
		trackWrapperEl.style.marginBottom = `${margin}px`;

		const leftX = region === 'left' ? -o / Math.max(s, 0.0001) : 0;
		const rightX = region === 'right' ? o / Math.max(s, 0.0001) : 0;
		if (leftIconEl) leftIconEl.style.transform = `translateX(${leftX}px)`;
		if (rightIconEl) rightIconEl.style.transform = `translateX(${rightX}px)`;
	}

	function pulseIcon(el: HTMLElement) {
		el.animate(
			[{ transform: 'scale(1)' }, { transform: 'scale(1.4)' }, { transform: 'scale(1)' }],
			{ duration: 250, easing: 'ease-out' }
		);
	}

	onMount(() => {
		const unsubs = [
			overflow.on('change', applyTransforms),
			scale.on('change', applyTransforms),
			clientX.on('change', (latest: number) => {
				if (!sliderRef) return;
				const { left, right } = sliderRef.getBoundingClientRect();
				let newOverflow: number;
				if (latest < left) {
					if (region !== 'left' && leftIconInner) pulseIcon(leftIconInner);
					region = 'left';
					newOverflow = left - latest;
				} else if (latest > right) {
					if (region !== 'right' && rightIconInner) pulseIcon(rightIconInner);
					region = 'right';
					newOverflow = latest - right;
				} else {
					region = 'middle';
					newOverflow = 0;
				}
				overflow.jump(decay(newOverflow, MAX_OVERFLOW));
				applyTransforms();
			})
		];
		applyTransforms();
		return () => unsubs.forEach((u) => u());
	});

	let held = false;
	function onPointerMove(e: PointerEvent) {
		if (disabled || !held) return;
		if (e.buttons > 0 && sliderRef) {
			const { left, width } = sliderRef.getBoundingClientRect();
			const next = startingValue + ((e.clientX - left) / width) * (maxValue - startingValue);
			if (live) set(next);
			else dragValue = clamped(next);
			if (!reduced()) clientX.jump(e.clientX);
		}
	}
	function onPointerDown(e: PointerEvent) {
		if (disabled) return;
		held = true;
		onPointerMove(e);
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
	}
	function onPointerUp() {
		if (held) oncommit?.(dragValue ?? value);
		held = false;
		dragValue = null;
		animate(overflow, 0, { type: 'spring', bounce: 0.5 });
	}
	// Heddohon: the system took the touch; the drag ends where it began.
	function onPointerCancel() {
		held = false;
		dragValue = null;
		animate(overflow, 0, { type: 'spring', bounce: 0.5 });
	}
	function onEnter() { if (swell && !disabled && !reduced()) animate(scale, 1.2); }
	function onLeave() { animate(scale, 1); }
	// Heddohon: the keys a range input takes.
	function onKeyDown(e: KeyboardEvent) {
		if (disabled) return;
		const step = (e.shiftKey ? shiftKeyStep : undefined) ?? keyStep ?? (isStepped ? stepSize : (maxValue - startingValue) / 100);
		const page = (maxValue - startingValue) / 10;
		const by: Record<string, number> = { ArrowRight: step, ArrowUp: step, ArrowLeft: -step, ArrowDown: -step, PageUp: page, PageDown: -page };
		let next: number;
		if (e.key in by) next = clamped(value + by[e.key]);
		else if (e.key === 'Home') next = startingValue;
		else if (e.key === 'End') next = maxValue;
		else return;
		e.preventDefault();
		if (live) set(next);
		oncommit?.(next);
	}

	const percentOf = (v: number) => Math.min(100, Math.max(0, ((v - startingValue) / Math.max(1e-6, maxValue - startingValue)) * 100));
	const rangePercentage = $derived(percentOf(shown));
	const bufferedPercentage = $derived(percentOf(buffered));
	// Heddohon: a value that is not stepped is read out whole, as the scrub bar did.
	const ariaNow = $derived(isStepped ? shown : Math.round(shown));
</script>

<div class="slider-container {className}">
	<div
		bind:this={outerEl}
		class="slider-wrapper"
		style:opacity={swell ? undefined : 1}
		onmouseenter={onEnter}
		onmouseleave={onLeave}
		ontouchstart={onEnter}
		ontouchend={onLeave}
		role="presentation"
	>
		<!-- Heddohon: an icon at either end only where one is given. -->
		{#if leftIcon}
			<div bind:this={leftIconEl} class="slider-icon">
				<div bind:this={leftIconInner} class="slider-icon-inner">{@render leftIcon()}</div>
			</div>
		{/if}
		<div
			bind:this={sliderRef}
			class="slider-root"
			onpointermove={onPointerMove}
			onpointerdown={onPointerDown}
			onpointerup={onPointerUp}
			onpointercancel={onPointerCancel}
			onlostpointercapture={onPointerUp}
			onkeydown={onKeyDown}
			role="slider"
			aria-label={label}
			aria-valuemin={startingValue}
			aria-valuemax={isStepped ? maxValue : Math.round(maxValue)}
			aria-valuenow={ariaNow}
			aria-valuetext={valueText}
			aria-disabled={disabled || undefined}
			tabindex={disabled ? -1 : 0}
		>
			<div bind:this={trackWrapperEl} class="slider-track-wrapper">
				<div class="slider-track">
					{#if buffered > 0}<div class="slider-buffered" style="width:{bufferedPercentage}%;"></div>{/if}
					<div class="slider-range" style="width:{rangePercentage}%;"></div>
				</div>
			</div>
		</div>
		{#if rightIcon}
			<div bind:this={rightIconEl} class="slider-icon">
				<div bind:this={rightIconInner} class="slider-icon-inner">{@render rightIcon()}</div>
			</div>
		{/if}
	</div>
	{#if showValue}<p class="value-indicator">{Math.round(value)}</p>{/if}
</div>

<style>
	.slider-container {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 1rem;
		/* Heddohon: as wide as its place, in the theme's colours. */
		width: 100%;
	}
	.slider-wrapper {
		display: flex;
		width: 100%;
		touch-action: none;
		user-select: none;
		align-items: center;
		justify-content: center;
		gap: var(--bits-slider-gap, 1rem);
		opacity: 0.7;
	}
	.slider-icon {
		color: var(--bits-slider-icon, var(--text-muted));
		display: flex;
		align-items: center;
		justify-content: center;
	}
	.slider-icon-inner {
		display: flex;
		align-items: center;
		justify-content: center;
	}
	.slider-root {
		position: relative;
		display: flex;
		width: 100%;
		flex-grow: 1;
		cursor: grab;
		touch-action: none;
		user-select: none;
		align-items: center;
		padding: var(--bits-slider-pad, 1rem 0);
	}
	.slider-root:active { cursor: grabbing; }
	.slider-root:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 4px; }
	.slider-root[aria-disabled='true'] { cursor: default; opacity: 0.5; }
	.slider-track-wrapper {
		display: flex;
		flex-grow: 1;
		height: 6px;
	}
	.slider-track {
		position: relative;
		height: 100%;
		flex-grow: 1;
		overflow: hidden;
		border-radius: 9999px;
		background-color: var(--bits-slider-track, color-mix(in srgb, var(--text-muted) 35%, transparent));
	}
	.slider-buffered {
		position: absolute;
		height: 100%;
		background-color: var(--bits-slider-buffered, var(--border-strong));
		border-radius: 9999px;
	}
	.slider-range {
		position: absolute;
		height: 100%;
		background-color: var(--bits-slider-range, var(--accent));
		border-radius: 9999px;
	}
	.value-indicator {
		color: var(--text-muted);
		position: absolute;
		transform: translateY(-1rem);
		font-size: 0.75rem;
		font-weight: 500;
		letter-spacing: 0.05em;
	}
</style>
