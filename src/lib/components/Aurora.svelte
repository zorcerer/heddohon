<script lang="ts">
	import { onMount } from 'svelte';
	import SoftAurora from './bits/SoftAurora.svelte';

	/**
	 * The room's aurora: Svelte Bits' SoftAurora, a WebGL band of light, in
	 * two colours of the cover playing (`--art-h`, `--art-s`, `--art-l` on the
	 * root, from `client/artwork.ts`), 40 degrees either side of its hue as
	 * the CSS aurora had them. `still` draws it once; so does a listener who
	 * asked for less motion.
	 *
	 * Three frames a second, as the CSS aurora before it moved in steps: every
	 * glass surface over it blurs again each time it changes. Slow enough that
	 * a step is small.
	 *
	 * Drawn at a quarter of the room's width and height, a sixteenth of its
	 * pixels, and scaled up: the bands are soft. Measured in headless Chromium
	 * at 1440x900, which draws WebGL in software as a machine without a GPU
	 * does, as the share of the time the page was busy: 108 percent moving at
	 * full size, 7 percent at a quarter, and 1 to 4 percent still.
	 */
	let { still = false }: { still?: boolean } = $props();

	let colours = $state<[string, string]>(['#7a8aa8', '#6b7d9c']);
	let reduced = $state(false);

	/** An `hsl()` as `#rrggbb`, which the shader takes. */
	function hex(h: number, s: number, l: number): string {
		s = Math.min(100, Math.max(0, s)) / 100;
		l = Math.min(100, Math.max(0, l)) / 100;
		const k = (n: number) => (n + h / 30) % 12;
		const a = s * Math.min(l, 1 - l);
		const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
		return '#' + [f(0), f(8), f(4)].map((x) => Math.round(x * 255).toString(16).padStart(2, '0')).join('');
	}

	function read() {
		const root = getComputedStyle(document.documentElement);
		const h = parseFloat(root.getPropertyValue('--art-h')) || 218;
		const s = parseFloat(root.getPropertyValue('--art-s')) || 16;
		const l = parseFloat(root.getPropertyValue('--art-l')) || 54;
		colours = [hex(h + 40, s + 14, l + 6), hex(h - 35, s + 14, l + 4)];
	}

	onMount(() => {
		read();
		const media = window.matchMedia('(prefers-reduced-motion: reduce)');
		reduced = media.matches;
		const change = () => (reduced = media.matches);
		media.addEventListener('change', change);
		// artwork.ts writes the cover's colour onto the root's style.
		const watch = new MutationObserver(read);
		watch.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
		return () => {
			media.removeEventListener('change', change);
			watch.disconnect();
		};
	});
</script>

<SoftAurora color1={colours[0]} color2={colours[1]} still={still || reduced} maxFps={3} resolution={0.25} enableMouseInteraction={false} speed={0.15} />
