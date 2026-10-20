<script lang="ts">
	import { qrModules } from '$lib/client/qr';

	/**
	 * A QR code as one SVG path, dark on white whatever the theme: a scanner
	 * reads dark modules on a light ground, and some refuse the inverse.
	 */
	let { text, label }: { text: string; label: string } = $props();

	const modules = $derived(qrModules(text));
	/** Four modules of white round the code, the quiet zone the standard asks for. */
	const QUIET = 4;
	const path = $derived(
		modules
			.flatMap((row, y) => row.map((dark, x) => (dark ? `M${x + QUIET} ${y + QUIET}h1v1h-1z` : '')))
			.join('')
	);
	const size = $derived(modules.length + QUIET * 2);
</script>

<svg class="qr" viewBox="0 0 {size} {size}" role="img" aria-label={label} shape-rendering="crispEdges">
	<rect width={size} height={size} fill="#fff" />
	<path d={path} fill="#000" />
</svg>

<style>
	.qr {
		display: block;
		width: 12rem;
		height: 12rem;
		border-radius: var(--radius-sm, 4px);
	}
</style>
