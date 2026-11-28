<script lang="ts">
	/**
	 * A spectrum of what is playing, drawn from the analyser on the audio graph
	 * (`audiochain.ts`). Issue #201.
	 *
	 * Drawn only where the graph exists: this browser has audio processing on
	 * and the visualiser switched on (`processing.svelte.ts`). It never makes a
	 * graph of its own; invariant 9 in AGENTS has why. With reduced motion it is
	 * not drawn at all.
	 *
	 * Each theme draws it in its own manner:
	 *
	 *  - Terminal: columns of the seek bar's own cells, 6px squares with 2px
	 *    between, the unlit ones in the track's colour and the lit ones in the
	 *    accent. Until 2026-11-28 it was block characters in the mono face, whose
	 *    rows met with a seam between them and left a column in two empty.
	 *  - Phosphor: a dot-matrix display of a hi-fi unit. Segments are always
	 *    there, unlit ones faint as a display's are; lit ones glow in the accent
	 *    and the peak holds in `--led`.
	 *  - Liquid: capsules on an even pitch, fading upwards.
	 *  - Paper: a spectrum line in ink over a faint wash of the accent.
	 *
	 * The frame loop runs only while the canvas is on screen, the page is
	 * visible and something plays, and runs on after a pause only until the
	 * bars have fallen.
	 */
	import { MediaQuery } from 'svelte/reactivity';
	import { player } from '#lib/client/player.svelte.ts';
	import { processing } from '#lib/client/processing.svelte.ts';

	/** `player` sits over the foot of the artwork; `screen` along the foot of the living-room screen. */
	let { place }: { place: 'player' | 'screen' } = $props();

	/** The lowest and highest frequencies drawn, in Hz, on a log scale. */
	const LOW_HZ = 40;
	const HIGH_HZ = 16_000;
	/**
	 * Fraction of the height a bar falls per second. It rises at once: a bar
	 * that eased up would lag the beat it shows.
	 */
	const FALL_PER_S = 1.8;
	/** How long a peak holds before it falls, and how fast it falls, in Phosphor. */
	const PEAK_HOLD_S = 0.5;
	const PEAK_FALL_PER_S = 0.9;
	/**
	 * How much of the way to a louder value a bar rises in a frame. Most of it:
	 * the beat still shows at once, and a bin's flicker no longer does.
	 */
	const RISE = 0.6;
	/** Terminal's cell and the gap after it, in CSS pixels, as the seek bar's (`Seekbar.svelte`). */
	const CELL = 6;
	const GAP = 2;
	/** How often the theme and its colours are read again, as they follow the cover. */
	const STYLE_EVERY_MS = 500;

	const reducedMotion = new MediaQuery('(prefers-reduced-motion: reduce)');
	const shown = $derived(processing.enabled && processing.visualiser && player.processing && !reducedMotion.current);

	let canvas = $state<HTMLCanvasElement | null>(null);
	let inView = $state(false);
	let pageVisible = $state(true);

	$effect(() => {
		const update = () => (pageVisible = document.visibilityState === 'visible');
		update();
		document.addEventListener('visibilitychange', update);
		return () => document.removeEventListener('visibilitychange', update);
	});

	$effect(() => {
		if (!canvas) return;
		const observer = new IntersectionObserver(([entry]) => (inView = entry.isIntersecting));
		observer.observe(canvas);
		return () => {
			observer.disconnect();
			inView = false;
		};
	});

	/** Sizes the backing store to the box in device pixels. */
	$effect(() => {
		const target = canvas;
		if (!target) return;
		const observer = new ResizeObserver(() => {
			const ratio = window.devicePixelRatio || 1;
			target.width = Math.max(1, Math.round(target.clientWidth * ratio));
			target.height = Math.max(1, Math.round(target.clientHeight * ratio));
		});
		observer.observe(target);
		return () => observer.disconnect();
	});

	interface Style {
		theme: string;
		ink: string;
		peak: string;
		/** Terminal's unlit cell, the seek bar's track. */
		unlit: string;
	}

	/**
	 * The theme on the root, and the colours the stylesheet below resolves for
	 * it. Read through `color` and `text-decoration-color` so the browser works
	 * out `hsl()`, `calc()` and `color-mix()` in the tokens; a canvas does not
	 * read custom properties.
	 */
	function readStyle(target: HTMLCanvasElement): Style {
		const computed = getComputedStyle(target);
		return {
			theme: document.documentElement.dataset.theme ?? 'dark',
			ink: computed.color,
			peak: computed.textDecorationColor,
			unlit: computed.caretColor
		};
	}

	/**
	 * Each bar's span of bins, log-spaced from `LOW_HZ` to `HIGH_HZ` (or the
	 * Nyquist frequency, below 32 kHz), as fractional bin positions.
	 */
	function bandEdges(count: number, sampleRate: number, bins: number): Array<[number, number]> {
		const nyquist = sampleRate / 2;
		const high = Math.min(HIGH_HZ, nyquist);
		const binOf = (hz: number) => Math.min(bins - 1, (hz / nyquist) * bins);
		return Array.from({ length: count }, (_, i) => [
			binOf(LOW_HZ * (high / LOW_HZ) ** (i / count)),
			binOf(LOW_HZ * (high / LOW_HZ) ** ((i + 1) / count))
		]);
	}

	/**
	 * A bar's value, 0 to 255: the loudest bin in its span, or, for a span
	 * inside one bin (the low bars, where a bin is 23 Hz wide), the value at its
	 * centre between the two nearest bins. Taking the one bin drew the bass as
	 * flat steps of bars sharing it.
	 */
	function bandValue(bins: Uint8Array, from: number, to: number): number {
		if (Math.floor(to) - Math.ceil(from) < 1) {
			const at = (from + to) / 2;
			const below = Math.floor(at);
			const above = Math.min(bins.length - 1, below + 1);
			return bins[below] + (bins[above] - bins[below]) * (at - below);
		}
		let value = 0;
		for (let bin = Math.ceil(from); bin <= Math.floor(to); bin++) value = Math.max(value, bins[bin]);
		return value;
	}

	/** How many bars fit, for the theme. */
	function barCount(style: Style, width: number, ratio: number, context: CanvasRenderingContext2D, height: number): number {
		if (style.theme === 'terminal') return Math.max(1, Math.floor((width + terminalGap(ratio)) / terminalPitch(ratio)));
		if (style.theme === 'phosphor') return Math.max(1, Math.floor(width / (phosphorPitch(height, ratio) * 3)));
		if (style.theme === 'light') return Math.max(8, Math.floor(width / (12 * ratio)));
		return Math.max(1, Math.floor(width / (place === 'screen' ? 14 : 7) / ratio));
	}

	/** Terminal's cell and its pitch in device pixels; twice the size on the living-room screen. */
	const terminalScale = () => (place === 'screen' ? 2 : 1);
	const terminalGap = (ratio: number) => Math.round(GAP * terminalScale() * ratio);
	const terminalPitch = (ratio: number) => Math.round(CELL * terminalScale() * ratio) + terminalGap(ratio);

	/** Phosphor's dot pitch, in device pixels: a segment is two dots wide, and a gap one. */
	function phosphorPitch(height: number, ratio: number): number {
		return Math.max(3 * ratio, Math.floor(height / (place === 'screen' ? 28 : 16)));
	}

	$effect(() => {
		const target = canvas;
		const engaged = player.engaged;
		if (!shown || !target || !inView || !pageVisible) return;
		const analyser = player.analyser();
		const context = target.getContext('2d');
		if (!analyser || !context) return;

		const bins = new Uint8Array(analyser.frequencyBinCount);
		let style = readStyle(target);
		let styledAt = performance.now();
		let edges: Array<[number, number]> = [];
		let levels = new Float32Array(0);
		let peaks = new Float32Array(0);
		let peakAge = new Float32Array(0);
		let shape = '';
		let last = performance.now();
		let frame = 0;

		const step = (now: number) => {
			const seconds = Math.min(0.1, (now - last) / 1000);
			last = now;
			if (now - styledAt > STYLE_EVERY_MS) {
				style = readStyle(target);
				styledAt = now;
			}
			const { width, height } = target;
			const ratio = window.devicePixelRatio || 1;
			const key = `${style.theme} ${width} ${height} ${analyser.context.sampleRate}`;
			if (key !== shape) {
				shape = key;
				const count = barCount(style, width, ratio, context, height);
				edges = bandEdges(count, analyser.context.sampleRate, bins.length);
				levels = new Float32Array(count);
				peaks = new Float32Array(count);
				peakAge = new Float32Array(count);
			}

			if (engaged) analyser.getByteFrequencyData(bins);
			else bins.fill(0);
			let moving = false;
			edges.forEach(([from, to], i) => {
				const target = bandValue(bins, from, to) / 255;
				const rise = levels[i] + (target - levels[i]) * RISE;
				const level = target > levels[i] ? rise : Math.max(target, levels[i] - FALL_PER_S * seconds);
				levels[i] = level;
				if (level >= peaks[i]) {
					peaks[i] = level;
					peakAge[i] = 0;
				} else {
					peakAge[i] += seconds;
					if (peakAge[i] > PEAK_HOLD_S) peaks[i] = Math.max(level, peaks[i] - PEAK_FALL_PER_S * seconds);
				}
				if (level > 0 || peaks[i] > 0) moving = true;
			});

			context.clearRect(0, 0, width, height);
			if (style.theme === 'terminal') drawTerminal(context, style, width, height, ratio);
			else if (style.theme === 'phosphor') drawPhosphor(context, style, width, height, ratio);
			else if (style.theme === 'light') drawPaper(context, style, width, height, ratio);
			else drawLiquid(context, style, width, height, ratio);

			frame = engaged || moving ? requestAnimationFrame(step) : 0;
		};

		function drawTerminal(context: CanvasRenderingContext2D, style: Style, width: number, height: number, ratio: number) {
			const gap = terminalGap(ratio);
			const pitch = terminalPitch(ratio);
			const cell = pitch - gap;
			const rows = Math.max(1, Math.floor((height + gap) / pitch));
			const offset = Math.floor((width - (pitch * levels.length - gap)) / 2);
			// From the bottom edge up, so the lowest row sits on it as the seek bar's does.
			const square = (i: number, row: number) => context.rect(offset + i * pitch, height - cell - row * pitch, cell, cell);
			const lit = (level: number) => Math.round(level * rows);

			context.fillStyle = style.unlit;
			context.beginPath();
			levels.forEach((level, i) => {
				for (let row = lit(level); row < rows; row++) square(i, row);
			});
			context.fill();

			context.fillStyle = style.ink;
			context.beginPath();
			levels.forEach((level, i) => {
				for (let row = 0; row < lit(level); row++) square(i, row);
			});
			context.fill();

			// The peak, a lit cell that holds above the bar a moment, at half strength.
			context.globalAlpha = 0.5;
			context.beginPath();
			peaks.forEach((peak, i) => {
				const row = lit(peak) - 1;
				if (row >= lit(levels[i])) square(i, row);
			});
			context.fill();
			context.globalAlpha = 1;
		}

		function drawPhosphor(context: CanvasRenderingContext2D, style: Style, width: number, height: number, ratio: number) {
			const pitch = phosphorPitch(height, ratio);
			const dot = Math.max(1, pitch - Math.max(1, Math.round(ratio)));
			const rows = Math.floor(height / pitch);
			const barWidth = pitch * 3;
			const offset = Math.floor((width - barWidth * levels.length) / 2);
			const segment = (i: number, row: number) =>
				context.rect(offset + i * barWidth, height - (row + 1) * pitch, pitch * 2 - (pitch - dot), dot);

			// The unlit segments, faint as on a display that is switched on.
			context.globalAlpha = 0.1;
			context.fillStyle = style.ink;
			context.beginPath();
			levels.forEach((level, i) => {
				for (let row = Math.round(level * rows); row < rows; row++) segment(i, row);
			});
			context.fill();
			context.globalAlpha = 1;

			context.shadowColor = style.ink;
			context.shadowBlur = 4 * ratio;
			context.beginPath();
			levels.forEach((level, i) => {
				for (let row = 0; row < Math.round(level * rows); row++) segment(i, row);
			});
			context.fill();

			context.shadowColor = style.peak;
			context.fillStyle = style.peak;
			context.beginPath();
			peaks.forEach((peak, i) => {
				const row = Math.round(peak * rows) - 1;
				if (row >= 0 && row > Math.round(levels[i] * rows) - 1) segment(i, row);
			});
			context.fill();
			context.shadowBlur = 0;
		}

		function drawLiquid(context: CanvasRenderingContext2D, style: Style, width: number, height: number, ratio: number) {
			const pitch = width / levels.length;
			const barWidth = Math.max(ratio, Math.round(pitch * 0.5));
			context.fillStyle = style.ink;
			context.beginPath();
			levels.forEach((level, i) => {
				// At least a dot, so a quiet band still shows where it is.
				const barHeight = Math.max(barWidth, level * height);
				context.roundRect(Math.round(i * pitch + (pitch - barWidth) / 2), height - barHeight, barWidth, barHeight, barWidth / 2);
			});
			context.fill();
			// The fade upwards, as a mask: a gradient to `transparent` passes through black on its way.
			const fade = context.createLinearGradient(0, height, 0, 0);
			fade.addColorStop(0, 'rgb(0 0 0 / 0.9)');
			fade.addColorStop(1, 'rgb(0 0 0 / 0.15)');
			context.globalCompositeOperation = 'destination-in';
			context.fillStyle = fade;
			context.fillRect(0, 0, width, height);
			context.globalCompositeOperation = 'source-over';
		}

		function drawPaper(context: CanvasRenderingContext2D, style: Style, width: number, height: number, ratio: number) {
			const pitch = width / Math.max(1, levels.length - 1);
			const inset = 1.5 * ratio;
			const y = (i: number) => height - inset - levels[i] * (height - 2 * inset);
			// A curve through the midpoints, so the line has no corners at the bars.
			context.beginPath();
			context.moveTo(0, y(0));
			for (let i = 1; i < levels.length; i++) {
				const midX = (i - 0.5) * pitch;
				context.quadraticCurveTo((i - 1) * pitch, y(i - 1), midX, (y(i - 1) + y(i)) / 2);
			}
			context.lineTo(width, y(levels.length - 1));
			context.lineWidth = 1.5 * ratio;
			context.lineJoin = 'round';
			context.strokeStyle = style.ink;
			context.stroke();
			context.lineTo(width, height);
			context.lineTo(0, height);
			context.closePath();
			context.globalAlpha = 0.12;
			context.fillStyle = style.peak;
			context.fill();
			context.globalAlpha = 1;
		}

		frame = requestAnimationFrame(step);
		return () => cancelAnimationFrame(frame);
	});
</script>

{#if shown}
	<canvas class="visualiser {place}" bind:this={canvas} aria-hidden="true"></canvas>
{/if}

<style>
	.visualiser {
		display: block;
		width: 100%;
		pointer-events: none;
		/* What the drawing reads (see `readStyle`): the lit colour, the second one, and Terminal's unlit cell. */
		color: var(--accent);
		text-decoration-color: var(--accent);
		caret-color: var(--bg-active);
	}

	.player {
		align-self: end;
		height: 26%;
		max-height: 7rem;
		position: relative;
		z-index: 1;
	}

	.screen {
		position: absolute;
		inset: auto 0 0;
		height: clamp(4rem, 20vh, 12rem);
		z-index: -1;
		opacity: 0.55;
	}

	:global([data-theme='phosphor']) .visualiser {
		text-decoration-color: var(--led);
	}

	:global([data-theme='light']) .visualiser {
		color: var(--text-strong);
		text-decoration-color: var(--accent);
	}
</style>
