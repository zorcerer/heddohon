<script lang="ts">
	import { isPending, isStarred, setStarred } from '$lib/client/favourites.svelte';
	import type { StarKind } from '$lib/types';
	import Icon from './Icon.svelte';

	let {
		id,
		kind,
		starred = false,
		size = 18
	}: { id: string; kind: StarKind; starred?: boolean; size?: number } = $props();

	/** Set by a press that favourites, for the one-off pop below. */
	let popped = $state(false);

	// Optimistic: the heart flips immediately and reverts if the server
	// disagrees. The state is kept per item in favourites.svelte.ts, not here,
	// since the player passes this one instance a new `id` at each track change.
	const active = $derived(isStarred(kind, id, starred));

	// A pop started for one item does not carry over to the next.
	$effect.pre(() => {
		void id;
		popped = false;
	});

	function toggle(event: MouseEvent) {
		event.stopPropagation();
		event.preventDefault();
		if (isPending(kind, id)) return;

		const nextValue = !active;
		popped = nextValue;
		void setStarred(kind, id, nextValue);
	}
</script>

<button
	class="fav"
	class:active
	class:popped={popped && active}
	onanimationend={() => (popped = false)}
	onclick={toggle}
	aria-pressed={active}
	aria-label={active ? 'Remove from favourites' : 'Add to favourites'}
	title={active ? 'Remove from favourites' : 'Add to favourites'}
>
	<Icon name={active ? 'heart-filled' : 'heart'} {size} />
</button>

<style>
	.fav {
		display: grid;
		place-items: center;
		padding: 0.3rem;
		border-radius: var(--r-sm);
		color: var(--text-faint);
		transition:
			color var(--transition),
			background var(--transition);
	}

	.fav:hover {
		color: var(--text-default);
		filter: var(--glow-icon);
	}

	.fav.active {
		color: var(--danger);
	}

	.fav.active:hover {
		color: var(--danger);
	}

	/*
	 * The heart swells and settles as it fills, so the press is answered on the
	 * glyph rather than only by a change of colour. The glyph moves and the
	 * button does not: in the player panel this button carries a
	 * backdrop-filter, and transforms stay off glass in this codebase.
	 */
	.fav.popped :global(svg) {
		animation: heart-pop var(--dur-state) var(--ease-out);
	}

	@keyframes heart-pop {
		0% {
			scale: 1;
		}
		35% {
			scale: 1.28;
		}
		100% {
			scale: 1;
		}
	}
</style>
