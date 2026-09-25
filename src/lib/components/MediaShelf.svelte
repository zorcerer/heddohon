<script lang="ts">
	import type { Snippet } from 'svelte';
	import Icon from './Icon.svelte';
	import SectionHeader from './SectionHeader.svelte';

	/**
	 * A section whose cards run in one line and scroll sideways, under the same
	 * numbered and ruled header as a grid section.
	 *
	 * A grid of 11 albums wrapped to three rows at 1440px with the player open,
	 * about 800px of the page for one shelf. In one line the shelf is 310px and
	 * the next one starts on the first screen. The card past the edge is cut,
	 * which is what says the line goes on; the buttons in the header page it by
	 * most of its width for a mouse, and a trackpad or a finger scrolls it.
	 */
	let {
		title,
		index = null,
		eyebrow = null,
		href = null,
		/** The shelf's name for the buttons, when the title alone would repeat. */
		label = title,
		density = 'comfortable',
		children
	}: {
		title: string;
		index?: number | null;
		eyebrow?: string | null;
		href?: string | null;
		label?: string;
		density?: 'compact' | 'comfortable';
		children: Snippet;
	} = $props();

	let track = $state<HTMLDivElement | null>(null);
	let atStart = $state(true);
	let atEnd = $state(false);

	/** Within a pixel of either end, which rounding leaves on a fractional width. */
	function measure() {
		if (!track) return;
		atStart = track.scrollLeft <= 1;
		atEnd = track.scrollLeft + track.clientWidth >= track.scrollWidth - 1;
	}

	$effect(() => {
		if (!track) return;
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(track);
		return () => observer.disconnect();
	});

	function page(direction: 1 | -1) {
		if (!track) return;
		const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
		track.scrollBy({ left: direction * track.clientWidth * 0.85, behavior: reduce ? 'auto' : 'smooth' });
	}
</script>

<section class="shelf">
	<SectionHeader {title} {index} {eyebrow} {href}>
		{#snippet actions()}
			{#if !(atStart && atEnd)}
				<div class="paging">
					<button
						class="hh-button step"
						onclick={() => page(-1)}
						disabled={atStart}
						aria-label="Scroll {label} back"
					>
						<Icon name="chevron-left" size={16} />
					</button>
					<button
						class="hh-button step"
						onclick={() => page(1)}
						disabled={atEnd}
						aria-label="Scroll {label} on"
					>
						<Icon name="chevron-right" size={16} />
					</button>
				</div>
			{/if}
		{/snippet}
	</SectionHeader>

	<div
		class="track hh-stagger"
		class:compact={density === 'compact'}
		bind:this={track}
		onscroll={measure}
	>
		{@render children()}
	</div>
</section>

<style>
	/*
	 * A grid item sizes to its content's minimum, and a line of cards is as
	 * wide as all of them: without this the shelf widened the page to fit the
	 * whole line and pushed everything beside it out of the column.
	 */
	.shelf {
		min-width: 0;
	}

	/*
	 * Pixels for the card width, as in `MediaGrid`: a cover does not get more
	 * legible at a larger interface scale. 176 and 136 are a little under the
	 * grid's minimums, which a grid stretches to fill its row and a line does
	 * not.
	 */
	.track {
		--card: 176px;
		display: grid;
		grid-auto-flow: column;
		grid-auto-columns: var(--card);
		gap: var(--space-2);
		overflow-x: auto;
		overscroll-behavior-x: contain;
		scroll-snap-type: x proximity;
		scrollbar-width: none;
		/*
		 * Room inside the scroller for what a card does on hover: the sleeve
		 * lifts 4px and casts a 24px shadow 12px down, and a scroller clips on
		 * both axes once it scrolls on one. The glow reaches 16px past a card's
		 * box; at 12px of room the first card's was cut off along the rail. 16px
		 * is also the least padding the content column has, on a phone. The
		 * negative margins give the room back to the layout, so the first card
		 * lines up with the header.
		 */
		padding: var(--space-2) var(--space-4) var(--space-6);
		margin: calc(-1 * var(--space-2)) calc(-1 * var(--space-4)) calc(-1 * var(--space-5));
		scroll-padding-inline: var(--space-4);
	}

	.track::-webkit-scrollbar {
		display: none;
	}

	.track.compact {
		--card: 136px;
	}

	.track > :global(*) {
		scroll-snap-align: start;
	}

	.paging {
		display: flex;
		gap: var(--space-1);
	}

	.step {
		width: 2rem;
		height: 2rem;
		padding: 0;
		border-radius: 50%;
	}

	.step:disabled {
		opacity: 0.35;
		pointer-events: none;
	}

	/* A finger scrolls the line itself. */
	@media (hover: none) {
		.paging {
			display: none;
		}
	}

	/* Two and a half to a row on a phone: the half is the cue to swipe. */
	@media (max-width: 36rem) {
		.track {
			--card: 132px;
			gap: var(--space-1);
		}

		.track.compact {
			--card: 108px;
		}
	}
</style>
