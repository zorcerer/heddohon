<script lang="ts">
	import MediaCard from './MediaCard.svelte';
	import MediaShelf from './MediaShelf.svelte';
	import { playContainer } from '$lib/client/actions';
	import type { ForgottenAlbum } from '$lib/server/history';

	/**
	 * The home page's "Rediscover", set as the stacks of a library: covers
	 * faded as if left on a shelf in the sun, which take their colour back
	 * under the pointer, and under each a date-due slip with when it was last
	 * played and how often.
	 */
	let { albums, index }: { albums: ForgottenAlbum[]; index: number } = $props();

	const MONTH_MS = 30.44 * 24 * 60 * 60 * 1000;

	/*
	 * A span rather than a date. The server renders the page and the browser
	 * takes it over, and a date written in the locale and time zone of each
	 * would differ between the two; a count of months differs only if the
	 * render and the takeover fall either side of a month's end.
	 */
	function since(at: number): string {
		const months = Math.round((Date.now() - at) / MONTH_MS);
		if (months < 24) return `${months} months ago`;
		return `${Math.floor(months / 12)} years ago`;
	}
</script>

<div class="stacks">
	<MediaShelf title="Rediscover" eyebrow="Played often, not in the last six months" {index}>
		{#each albums as album (album.id)}
			<MediaCard
				href="/albums/{album.id}"
				title={album.name}
				subtitle={album.artist}
				coverArt={album.coverArt}
				transitionId={album.id}
				onplay={() => playContainer('album', album.id)}
			>
				{#snippet detail()}
					<dl class="slip hh-numeric">
						<dt>Last played</dt>
						<dd>{since(album.lastPlayed)}</dd>
						<dt>Plays</dt>
						<dd class="count">{album.plays.toLocaleString()}</dd>
					</dl>
				{/snippet}
			</MediaCard>
		{/each}
	</MediaShelf>
</div>

<style>
	.stacks {
		min-width: 0;
	}

	/*
	 * Faded: most of the colour gone and a little warmth in its place. It is a
	 * filter on the cover, which holds no glass, and it comes back on the
	 * colour curve as the sleeve lifts. A card on its way to the album page
	 * drops it at once, so the sleeve the next page receives is in colour.
	 */
	.stacks :global(.card .cover) {
		filter: grayscale(0.85) sepia(0.2) contrast(0.92);
		transition: filter var(--dur-colour) var(--ease-colour);
	}

	.stacks :global(.card:hover .cover),
	.stacks :global(.card:focus-visible .cover),
	.stacks :global(.card:has(:focus-visible) .cover),
	.stacks :global(.card.launching .cover) {
		filter: none;
	}

	.stacks :global(.card.launching .cover) {
		transition: none;
	}

	/* Nothing lifts under a finger, so the fade is half as deep there. */
	@media (hover: none) {
		.stacks :global(.card .cover) {
			filter: grayscale(0.45) sepia(0.12);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.stacks :global(.card .cover) {
			transition: none;
		}
	}

	/* Cards of one height in the line keep their text at the top. */
	.stacks :global(.card) {
		align-content: start;
	}

	/*
	 * The date-due slip: a dashed rule like the top of a library card, the
	 * two headings in small capitals, and under them the values, ruled off.
	 */
	.slip {
		display: grid;
		grid-template-columns: 1fr auto;
		grid-template-rows: auto auto;
		grid-auto-flow: column;
		column-gap: var(--space-2);
		margin: var(--space-2) 0 0;
		padding: 0.35rem 0 0.3rem;
		border-top: 1px dashed var(--border-strong);
		border-bottom: 1px solid var(--border-hairline);
	}

	.slip dt {
		color: var(--text-faint);
		text-transform: uppercase;
		letter-spacing: 0.1em;
		font-size: 0.5625rem;
	}

	.slip dd {
		margin: 0.1rem 0 0;
		color: var(--text-muted);
		font-size: 0.75rem;
		white-space: nowrap;
	}

	.slip dt:nth-of-type(2),
	.count {
		text-align: right;
	}

	@media (max-width: 36rem) {
		.slip {
			margin-top: var(--space-1);
		}

		.slip dt {
			letter-spacing: 0.04em;
		}

		.slip dd {
			font-size: 0.6875rem;
		}
	}
</style>
