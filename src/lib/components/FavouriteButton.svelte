<script lang="ts">
	import { isPending, isStarred, setStarred } from '#lib/client/favourites.svelte.ts';
	import type { StarKind } from '#lib/types.ts';
	import PulseHeart from './bits/PulseHeart.svelte';

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

	// Optimistic: the heart flips at once and reverts if the server refuses. The
	// state is kept per item in favourites.svelte.ts, since the player passes
	// this one instance a new `id` at each track change.
	const active = $derived(isStarred(kind, id, starred));
	const name = $derived(active ? 'Remove from favourites' : 'Add to favourites');
</script>

<!-- Svelte Bits' PulseHeart: the heart contracts to a dot and pulses back in its new state. -->
<PulseHeart
	liked={active}
	onChange={(liked) => void setStarred(kind, id, liked)}
	disabled={isPending(kind, id)}
	showCount={false}
	// PulseHeart's heart fills its box where the icon set's leaves a margin;
	// beside a word, as the glyphs of the other actions are, a little larger.
	size={Math.round(size * (labelled ? 0.85 : 0.7))}
	corner={6}
	// A place that colours what it holds (the player's rounds) sets these.
	idleColor="var(--fav-idle, var(--text-faint))"
	likedColor="var(--fav-liked, var(--danger))"
	pillColor="transparent"
	textColor="currentColor"
	label={name}
	title={name}
	contained
	className={`fav${labelled ? ' labelled' : ''}${active ? ' active' : ''}`}
>
	{#if labelled}<span class="label" aria-hidden="true">{active ? 'favourited' : 'favourite'}</span>{/if}
</PulseHeart>

<style>
	/* The heart's colours, its press and its swell are PulseHeart's own. */
	:global(.fav) {
		border-radius: var(--r-sm);
	}

	:global(.fav .label) {
		display: none;
	}

	/* ── Terminal ────────────────────────────────────────────────────────────── */

	/* Among a page's actions it is one of them: the word between brackets, on
	   their size and spacing, with the heart where their glyph is. */
	:global([data-theme='terminal'] .fav.labelled) {
		gap: 0.4rem;
		padding: 0.5rem 0.125rem;
		border-radius: 0;
		color: var(--text-strong);
		font-size: 0.875rem;
		text-transform: lowercase;
		white-space: nowrap;
	}

	:global([data-theme='terminal'] .fav.labelled .label) {
		display: inline;
	}

	/* The heart against the bracket, as the other actions' glyphs are. */
	:global([data-theme='terminal'] .fav.labelled > span:first-child) {
		padding: 0;
	}

	/* Each with an empty alternative text; the plain declaration is for Safari
	   before 17.4. */
	:global([data-theme='terminal'] .fav.labelled::before) {
		content: '[';
		content: '[' / '';
		/* Against the label, as `.hh-button`'s are (`terminal.css`). */
		margin-right: -0.35rem;
		color: var(--text-faint);
	}

	:global([data-theme='terminal'] .fav.labelled::after) {
		content: ']';
		content: ']' / '';
		margin-left: -0.35rem;
		color: var(--text-faint);
	}

	:global([data-theme='terminal'] .fav.labelled:hover),
	:global([data-theme='terminal'] .fav.labelled:focus-visible),
	:global([data-theme='terminal'] .fav.labelled:hover::before),
	:global([data-theme='terminal'] .fav.labelled:hover::after) {
		color: var(--accent);
	}

	/* On a phone the actions are glyphs in keys, and so is this one. */
	@media (max-width: 36rem) {
		:global([data-theme='terminal'] .fav.labelled) {
			justify-content: center;
			width: 2.75rem;
			height: 2.75rem;
			padding: 0;
			border: 1px solid var(--border-strong);
			border-radius: var(--r-sm);
		}

		:global([data-theme='terminal'] .fav.labelled .label) {
			display: none;
		}

		:global([data-theme='terminal'] .fav.labelled::before),
		:global([data-theme='terminal'] .fav.labelled::after) {
			content: none;
		}
	}
</style>
