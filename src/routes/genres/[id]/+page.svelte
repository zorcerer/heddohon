<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import MediaCard from '$lib/components/MediaCard.svelte';
	import MediaGrid from '$lib/components/MediaGrid.svelte';
	import Pager from '$lib/components/Pager.svelte';
	import { playContainer, queueContainer } from '$lib/client/actions';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const genre = $derived(data.genre);
	const base = $derived(`/genres/${encodeURIComponent(genre.id)}`);

	/**
	 * The artists with the most albums on this page of the genre, most first,
	 * up to 12: a way into the genre by the people in it. Only artists the
	 * server gave an id, since each is a link.
	 */
	const artists = $derived.by(() => {
		const tally = new Map<string, { id: string; name: string; albums: number }>();
		for (const album of data.albums) {
			if (!album.artistId || !album.artist) continue;
			const entry = tally.get(album.artistId);
			if (entry) entry.albums += 1;
			else tally.set(album.artistId, { id: album.artistId, name: album.artist, albums: 1 });
		}
		return [...tally.values()].sort((a, b) => b.albums - a.albums || a.name.localeCompare(b.name)).slice(0, 12);
	});
</script>

<svelte:head>
	<title>{genre.name} · Genres · Heddohon</title>
</svelte:head>

<div class="page">
	<header>
		<div>
			<a class="hh-eyebrow up" href="/genres">Genres</a>
			<h1 class="hh-display">{genre.name}</h1>
			<p class="hh-numeric hh-muted meta">
				{[
					genre.albumCount !== null ? `${genre.albumCount} albums` : null,
					genre.songCount !== null ? `${genre.songCount} tracks` : null
				]
					.filter(Boolean)
					.join(' · ')}
			</p>
		</div>
		<div class="actions">
			<button
				class="hh-button hh-button--primary"
				onclick={() => playContainer('genre', genre.id)}
				aria-label="Play a random selection"
				title="Play a random selection"
			>
				<Icon name="shuffle" size={16} />
				<span class="label">Play</span>
			</button>
			<button
				class="hh-button"
				onclick={() => queueContainer('genre', genre.id)}
				aria-label="Add a random selection to the queue"
				title="Add a random selection to the queue"
			>
				<Icon name="queue" size={16} />
				<span class="label">Queue</span>
			</button>
		</div>
	</header>

	{#if artists.length > 1}
		<nav class="artists" aria-label="Artists in {genre.name}">
			<span class="hh-eyebrow">Artists</span>
			{#each artists as artist (artist.id)}
				<a class="chip" href="/artists/{artist.id}">{artist.name}</a>
			{/each}
		</nav>
	{/if}

	{#if data.albums.length > 0}
		<MediaGrid density={data.settings.gridSize}>
			{#each data.albums as album (album.id)}
				<MediaCard
					href="/albums/{album.id}"
					title={album.name}
					subtitle={[album.artist, album.year].filter(Boolean).join(' · ')}
					coverArt={album.coverArt}
					transitionId={album.id}
					onplay={() => playContainer('album', album.id)}
				/>
			{/each}
		</MediaGrid>

		<Pager
			page={data.page}
			hasPrevious={data.page > 1}
			hasNext={data.hasMore}
			href={(target) => `${base}?page=${target}`}
			label="Genre pages"
		/>
	{:else}
		<p class="empty hh-muted">No albums in this genre.</p>
	{/if}
</div>

<style>
	.page {
		display: grid;
		gap: var(--space-5);
		max-width: var(--grid-max);
	}

	header {
		display: flex;
		align-items: flex-end;
		justify-content: space-between;
		gap: var(--space-5);
		flex-wrap: wrap;
		padding-bottom: var(--space-4);
		border-bottom: 1px solid var(--border-hairline);
	}

	h1 {
		margin: 0.2rem 0 0;
		font-size: clamp(2.25rem, 1.4rem + 2.6vw, 3.5rem);
	}

	.up {
		text-decoration: none;
	}

	.up:hover {
		color: var(--glow-color);
	}

	.meta {
		margin: var(--space-1) 0 0;
		font-size: 0.8125rem;
	}

	.actions {
		display: flex;
		gap: var(--space-2);
	}

	.actions .hh-button {
		padding: 0.55rem 1.05rem;
		border-radius: var(--r-md);
	}

	.artists {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-1);
	}

	.artists .hh-eyebrow {
		margin-right: var(--space-2);
	}

	/* The sort chips' material; see `SortChips`. */
	.chip {
		padding: 0.3rem 0.75rem;
		border-radius: var(--r-pill);
		border: 1px solid var(--border-hairline);
		background: var(--control-face);
		-webkit-backdrop-filter: var(--control-blur);
		backdrop-filter: var(--control-blur);
		color: var(--text-muted-through);
		font-size: 0.8125rem;
		font-weight: 500;
		white-space: nowrap;
		text-decoration: none;
		transition:
			text-shadow var(--transition),
			color var(--transition),
			border-color var(--transition);
	}

	.chip:hover {
		color: var(--glow-color);
		text-shadow: var(--glow-text);
		border-color: var(--border-strong);
	}

	.empty {
		padding: var(--space-7);
		text-align: center;
	}

	/* A phone: glyphs only, as on the album page. */
	@media (max-width: 36rem) {
		.actions .label {
			display: none;
		}

		.actions .hh-button {
			width: 2.75rem;
			height: 2.75rem;
			padding: 0;
		}
	}
</style>
