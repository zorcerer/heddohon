<script lang="ts">
	import { goto } from '$app/navigation';
	import Cover from './Cover.svelte';
	import Icon from './Icon.svelte';
	import Sleeve from './Sleeve.svelte';
	import { LAUNCH_MS, sleeveToken, sleeveTransition } from '$lib/client/sleeve-transition.svelte';
	import { ambience } from '$lib/client/ambience.svelte';

	let {
		href,
		title,
		subtitle = null,
		coverArt,
		/** Artists are people, not records: they get a plain round portrait. */
		rounded = false,
		transitionId = null,
		onplay = null
	}: {
		href: string;
		title: string;
		subtitle?: string | null;
		coverArt: string | null | undefined;
		rounded?: boolean;
		/** Album id, if this card should carry its sleeve into the next page. */
		transitionId?: string | null;
		onplay?: (() => void) | null;
	} = $props();

	let launching = $state(false);
	// Stable for this card's lifetime, so a duplicate album in another shelf
	// cannot claim the same view-transition-name at the same moment.
	const token = sleeveToken();

	/**
	 * Takes over the anchor's own navigation so the record has time to leave the
	 * sleeve before the page changes. Modified clicks are left alone — opening in
	 * a new tab must keep working, and an animation is no reason to break it.
	 */
	function open(event: MouseEvent) {
		if (!transitionId) return;
		if (event.defaultPrevented) return;
		if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

		event.preventDefault();
		launching = true;
		sleeveTransition.begin(transitionId, token, location.pathname + location.search);
		// This cover is on screen and decoded, so the room can start moving to its
		// colour now rather than when the page it belongs to finishes loading.
		ambience.arriving(coverArt, href);
		setTimeout(() => void goto(href), LAUNCH_MS);
	}
</script>

<a class="card" class:portrait={rounded} class:launching {href} onclick={open}>
	<div class="art">
		{#if rounded}
			<Cover {coverArt} rounded size={384} alt="" />
		{:else}
			<Sleeve
				{coverArt}
				size={384}
				alt=""
				{transitionId}
				transitionToken={token}
				{launching}
				radius="var(--r-md)"
			/>
		{/if}
		{#if onplay}
			<button
				class="play"
				onclick={(event) => {
					event.preventDefault();
					event.stopPropagation();
					onplay?.();
				}}
				aria-label="Play {title}"
			>
				<Icon name="play" size={16} />
			</button>
		{/if}
	</div>
	<div class="text">
		<span class="title hh-clamp-2">{title}</span>
		{#if subtitle}
			<span class="subtitle hh-truncate hh-muted">{subtitle}</span>
		{/if}
	</div>
</a>

<style>
	.card {
		display: grid;
		gap: var(--space-3);
		padding: var(--space-2) var(--space-2) var(--space-3);
		border-radius: var(--r-md);
	}

	/* The record slides out past the card's own box, so hovering has to raise the
	   whole card above its neighbours or the disc is clipped by the next one.
	   This changes nothing visible on its own — it is purely stacking. */
	.card:hover,
	.card.launching {
		position: relative;
		z-index: 3;
	}

	.art {
		position: relative;
		transition: transform var(--transition);
	}

	/*
	 * The hover cue is the sleeve lifting a couple of pixels, not a grey wash
	 * behind the card. A tinted panel under one card fights the single coloured
	 * field the rest of the interface is lit by; moving the thing you are
	 * pointing at does not.
	 */
	.card:hover .art {
		transform: translateY(-0.2rem);
	}

	/* A card in flight is handing its sleeve to the next page; leaving an offset
	   on the ancestor would shift the geometry the morph is captured from. */
	.card.launching .art {
		transform: none;
	}

	/* The offset stays — three pixels is a position, not an animation. What goes
	   is the travel between the two positions. */
	@media (prefers-reduced-motion: reduce) {
		.art {
			transition: none;
		}
	}

	.play {
		position: absolute;
		left: 0.55rem;
		bottom: 0.55rem;
		z-index: 2;
		display: grid;
		place-items: center;
		width: 2.25rem;
		height: 2.25rem;
		border-radius: 50%;
		background: var(--text-strong);
		color: var(--bg-base);
		box-shadow: var(--shadow-mid);
		opacity: 0;
		transform: translateY(0.3rem);
		transition:
			opacity var(--transition),
			transform var(--transition);
		padding-left: 2px;
	}

	.card:hover .play,
	.play:focus-visible {
		opacity: 1;
		transform: translateY(0);
	}

	.text {
		display: grid;
		gap: 0.1rem;
		min-width: 0;
	}

	.portrait .text {
		text-align: center;
	}

	.title {
		color: var(--text-strong);
		font-weight: 550;
		font-size: 0.9375rem;
		line-height: 1.25;
		letter-spacing: -0.01em;
	}

	.subtitle {
		font-size: 0.8125rem;
	}
</style>
