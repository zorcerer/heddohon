<script lang="ts">
	import { page as pageState } from '$app/state';
	import Icon from '#lib/components/Icon.svelte';
	import MediaCard from '#lib/components/MediaCard.svelte';
	import MediaGrid from '#lib/components/MediaGrid.svelte';
	import Pager from '#lib/components/Pager.svelte';
	import SectionHeader from '#lib/components/SectionHeader.svelte';
	import SortChips from '#lib/components/SortChips.svelte';
	import Segment from '#lib/components/Segment.svelte';
	import TrackList from '#lib/components/TrackList.svelte';
	import { playContainer } from '#lib/client/actions.ts';
	import { player } from '#lib/client/player.svelte.ts';
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
		mostAlbums: 'Most albums',
		random: 'Random'
	};

	function tabHref(tab: (typeof data.tabs)[number]): string {
		const params = new URLSearchParams();
		params.set('tab', tab);
		// A tab change starts at page one, without the sort: each tab has its own
		// orders, and the page number is a place in a different list.
		return `/favourites?${params}`;
	}

	function sortHref(sort: Sort): string {
		const params = new URLSearchParams(pageState.url.search);
		params.set('tab', data.tab);
		params.set('sort', sort);
		if (sort === 'random') params.set('seed', String(data.reshuffleSeed));
		else params.delete('seed');
		// A new ordering starts at the top, as on the albums page.
		params.delete('page');
		return `/favourites?${params}`;
	}

	function pageHref(target: number): string {
		const params = new URLSearchParams(pageState.url.search);
		params.set('tab', data.tab);
		params.set('page', String(target));
		params.set('sort', data.sort);
		// The shuffle's seed, so the next page continues the same order.
		if (data.seed !== null) params.set('seed', String(data.seed));
		return `/favourites?${params}`;
	}

	/** "Play tracks" queues the page shown, not the whole favourites list, which can be several thousand tracks. */
	const pageSongs = $derived(data.songs?.items ?? []);
</script>

<svelte:head>
	<title>Favourites · Heddohon</title>
</svelte:head>

<div class="page">
	<SectionHeader title="Favourites">
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
		</div>
	{:else}
		<div class="bar">
			<Segment
				items={data.tabs
					.filter((tab) => data.counts[tab] > 0)
					.map((tab) => ({ value: tab, label: `${LABELS[tab]} ${data.counts[tab].toLocaleString()}`, href: tabHref(tab) }))}
				value={data.tab}
				label="Favourite type"
			/>
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
						album={album}
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
</style>
