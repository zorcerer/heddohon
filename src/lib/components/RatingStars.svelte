<script lang="ts">
	import { ratingOf, setRating } from '#lib/client/ratings.svelte.ts';
	import type { RatingKind } from '#lib/types.ts';
	import PeekRating from './bits/PeekRating.svelte';

	let {
		id,
		kind,
		rating = 0,
		size = 16
	}: { id: string; kind: RatingKind; rating?: number | null; size?: number } = $props();

	// Optimistic, as the heart is: the stars change at once and go back if the
	// server refuses. The value is kept per item in ratings.svelte.ts, since the
	// player passes this one instance a new `id` at each track change.
	const current = $derived(ratingOf(kind, id, rating ?? 0));
</script>

<!-- Svelte Bits' PeekRating: the stars a press would give rise as they are
     pointed at, and a press on the rating clears it, as Navidrome's own stars
     do. A radio group, one star a choice. -->
<PeekRating
	value={current}
	onChange={(next) => void setRating(kind, id, next, current)}
	{size}
	lift={Math.round(size * 0.3)}
	showTip={false}
	allowClear
	activeColor="var(--glow-color)"
	idleColor="var(--text-faint)"
	ariaLabel={current > 0 ? `Rated ${current} of 5` : 'Not rated'}
	className="stars"
/>
