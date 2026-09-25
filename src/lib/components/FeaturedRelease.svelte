<script lang="ts">
	/**
	 * One release given a panel of its own: its artwork fills the panel,
	 * cropped and zoomed in past its edges, with the details laid over the
	 * darker lower corner. The page's only poster-scale moment; everything
	 * below it is deliberately smaller.
	 */
	import type { Album } from '$lib/types';
	import Cover from './Cover.svelte';
	import Icon from './Icon.svelte';

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

<!-- Measured by the space it is given, since the home page may set it beside a
     column rather than across the page. -->
<div class="frame">
	<section class="featured">
		<!-- 640px at twice the density: the panel is up to about 900px wide, and
		     the zoom crops a fifth of the picture away. -->
		<div class="art" aria-hidden="true">
			<Cover coverArt={album.coverArt} size={640} hidpi fill radius="0" alt="" />
		</div>
		<div class="scrim" aria-hidden="true"></div>

		<!-- The whole panel opens the album; the links and the button in the
		     details sit above this and keep their own clicks. -->
		<a class="open" href="/albums/{album.id}" aria-label="Open {album.name}"></a>

		{#if album.year}
			<!-- The year as a folio number, the way a catalogue prints its edition on
			     the outer edge of the page. -->
			<span class="folio hh-display" aria-hidden="true">{album.year}</span>
		{/if}

		<div class="body">
			<span class="hh-eyebrow eyebrow">{eyebrow}</span>

			<a href="/albums/{album.id}" tabindex="-1">
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
</div>

<style>
	.frame {
		container-type: inline-size;
		/* Beside a taller column, the panel takes that height. */
		height: 100%;
	}

	/*
	 * Not glass: the artwork is the surface. The text over it is light in both
	 * themes, since what it sits on is the darkened picture, not the room.
	 */
	.featured {
		position: relative;
		isolation: isolate;
		overflow: hidden;
		display: grid;
		align-items: end;
		height: 100%;
		min-height: 18rem;
		box-sizing: border-box;
		padding: var(--space-5);
		border-radius: var(--r-xl);
		border: 1px solid var(--border-hairline);
		background: var(--bg-surface);
		box-shadow: var(--shadow-mid);
	}

	/*
	 * Zoomed in past the panel's edges and settling a little on arrival, then
	 * drifting in a touch further under the pointer. A transform on a layer of
	 * its own, so neither step repaints the picture. It holds no glass and has
	 * none over it.
	 */
	.art {
		position: absolute;
		inset: 0;
		z-index: -2;
		scale: 1.14;
		animation: featured-settle calc(var(--dur-colour) * 2) var(--ease-out) both;
		transition: scale calc(var(--dur-colour) * 1.5) var(--ease-colour);
		will-change: scale;
	}

	.art :global(.cover) {
		width: 100%;
		height: 100%;
	}

	@keyframes featured-settle {
		from {
			scale: 1.26;
		}
	}

	@media (hover: hover) {
		.featured:hover .art {
			scale: 1.2;
		}
	}

	/*
	 * Darkest in the lower left, where the details are, and clear in the upper
	 * right, where the picture is left to be seen. A touch of the accent in the
	 * dark, so the shade belongs to the room rather than being plain black.
	 */
	.scrim {
		position: absolute;
		inset: 0;
		z-index: -1;
		background:
			linear-gradient(
				to top,
				color-mix(in srgb, var(--accent) 8%, rgb(6 8 10 / 0.9)) 0%,
				rgb(6 8 10 / 0.5) 42%,
				rgb(6 8 10 / 0.08) 78%
			),
			linear-gradient(to right, rgb(6 8 10 / 0.45), transparent 65%);
	}

	.open {
		position: absolute;
		inset: 0;
		z-index: 0;
		border-radius: inherit;
	}

	.open:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: -4px;
	}

	.folio {
		position: absolute;
		right: var(--space-5);
		top: var(--space-4);
		z-index: 0;
		font-size: clamp(3rem, 1.5rem + 7cqw, 7rem);
		line-height: 0.8;
		color: rgb(255 255 255 / 0.16);
		letter-spacing: -0.06em;
		user-select: none;
		pointer-events: none;
	}

	/* Above the panel's link; only its own links and button take the pointer. */
	.body {
		position: relative;
		z-index: 1;
		display: grid;
		gap: var(--space-2);
		justify-items: start;
		min-width: 0;
		max-width: 38rem;
		pointer-events: none;
		color: rgb(255 255 255 / 0.92);
		text-shadow: 0 1px 14px rgb(0 0 0 / 0.35);
	}

	.body a,
	.body button {
		pointer-events: auto;
	}

	.eyebrow {
		color: rgb(255 255 255 / 0.7);
	}

	.title {
		/* Poster scale: this is the largest type anywhere in the app. */
		font-size: clamp(2rem, 1rem + 5cqw, 4.25rem);
		margin: 0.1rem 0 0;
		color: #fff;
	}

	.artist {
		margin: 0;
		font-size: 1.0625rem;
		font-weight: 500;
	}

	.artist a:hover {
		text-decoration: underline;
		text-underline-offset: 3px;
	}

	.facts {
		margin: 0;
		font-size: 0.75rem;
		color: rgb(255 255 255 / 0.66);
	}

	.dot {
		margin: 0 0.4rem;
	}

	.play {
		margin-top: var(--space-3);
		padding: 0.65rem 1.25rem;
		border-radius: var(--r-md);
		text-shadow: none;
	}

	@container (max-width: 50rem) {
		.folio {
			display: none;
		}
	}

	@container (max-width: 30rem) {
		.featured {
			min-height: 15rem;
			padding: var(--space-4);
		}

		.title {
			font-size: clamp(1.75rem, 0.9rem + 6cqw, 2.5rem);
		}

		.play {
			margin-top: var(--space-2);
			padding: 0.55rem 1rem;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.art {
			animation: none;
			transition: none;
		}
	}
</style>
