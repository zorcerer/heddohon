<script lang="ts">
	import { player } from '$lib/client/player.svelte';
	import FeaturedRelease from '$lib/components/FeaturedRelease.svelte';
	import MediaCard from '$lib/components/MediaCard.svelte';
	import MediaGrid from '$lib/components/MediaGrid.svelte';
	import SectionHeader from '$lib/components/SectionHeader.svelte';
	import TrackList from '$lib/components/TrackList.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import { playContainer } from '$lib/client/actions';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const greeting = $derived.by(() => {
		const hour = new Date().getHours();
		if (hour < 5) return 'Still up';
		if (hour < 12) return 'Good morning';
		if (hour < 18) return 'Good afternoon';
		return 'Good evening';
	});

	// The newest release is promoted out of the grid and given the whole width.
	const featured = $derived(data.recentlyAdded[0] ?? null);
	const restOfRecent = $derived(data.recentlyAdded.slice(1));

	const shelves = $derived(
		[
			{ title: 'Recently added', albums: restOfRecent, href: '/albums?sort=recentlyAdded' },
			{ title: 'On repeat', albums: data.mostPlayed, href: '/albums?sort=mostPlayed' },
			{ title: 'Picked up again', albums: data.recentlyPlayed, href: '/albums?sort=recentlyPlayed' }
		].filter((shelf) => shelf.albums.length > 0)
	);
</script>

<svelte:head>
	<title>Home · Heddohon</title>
</svelte:head>

<div class="page">
	<header class="masthead">
		<div>
			<span class="hh-eyebrow">{greeting}</span>
			<h1>Your library</h1>
		</div>
		{#if data.discover.length > 0}
			<button class="hh-button shuffle" onclick={() => player.playShuffled(data.discover)}>
				<Icon name="shuffle" size={16} />
				Shuffle something
			</button>
		{/if}
	</header>

	{#if featured}
		<FeaturedRelease
			album={featured}
			onplay={() => playContainer('album', featured.id)}
		/>
	{/if}

	{#each shelves as shelf, index (shelf.title)}
		<section>
			<SectionHeader title={shelf.title} href={shelf.href} index={index + 1} />
			<MediaGrid density={data.settings.gridSize}>
				{#each shelf.albums as album (album.id)}
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
		</section>
	{/each}

	{#if data.favouriteSongs.length > 0}
		<section>
			<SectionHeader title="Favourites" href="/favourites" index={shelves.length + 1} />
			<TrackList songs={data.favouriteSongs} variant="artwork" showAlbum />
		</section>
	{/if}

	{#if !featured && data.favouriteSongs.length === 0}
		<div class="empty">
			<h2>Nothing to show yet</h2>
			<p class="hh-muted">
				Heddohon could not read any albums from your music server. Check that the library has
				finished scanning, then reload.
			</p>
		</div>
	{/if}
</div>

<style>
	.page {
		display: grid;
		gap: var(--space-7);
		max-width: var(--grid-max);
	}

	.masthead {
		display: flex;
		align-items: flex-end;
		justify-content: space-between;
		gap: var(--space-5);
		flex-wrap: wrap;
		padding-bottom: var(--space-4);
		/* The rule under the masthead sets up the ruled-index language that the
		   section headers below continue. */
		border-bottom: 1px solid var(--border-hairline);
	}

	.masthead h1 {
		margin-top: var(--space-1);
	}

	.shuffle {
		padding: 0.55rem 1.05rem;
		border-radius: var(--r-md);
	}

	.empty {
		padding: var(--space-7);
		text-align: center;
		display: grid;
		gap: var(--space-2);
		justify-items: center;
		border: 1px solid var(--border-hairline);
		border-radius: var(--r-lg);
	}

	.empty p {
		max-width: 32rem;
		margin: 0;
	}
</style>
