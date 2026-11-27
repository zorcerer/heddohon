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
	import Busy from '#lib/components/Busy.svelte';
	import { playContainer } from '#lib/client/actions.ts';
	import { player } from '#lib/client/player.svelte.ts';
	import type { PageData } from './$types';
	import type { FavouritesView } from './+page.server.ts';

	let { data }: { data: PageData } = $props();

	/*
	 * The favourites, or a promise of them on a first read (#344): the
	 * heading is drawn at once and the list when it arrives. Kept once
	 * arrived, for the play button in the heading.
	 */
	let view = $state<FavouritesView | null>(null);
	let failed = $state(false);
	$effect(() => {
		const given = data.view;
		failed = false;
		if (!(given instanceof Promise)) {
			view = given;
			return;
		}
		let current = true;
		given.then(
			(arrived) => {
				if (current) view = arrived;
			},
			() => {
				if (current) failed = true;
			}
		);
		return () => {
			current = false;
		};
	});
	// Server-rendered from what arrived without waiting, so a held list paints in the first byte.
	const shown = $derived(view ?? (data.view instanceof Promise ? null : data.view));

	const LABELS = { songs: 'Tracks', albums: 'Albums', artists: 'Artists' } as const;

	type Sort = FavouritesView['sorts'][number];

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

	function tabHref(tab: FavouritesView['tabs'][number]): string {
		const params = new URLSearchParams();
		params.set('tab', tab);
		// A tab change starts at page one, without the sort: each tab has its own
		// orders, and the page number is a place in a different list.
		return `/favourites?${params}`;
	}

	function sortHref(sort: Sort): string {
		const params = new URLSearchParams(pageState.url.search);
		params.set('tab', shown!.tab);
		params.set('sort', sort);
		if (sort === 'random') params.set('seed', String(shown!.reshuffleSeed));
		else params.delete('seed');
		// A new ordering starts at the top, as on the albums page.
		params.delete('page');
		return `/favourites?${params}`;
	}

	function pageHref(target: number): string {
		const params = new URLSearchParams(pageState.url.search);
		params.set('tab', shown!.tab);
		params.set('page', String(target));
		params.set('sort', shown!.sort);
		// The shuffle's seed, so the next page continues the same order.
		if (shown!.seed !== null) params.set('seed', String(shown!.seed));
		return `/favourites?${params}`;
	}

	/** "Play tracks" queues the page shown, not the whole favourites list, which can be several thousand tracks. */
	const pageSongs = $derived(shown?.songs?.items ?? []);
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

	{#if !shown}
		<div class="waiting" role="status" aria-label={failed ? 'The music server did not answer' : 'Loading favourites'}>
			{#if failed}
				<p class="hh-muted">The music server did not answer.</p>
			{:else}
				<Busy cell={6} />
			{/if}
		</div>
	{:else if shown.counts.songs + shown.counts.albums + shown.counts.artists === 0}
		<div class="empty">
			<Icon name="heart" size={28} />
			<h2>No favourites yet</h2>
		</div>
	{:else}
		<div class="bar">
			<Segment
				items={shown.tabs
					.filter((tab) => shown.counts[tab] > 0)
					.map((tab) => ({ value: tab, label: `${LABELS[tab]} ${shown.counts[tab].toLocaleString()}`, href: tabHref(tab) }))}
				value={shown.tab}
				label="Favourite type"
			/>
			{#if shown.counts[shown.tab] > 1}
				<SortChips
					sorts={shown.sorts}
					active={shown.sort}
					labels={SORT_LABELS}
					href={sortHref}
					label="Sort favourites"
				/>
			{/if}
		</div>

		{#if shown.songs}
			<TrackList songs={shown.songs.items} variant="artwork" showAlbum />
			<Pager {...shown.songs} href={pageHref} label="Favourite track pages" noun="tracks" />
		{:else if shown.albums}
			<MediaGrid density={data.settings.gridSize}>
				{#each shown.albums.items as album (album.id)}
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
			<Pager {...shown.albums} href={pageHref} label="Favourite album pages" noun="albums" />
		{:else if shown.artists}
			<MediaGrid density="compact">
				{#each shown.artists.items as artist (artist.id)}
					<MediaCard
						href="/artists/{artist.id}"
						title={artist.name}
						subtitle={artist.albumCount ? `${artist.albumCount} albums` : null}
						coverArt={artist.coverArt}
						portrait
					/>
				{/each}
			</MediaGrid>
			<Pager {...shown.artists} href={pageHref} label="Favourite artist pages" noun="artists" />
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

	.waiting {
		display: grid;
		place-items: center;
		min-height: 12rem;
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
</style>
