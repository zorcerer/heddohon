<script lang="ts">
	import type { Album } from '$lib/types';
	import Cover from './Cover.svelte';
	import { ambience } from '$lib/client/ambience.svelte';
	import { warmAlbumCover } from '$lib/client/format';

	/**
	 * An album at list size: a small cover beside its title and artist. For a
	 * column of places to go back to, where a full card would take a screen for
	 * six of them. It opens the album; playing is on the album page, one press
	 * away, as on the cards.
	 */
	let { album }: { album: Album } = $props();

	/** Same as a card: the room starts on this cover's colour at the click. */
	function open(event: MouseEvent) {
		if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
		ambience.arriving(album.coverArt, `/albums/${album.id}`);
	}
</script>

<a
	class="tile"
	href="/albums/{album.id}"
	onclick={open}
	onpointerenter={() => warmAlbumCover(album.coverArt)}
	onfocusin={() => warmAlbumCover(album.coverArt)}
>
	<span class="thumb"><Cover coverArt={album.coverArt} size={96} alt="" radius="var(--r-sm)" /></span>
	<span class="text">
		<span class="title hh-truncate">{album.name}</span>
		{#if album.artist}
			<span class="artist hh-truncate hh-muted">{album.artist}</span>
		{/if}
	</span>
</a>

<style>
	.tile {
		position: relative;
		isolation: isolate;
		display: grid;
		grid-template-columns: 3rem minmax(0, 1fr);
		align-items: center;
		gap: var(--space-3);
		padding: var(--space-1);
		padding-right: var(--space-3);
		border-radius: var(--r-sm);
		text-decoration: none;
	}

	/* The track rows' hover: a wash in the accent that opens from the left. */
	.tile::before {
		content: '';
		position: absolute;
		inset: 0;
		z-index: -1;
		border-radius: inherit;
		background: linear-gradient(
			90deg,
			color-mix(in srgb, var(--accent) 13%, transparent),
			color-mix(in srgb, var(--accent) 4%, transparent) 55%,
			transparent
		);
		transform-origin: left center;
		opacity: 0;
		scale: 0.97 1;
		pointer-events: none;
		transition:
			opacity var(--dur-state) var(--ease-out),
			scale var(--dur-state) var(--ease-out);
	}

	.tile:hover::before,
	.tile:focus-visible::before {
		opacity: 1;
		scale: 1;
	}

	.thumb {
		display: block;
		transition:
			translate var(--dur-state) var(--ease-spring),
			filter var(--dur-state) var(--ease-out);
	}

	.tile:hover .thumb {
		translate: 0 -2px;
		filter: drop-shadow(0 0.4rem 0.8rem color-mix(in srgb, var(--accent) 38%, transparent));
	}

	.text {
		display: grid;
		gap: 0.05rem;
		min-width: 0;
	}

	.title {
		color: var(--text-strong);
		font-weight: 550;
		font-size: 0.875rem;
		transition:
			color var(--transition),
			text-shadow var(--transition);
	}

	.tile:hover .title,
	.tile:focus-visible .title {
		color: var(--glow-color);
		text-shadow: var(--glow-text);
	}

	.artist {
		font-size: 0.78125rem;
	}

	@media (prefers-reduced-motion: reduce) {
		.thumb {
			transition: none;
		}
	}
</style>
