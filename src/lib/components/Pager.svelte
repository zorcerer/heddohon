<script lang="ts">
	import Icon from './Icon.svelte';

	let {
		page,
		pageCount,
		total,
		hasPrevious,
		hasNext,
		href,
		label = 'Pagination',
		noun = 'items'
	}: {
		page: number;
		/** Omitted by listings that only know whether more exists, not how much. */
		pageCount?: number;
		total?: number;
		hasPrevious: boolean;
		hasNext: boolean;
		href: (page: number) => string;
		label?: string;
		noun?: string;
	} = $props();

	const counted = $derived(typeof pageCount === 'number' && typeof total === 'number');
</script>

<!-- Somewhere to go in either direction is the only reason to render this. A
     counted listing with one page has neither, so this also covers that. -->
{#if hasPrevious || hasNext}
	<nav class="pager" aria-label={label}>
		{#if hasPrevious}
			<a class="hh-button previous" href={href(page - 1)} rel="prev" data-sveltekit-noscroll>
				<Icon name="chevron-right" size={16} />
				Previous
			</a>
		{:else}
			<span></span>
		{/if}

		<span class="count hh-numeric hh-muted">
			{#if counted}
				Page {page} of {pageCount} · {total?.toLocaleString()}
				{noun}
			{:else}
				Page {page}
			{/if}
		</span>

		{#if hasNext}
			<a class="hh-button next" href={href(page + 1)} rel="next" data-sveltekit-noscroll>
				Next
				<Icon name="chevron-right" size={16} />
			</a>
		{:else}
			<span></span>
		{/if}
	</nav>
{/if}

<style>
	.pager {
		display: grid;
		grid-template-columns: 1fr auto 1fr;
		align-items: center;
		gap: var(--space-4);
		padding-top: var(--space-4);
	}

	/*
	 * Both ends have to be pinned. A grid item with no `justify-self` stretches
	 * to fill its track, so pinning only the right one left Previous spanning a
	 * whole `1fr` column — a button several hundred pixels wide next to a
	 * content-width Next.
	 */
	.previous {
		justify-self: start;
	}

	.next {
		justify-self: end;
	}

	/* The same glyph, turned to point back the way it came. */
	.previous :global(svg) {
		transform: rotate(180deg);
	}

	.count {
		font-size: 0.75rem;
		text-align: center;
	}
</style>
