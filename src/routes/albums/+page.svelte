<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import MediaCard from '$lib/components/MediaCard.svelte';
	import MediaGrid from '$lib/components/MediaGrid.svelte';
	import Pager from '$lib/components/Pager.svelte';
	import SortChips from '$lib/components/SortChips.svelte';
	import { playContainer } from '$lib/client/actions';
	import { page as pageState } from '$app/state';
	import type { AlbumSort } from '$lib/types';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const LABELS: Record<AlbumSort, string> = {
		recentlyAdded: 'Recently added',
		alphabetical: 'A–Z',
		byArtist: 'By artist',
		byYear: 'By year',
		mostPlayed: 'Most played',
		recentlyPlayed: 'Recently played',
		starred: 'Favourites',
		random: 'Random'
	};

	function sortHref(sort: AlbumSort): string {
		const params = new URLSearchParams(pageState.url.searchParams);
		params.set('sort', sort);
		// A new ordering starts at the top; keeping the old page number would land
		// the reader somewhere arbitrary in a different list.
		params.delete('page');
		return `/albums?${params}`;
	}

	function pageHref(target: number): string {
		const params = new URLSearchParams(pageState.url.searchParams);
		params.set('page', String(target));
		params.set('sort', data.sort);
		return `/albums?${params}`;
	}
</script>

<svelte:head>
	<title>Albums · Heddohon</title>
</svelte:head>

<div class="page">
	<header>
		<div>
			<span class="hh-eyebrow">Library</span>
			<h1>Albums</h1>
			<!-- The way to genres on a phone, where the rail has no room for it. -->
			<a class="to-genres" href="/genres">
				<Icon name="genre" size={14} />
				Browse by genre
			</a>
		</div>
		<SortChips
			sorts={data.sorts}
			active={data.sort}
			labels={LABELS}
			href={sortHref}
			label="Sort albums"
		/>
	</header>

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
			href={pageHref}
			label="Album pages"
		/>
	{:else}
		<p class="empty hh-muted">No albums matched this view.</p>
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

	.empty {
		padding: var(--space-7);
		text-align: center;
	}

	.to-genres {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
		margin-top: var(--space-2);
		font-size: 0.8125rem;
		color: var(--text-muted);
		text-decoration: none;
		transition:
			color var(--transition),
			text-shadow var(--transition);
	}

	.to-genres:hover {
		color: var(--glow-color);
		text-shadow: var(--glow-text);
	}
</style>
