<script lang="ts">
	import { isPending, isStarred, setStarred } from '$lib/client/favourites.svelte';
	import type { StarKind } from '$lib/types';
	import Icon from './Icon.svelte';

	let {
		id,
		kind,
		starred = false,
		size = 18,
		labelled = false
	}: {
		id: string;
		kind: StarKind;
		starred?: boolean;
		size?: number;
		/**
		 * Among a page's actions, where Terminal draws each as a word between
		 * brackets and a heart alone was the one that was not. The word is drawn
		 * in Terminal only; the other themes keep the glyph.
		 */
		labelled?: boolean;
	} = $props();

	/** Set by a press that favourites, for the one-off pop below. */
	let popped = $state(false);

	// Optimistic: the heart flips at once and reverts if the server refuses. The
	// state is kept per item in favourites.svelte.ts, since the player passes
	// this one instance a new `id` at each track change.
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
	class:labelled
	class:popped={popped && active}
	onanimationend={() => (popped = false)}
	onclick={toggle}
	aria-pressed={active}
	aria-label={active ? 'Remove from favourites' : 'Add to favourites'}
	title={active ? 'Remove from favourites' : 'Add to favourites'}
>
	<Icon name={active ? 'heart-filled' : 'heart'} {size} />
	{#if labelled}<span class="label" aria-hidden="true">{active ? 'favourited' : 'favourite'}</span>{/if}
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
	 * The heart swells and settles as it fills. The glyph moves and the button
	 * does not: in the player panel this button carries a backdrop-filter, and
	 * transforms stay off glass.
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

	.label {
		display: none;
	}

	/* ── Terminal ────────────────────────────────────────────────────────────── */

	/* Among a page's actions it is one of them: the word between brackets, on
	   their size and spacing, with the heart where their glyph is. */
	:global([data-theme='terminal']) .fav.labelled {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		padding: 0.5rem 0.125rem;
		border-radius: 0;
		color: var(--text-strong);
		font-size: 0.875rem;
		text-transform: lowercase;
		white-space: nowrap;
	}

	:global([data-theme='terminal']) .fav.labelled .label {
		display: inline;
	}

	:global([data-theme='terminal']) .fav.labelled::before,
	:global([data-theme='terminal']) .fav.labelled::after {
		color: var(--text-faint);
		transition: color var(--transition);
	}

	/* Each with an empty alternative text; the plain declaration is for Safari
	   before 17.4. */
	:global([data-theme='terminal']) .fav.labelled::before {
		content: '[';
		content: '[' / '';
	}

	:global([data-theme='terminal']) .fav.labelled::after {
		content: ']';
		content: ']' / '';
	}

	:global([data-theme='terminal']) .fav.labelled:hover,
	:global([data-theme='terminal']) .fav.labelled:focus-visible {
		color: var(--accent);
	}

	:global([data-theme='terminal']) .fav.labelled:hover::before,
	:global([data-theme='terminal']) .fav.labelled:hover::after {
		color: var(--accent);
	}

	/* The heart keeps its own red when it is filled, under either colour of
	   the word. */
	:global([data-theme='terminal']) .fav.labelled.active :global(svg) {
		color: var(--danger);
	}

	/* On a phone the actions are glyphs in keys, and so is this one. */
	@media (max-width: 36rem) {
		:global([data-theme='terminal']) .fav.labelled {
			justify-content: center;
			width: 2.75rem;
			height: 2.75rem;
			padding: 0;
			border: 1px solid var(--border-strong);
			border-radius: var(--r-sm);
		}

		:global([data-theme='terminal']) .fav.labelled .label {
			display: none;
		}

		:global([data-theme='terminal']) .fav.labelled::before,
		:global([data-theme='terminal']) .fav.labelled::after {
			content: none;
		}
	}
</style>
