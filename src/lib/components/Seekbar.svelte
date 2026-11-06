<script lang="ts">
	/**
	 * A scrub bar: Svelte Bits' ElasticSlider, which swells under the pointer
	 * and stretches when dragged past an end. It reports a position when it is
	 * let go, or at once from the keys, and draws the buffered-ahead band.
	 */
	import ElasticSlider from './bits/ElasticSlider.svelte';

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
		 * The smallest change in `value` drawn, on top of one pixel. The track
		 * scrubber passes 1, for whole seconds. The volume slider, whose value
		 * runs from 0 to 1, passes nothing: with a floor of one it drew every
		 * level below full as 0.
		 */
		unit?: number;
	} = $props();

	let width = $state(0);

	/*
	 * The position the bar draws, moved on whole pixels, or on whole `unit`s
	 * where a unit is longer than a pixel (whole seconds on the track scrubber).
	 *
	 * `timeupdate` sets `value` about four times a second, and each change
	 * repainted the player panel and its backdrop blur. A three minute track on
	 * a 300px bar moves 0.4px per update, so most repaints changed nothing
	 * visible. In Chromium at 1440x900 while playing, the browser used 10 to 17
	 * percent of a core with the blur and 2 to 3 percent without it. On whole
	 * seconds the bar changes in the same frame as the elapsed and remaining
	 * times.
	 */
	const step = $derived(width > 0 && max > 0 ? Math.max(unit, max / width) : unit);
	const ticked = $derived(step > 0 ? Math.floor(value / step) * step : value);
	const bufferedTicked = $derived(step > 0 ? Math.floor(buffered / step) * step : buffered);
</script>

<div class="seek" bind:clientWidth={width}>
	<ElasticSlider
		value={Math.min(ticked, max)}
		maxValue={Math.max(max, 0)}
		buffered={Math.min(bufferedTicked, max)}
		live={false}
		keyStep={5}
		shiftKeyStep={30}
		oncommit={(seconds) => onseek(seconds)}
		label={ariaLabel}
		valueText={formatValue(ticked)}
		disabled={max <= 0}
	/>
</div>

<style>
	.seek {
		--bits-slider-pad: 0.375rem 0;
		--bits-slider-gap: 0;
		--bits-slider-track: var(--bg-active);
		--bits-slider-buffered: var(--border-strong);
		--bits-slider-range: var(--accent);
	}

	/* ── Terminal ────────────────────────────────────────────────────────────── */

	/*
	 * A row of segments, 6px with 2px between, at one height: the played ones in
	 * the accent over the buffered ones over the rest. The three share an origin,
	 * so their segments coincide. The swell keeps the height.
	 */
	:global([data-theme='terminal'] .seek .slider-track-wrapper) {
		height: 0.5rem !important;
		margin: 0 !important;
	}

	:global([data-theme='terminal'] .seek .slider-track) {
		border-radius: 0;
		background: repeating-linear-gradient(to right, var(--bg-active) 0 6px, transparent 6px 8px);
	}

	:global([data-theme='terminal'] .seek .slider-buffered),
	:global([data-theme='terminal'] .seek .slider-range) {
		border-radius: 0;
		background: none;
		background-size: 100vw 100%;
	}

	:global([data-theme='terminal'] .seek .slider-buffered) {
		background-image: repeating-linear-gradient(to right, var(--border-strong) 0 6px, transparent 6px 8px);
	}

	:global([data-theme='terminal'] .seek .slider-range) {
		background-image: repeating-linear-gradient(to right, var(--accent) 0 6px, transparent 6px 8px);
	}

	/* ── Phosphor ────────────────────────────────────────────────────────────── */

	/*
	 * A row of phosphor segments, 4px with 2px between and 3px high: the played
	 * ones lit in the accent and glowing, the rest unlit and just visible, as
	 * the segments of a display are. The track is not clipped, so the glow
	 * reaches past it.
	 */
	:global([data-theme='phosphor'] .seek .slider-track-wrapper) {
		height: 3px !important;
		margin: 0 !important;
	}

	:global([data-theme='phosphor'] .seek .slider-track) {
		border-radius: 0;
		overflow: visible;
		background: repeating-linear-gradient(to right, rgb(170 215 210 / 0.1) 0 4px, transparent 4px 6px);
	}

	:global([data-theme='phosphor'] .seek .slider-buffered),
	:global([data-theme='phosphor'] .seek .slider-range) {
		border-radius: 0;
		background: none;
		background-size: 100vw 100%;
	}

	:global([data-theme='phosphor'] .seek .slider-buffered) {
		background-image: repeating-linear-gradient(to right, rgb(170 215 210 / 0.12) 0 4px, transparent 4px 6px);
	}

	:global([data-theme='phosphor'] .seek .slider-range) {
		background-image: repeating-linear-gradient(to right, var(--accent) 0 4px, transparent 4px 6px);
		filter: drop-shadow(0 0 3px color-mix(in srgb, var(--accent) 70%, transparent));
	}
</style>
