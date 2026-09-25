<script lang="ts">
	import { page as pageState } from '$app/state';
	import Icon from '$lib/components/Icon.svelte';
	import MediaCard from '$lib/components/MediaCard.svelte';
	import MediaGrid from '$lib/components/MediaGrid.svelte';
	import Pager from '$lib/components/Pager.svelte';
	import SectionHeader from '$lib/components/SectionHeader.svelte';
	import SortChips from '$lib/components/SortChips.svelte';
	import TrackList from '$lib/components/TrackList.svelte';
	import { playContainer } from '$lib/client/actions';
	import { player } from '$lib/client/player.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const total = $derived(data.counts.songs + data.counts.albums + data.counts.artists);
	const LABELS = { songs: 'Tracks', albums: 'Albums', artists: 'Artists' } as const;

	type Sort = (typeof data.sorts)[number];

	const SORT_LABELS: Record<Sort, string> = {
		recentlyStarred: 'Recently starred',
		alphabetical: 'A–Z',
		byArtist: 'By artist',
		byAlbum: 'By album',
		byYear: 'By year',
		mostPlayed: 'Most played',
		recentlyAdded: 'Recently added',
		mostAlbums: 'Most albums'
	};

	function tabHref(tab: (typeof data.tabs)[number]): string {
		const params = new URLSearchParams();
		params.set('tab', tab);
		// A tab change starts at page one; carrying the page number over would
		// land on an arbitrary point in a different list. The sort is dropped
		// with it: each tab has its own orders.
		return `/favourites?${params}`;
	}

	function sortHref(sort: Sort): string {
		const params = new URLSearchParams(pageState.url.searchParams);
		params.set('tab', data.tab);
		params.set('sort', sort);
		// A new ordering starts at the top, as on the albums page.
		params.delete('page');
		return `/favourites?${params}`;
	}

	function pageHref(target: number): string {
		const params = new URLSearchParams(pageState.url.searchParams);
		params.set('tab', data.tab);
		params.set('page', String(target));
		params.set('sort', data.sort);
		return `/favourites?${params}`;
	}

	/**
	 * "Play tracks" queues the page you are looking at, not the whole favourites
	 * list — queueing several thousand tracks from a button labelled like this
	 * would be a surprise.
	 */
	const pageSongs = $derived(data.songs?.items ?? []);
</script>

<svelte:head>
	<title>Favourites · Heddohon</title>
</svelte:head>

<div class="page">
	<SectionHeader title="Favourites" eyebrow="Starred in your music server">
		{#snippet actions()}
			{#if pageSongs.length > 0}
				<button class="hh-button hh-button--primary" onclick={() => player.playNow(pageSongs)}>
					<Icon name="play" size={16} />
					Play these
				</button>
			{/if}
		{/snippet}
	</SectionHeader>

	{#if total === 0}
		<div class="empty">
			<Icon name="heart" size={28} />
			<h2>No favourites yet</h2>
			<p class="hh-muted">
				Star a track, album or artist anywhere in Heddohon and it will collect here. Favourites are
				stored in your music server, so they follow you to any other client.
			</p>
		</div>
	{:else}
		<div class="bar">
			<nav class="tabs" aria-label="Favourite type">
				{#each data.tabs as tab (tab)}
					{#if data.counts[tab] > 0}
						<a
							class="tab"
							class:active={tab === data.tab}
							href={tabHref(tab)}
							aria-current={tab === data.tab ? 'page' : undefined}
							data-sveltekit-noscroll
						>
							{LABELS[tab]}
							<span class="hh-numeric count">{data.counts[tab].toLocaleString()}</span>
						</a>
					{/if}
				{/each}
			</nav>
			{#if data.counts[data.tab] > 1}
				<SortChips
					sorts={data.sorts}
					active={data.sort}
					labels={SORT_LABELS}
					href={sortHref}
					label="Sort favourites"
				/>
			{/if}
		</div>

		{#if data.songs}
			<TrackList songs={data.songs.items} variant="artwork" showAlbum />
			<Pager {...data.songs} href={pageHref} label="Favourite track pages" noun="tracks" />
		{:else if data.albums}
			<MediaGrid density={data.settings.gridSize}>
				{#each data.albums.items as album (album.id)}
					<MediaCard
						href="/albums/{album.id}"
						title={album.name}
						subtitle={album.artist}
						coverArt={album.coverArt}
						transitionId={album.id}
						onplay={() => playContainer('album', album.id)}
					/>
				{/each}
			</MediaGrid>
			<Pager {...data.albums} href={pageHref} label="Favourite album pages" noun="albums" />
		{:else if data.artists}
			<MediaGrid density="compact">
				{#each data.artists.items as artist (artist.id)}
					<MediaCard
						href="/artists/{artist.id}"
						title={artist.name}
						subtitle={artist.albumCount ? `${artist.albumCount} albums` : null}
						coverArt={artist.coverArt}
						rounded
					/>
				{/each}
			</MediaGrid>
			<Pager {...data.artists} href={pageHref} label="Favourite artist pages" noun="artists" />
		{/if}
	{/if}
</div>

<style>
	.page {
		display: grid;
		gap: var(--space-4);
		max-width: var(--grid-max);
	}

	.bar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		flex-wrap: wrap;
		gap: var(--space-2);
		border-bottom: 1px solid var(--border-hairline);
		padding-bottom: var(--space-2);
	}

	.tabs {
		display: flex;
		gap: var(--space-1);
	}

	.tab {
		display: inline-flex;
		align-items: center;
		gap: var(--space-2);
		padding: 0.35rem 0.8rem;
		border-radius: var(--r-pill);
		color: var(--text-muted);
		font-size: 0.875rem;
		font-weight: 500;
		transition:
			background var(--transition),
			color var(--transition);
	}

	.tab:hover,
	.tab.active {
		color: var(--glow-color);
		text-shadow: var(--glow-text);
	}

	.count {
		font-size: 0.6875rem;
		color: var(--text-faint);
	}

	.empty {
		padding: var(--space-7);
		display: grid;
		justify-items: center;
		gap: var(--space-2);
		text-align: center;
		color: var(--text-faint);
		border: 1px solid var(--border-hairline);
		border-radius: var(--r-lg);
	}

	.empty p {
		max-width: 40ch;
		margin: 0;
	}
</style>
