<script lang="ts">
	/**
	 * One release given the whole width, so the home page opens with something to
	 * look at instead of the twelfth identical square. This is the page's only
	 * poster-scale moment; everything below it is deliberately smaller.
	 */
	import type { Album } from '$lib/types';
	import Icon from './Icon.svelte';
	import Sleeve from './Sleeve.svelte';

	let {
		album,
		eyebrow = 'Latest addition',
		onplay
	}: { album: Album; eyebrow?: string; onplay: () => void } = $props();

	// The year is set separately as a folio, so it is dropped from the inline
	// facts to avoid printing it twice.
	const facts = $derived(
		[album.genre, album.songCount ? `${album.songCount} tracks` : null].filter(Boolean) as string[]
	);
</script>

<section class="featured hh-glass">
	<a class="sleeve-link" href="/albums/{album.id}" aria-label="Open {album.name}">
		<Sleeve coverArt={album.coverArt} size={768} alt="" radius="var(--r-lg)" />
	</a>

	{#if album.year}
		<!-- The year as a folio number, the way a catalogue prints its edition on
		     the outer edge of the page. Quiet enough to be texture, legible enough
		     to still be information. -->
		<span class="folio hh-display" aria-hidden="true">{album.year}</span>
	{/if}

	<div class="body">
		<span class="hh-eyebrow">{eyebrow}</span>

		<a href="/albums/{album.id}">
			<h2 class="hh-display title">{album.name}</h2>
		</a>

		{#if album.artist}
			<p class="artist">
				{#if album.artistId}
					<a href="/artists/{album.artistId}">{album.artist}</a>
				{:else}
					{album.artist}
				{/if}
			</p>
		{/if}

		{#if facts.length > 0}
			<p class="facts hh-numeric">
				{#each facts as fact, i (fact)}
					{#if i > 0}<span class="dot" aria-hidden="true">·</span>{/if}{fact}
				{/each}
			</p>
		{/if}

		<button class="hh-button hh-button--primary play" onclick={onplay}>
			<Icon name="play" size={16} />
			Play release
		</button>
	</div>
</section>

<style>
	.featured {
		display: grid;
		grid-template-columns: minmax(0, 17rem) minmax(0, 1fr);
		gap: var(--space-6);
		align-items: center;
		padding: var(--space-5) var(--space-5) var(--space-5) var(--space-5);
		border-radius: var(--r-xl);
		border: 1px solid var(--border-hairline);
		position: relative;
		overflow: hidden;
		/*
		 * The same glass as the chrome rather than a bespoke translucency. It is
		 * the one panel sitting in the middle of the field, so a surface that
		 * transmitted the light differently from everything else would read as a
		 * hole in it.
		 */
	}

	.sleeve-link,
	.body {
		position: relative;
		z-index: 1;
	}

	.folio {
		position: absolute;
		right: var(--space-5);
		top: 50%;
		transform: translateY(-50%);
		z-index: 0;
		font-size: clamp(4rem, 2rem + 7vw, 9rem);
		line-height: 0.8;
		color: var(--text-strong);
		opacity: 0.06;
		letter-spacing: -0.06em;
		user-select: none;
		pointer-events: none;
	}

	.body {
		display: grid;
		gap: var(--space-2);
		justify-items: start;
		min-width: 0;
		/* Keeps the headline off the folio at wide viewports. */
		max-width: 42rem;
	}

	.title {
		/* Poster scale: this is the largest type anywhere in the app. */
		font-size: clamp(2.25rem, 1.2rem + 3.6vw, 4.25rem);
		margin: 0.1rem 0 0;
	}

	.artist {
		margin: 0;
		font-size: 1.0625rem;
		font-weight: 500;
		color: var(--text-default);
	}

	.artist a:hover {
		color: var(--accent);
		text-decoration: underline;
		text-underline-offset: 3px;
	}

	.facts {
		margin: 0;
		font-size: 0.75rem;
		color: var(--text-faint);
	}

	.dot {
		margin: 0 0.4rem;
	}

	.play {
		margin-top: var(--space-3);
		padding: 0.65rem 1.25rem;
		border-radius: var(--r-md);
	}

	@media (max-width: 72rem) {
		.folio {
			display: none;
		}
	}

	@media (max-width: 56rem) {
		.featured {
			grid-template-columns: minmax(0, 1fr);
			gap: var(--space-4);
			padding: var(--space-4);
		}

		.sleeve-link {
			max-width: 13rem;
		}
	}
</style>
