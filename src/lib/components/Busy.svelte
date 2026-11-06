<script lang="ts">
	import LatticeLoader from './bits/LatticeLoader.svelte';

	/**
	 * A wait, drawn as Svelte Bits' LatticeLoader: a 3 by 3 lattice whose cells
	 * brighten in turn. Hidden from assistive technology: the control it sits
	 * in says it is busy (`aria-busy`), or the page says so in words.
	 */
	let { cell = 4 }: { cell?: number } = $props();
</script>

<span class="hh-busy" aria-hidden="true">
	<LatticeLoader label="" showTimer={false} cellSize={cell} gap={1} fontSize={0} color="currentColor" pattern="orbit" />
</span>

<style>
	.hh-busy {
		display: inline-grid;
		place-items: center;
	}
</style>
