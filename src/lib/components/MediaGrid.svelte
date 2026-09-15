<script lang="ts">
	import type { Snippet } from 'svelte';

	let {
		density = 'comfortable',
		children
	}: { density?: 'compact' | 'comfortable' | 'roomy'; children: Snippet } = $props();

	/*
	 * Pixels, not rem, so these do not follow the interface scale.
	 *
	 * Everything else is rem and grows with the scale, and for type and controls
	 * that is the point. A cover is a picture: making it half again as large
	 * does not make it more legible, it just fits fewer in the row. Measured at
	 * 150% when these were rem: a 1366px iPad showed two comfortable columns
	 * beside the player against four at 100%.
	 *
	 * The values are the rem sizes these were, resolved against the 16px root
	 * the design was drawn at: 9, 11.5 and 14.5rem. The row still rounds down to
	 * whole cards and `1fr` shares out the remainder, so the count is not fixed,
	 * but it no longer falls away as the scale rises.
	 */
	const MIN_WIDTH = { compact: '144px', comfortable: '184px', roomy: '232px' };
</script>

<div class="grid" style:--min-width={MIN_WIDTH[density]}>
	{@render children()}
</div>

<style>
	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(var(--min-width), 1fr));
		gap: var(--space-2);
	}
</style>
