<script lang="ts">
	import { ratingOf, setRating } from '$lib/client/ratings.svelte';
	import type { RatingKind } from '$lib/types';
	import Icon from './Icon.svelte';

	let {
		id,
		kind,
		rating = 0,
		size = 16
	}: { id: string; kind: RatingKind; rating?: number | null; size?: number } = $props();

	const STARS = [1, 2, 3, 4, 5];

	// Optimistic, as the heart is: the stars change at once and go back if the
	// server refuses. The value is kept per item in ratings.svelte.ts, since the
	// player passes this one instance a new `id` at each track change.
	const current = $derived(ratingOf(kind, id, rating ?? 0));

	function rate(event: MouseEvent, stars: number) {
		event.stopPropagation();
		event.preventDefault();
		// Pressing the star that is the rating clears it, as Navidrome's own
		// stars do.
		void setRating(kind, id, stars === current ? 0 : stars, current);
	}
</script>

<!-- A row of buttons rather than a slider: each star is one press, and the
     label says what the press does. -->
<div class="stars" role="group" aria-label={current > 0 ? `Rated ${current} of 5` : 'Not rated'}>
	{#each STARS as stars (stars)}
		<button
			class="star"
			class:lit={stars <= current}
			onclick={(event) => rate(event, stars)}
			aria-pressed={stars === current}
			aria-label={stars === current ? 'Clear the rating' : `Rate ${stars} of 5`}
			title={stars === current ? 'Clear the rating' : `${stars} of 5`}
		>
			<Icon name={stars <= current ? 'star-filled' : 'star'} {size} />
		</button>
	{/each}
</div>

<style>
	.stars {
		display: inline-flex;
		align-items: center;
	}

	.star {
		display: grid;
		place-items: center;
		padding: 0.15rem;
		border-radius: var(--r-sm);
		color: var(--text-faint);
		transition: color var(--transition);
	}

	.star.lit {
		color: var(--glow-color);
	}

	/* Pointing at a star lights it and the ones before it, and dims the rest,
	   so the row shows the rating a press would give. */
	.stars:hover .star {
		color: var(--glow-color);
	}

	.stars .star:hover ~ .star {
		color: var(--text-faint);
	}

	.star:focus-visible {
		outline: 2px solid var(--glow-color);
		outline-offset: 1px;
	}
</style>
