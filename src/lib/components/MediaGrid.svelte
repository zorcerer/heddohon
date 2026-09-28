<script lang="ts">
	import type { Snippet } from 'svelte';

	let {
		density = 'comfortable',
		wholeRows = false,
		children
	}: {
		density?: 'compact' | 'comfortable' | 'roomy';
		/**
		 * Show only as many cards as fill whole rows. For a section that is a
		 * capped selection (the album page's "More from" and "You might like",
		 * eight each), not for a list whose every entry counts. Eight in rows of
		 * three left two cards and an empty third of a row on every phone.
		 */
		wholeRows?: boolean;
		children: Snippet;
	} = $props();

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

	/*
	 * The column count is whatever `auto-fill` makes of the width, so it is read
	 * back from the grid, which lists every track it laid out, filled or not,
	 * and read again when the width changes or cards arrive. A single short row
	 * is kept whole: fewer cards than columns is a row of its own. On a phone
	 * the CSS below has already done this for the first paint.
	 */
	function trim(grid: HTMLElement) {
		const apply = () => {
			const columns = getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length;
			const cards = [...grid.children] as HTMLElement[];
			const kept = columns > 0 && cards.length > columns ? cards.length - (cards.length % columns) : cards.length;
			cards.forEach((card, index) => (card.style.display = index < kept ? '' : 'none'));
		};
		apply();
		const resized = new ResizeObserver(apply);
		resized.observe(grid);
		const changed = new MutationObserver(apply);
		changed.observe(grid, { childList: true });
		return () => {
			resized.disconnect();
			changed.disconnect();
		};
	}
</script>

<div
	class="grid hh-stagger"
	class:roomy={density === 'roomy'}
	class:whole={wholeRows}
	style:--min-width={MIN_WIDTH[density]}
	{@attach (grid) => (wholeRows ? trim(grid) : undefined)}
>
	{@render children()}
</div>

<style>
	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(var(--min-width), 1fr));
		gap: var(--space-2);
	}

	/*
	 * A phone: a fixed count rather than a minimum width. At 184px an iPhone 16,
	 * with 361px of content, fitted one card per row, so a library of 300 albums
	 * was 300 screens of scrolling. Three to a row puts each sleeve at about
	 * 110px, which still reads as a cover. Roomy keeps its meaning at two.
	 */
	@media (max-width: 36rem) {
		.grid {
			grid-template-columns: repeat(3, minmax(0, 1fr));
			gap: var(--space-1);
		}

		.grid.roomy {
			grid-template-columns: repeat(2, minmax(0, 1fr));
			gap: var(--space-2);
		}

		/*
		 * Whole rows at a fixed count, from the server's HTML: the first card of
		 * a row after the first that is among the last two (three across) or is
		 * the last (two across), and every card after it.
		 */
		.grid.whole:not(.roomy) > :global(:nth-child(3n + 4):nth-last-child(-n + 2)),
		.grid.whole:not(.roomy) > :global(:nth-child(3n + 4):nth-last-child(-n + 2) ~ *),
		.grid.whole.roomy > :global(:nth-child(2n + 3):last-child) {
			display: none;
		}
	}
</style>
