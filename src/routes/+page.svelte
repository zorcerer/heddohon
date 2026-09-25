<script lang="ts">
	import { player } from '$lib/client/player.svelte';
	import AlbumTile from '$lib/components/AlbumTile.svelte';
	import FeaturedRelease from '$lib/components/FeaturedRelease.svelte';
	import MediaCard from '$lib/components/MediaCard.svelte';
	import MediaShelf from '$lib/components/MediaShelf.svelte';
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

	// The newest release is promoted out of the shelf and given the lead.
	const featured = $derived(data.recentlyAdded[0] ?? null);
	const restOfRecent = $derived(data.recentlyAdded.slice(1));

	// Beside the lead, as a column of places to go back to; see the loader.
	const resume = $derived(data.recentlyPlayed.slice(0, 6));

	const shelves = $derived(
		[
			{ title: 'Recently added', albums: restOfRecent, href: '/albums?sort=recentlyAdded' },
			{ title: 'On repeat', albums: data.mostPlayed, href: '/albums?sort=mostPlayed' }
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

	<!--
		The front page: the newest release as the lead, and what was played last
		in a column beside it, the way a paper sets its briefs beside the main
		story. Stacked where the two would not fit side by side.
	-->
	{#if featured || resume.length > 0}
		<div class="lead" class:paired={featured && resume.length > 0}>
			{#if featured}
				<FeaturedRelease album={featured} onplay={() => playContainer('album', featured.id)} />
			{/if}

			{#if resume.length > 0}
				<section class="resume" aria-labelledby="resume-title">
					<a class="resume-head" href="/albums?sort=recentlyPlayed">
						<h2 id="resume-title" class="hh-eyebrow">Jump back in</h2>
						<Icon name="chevron-right" size={14} />
					</a>
					<div class="tiles hh-stagger">
						{#each resume as album (album.id)}
							<AlbumTile {album} />
						{/each}
					</div>
				</section>
			{/if}
		</div>
	{/if}

	{#each shelves as shelf, index (shelf.title)}
		<MediaShelf title={shelf.title} href={shelf.href} index={index + 1}>
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
		</MediaShelf>
	{/each}

	<!-- Streamed: the page does not wait for the favourites. See the loader. -->
	{#await data.favouriteSongs then favouriteSongs}
		{#if favouriteSongs.length > 0}
			<section>
				<SectionHeader title="Favourites" href="/favourites" index={shelves.length + 1} />
				<TrackList songs={favouriteSongs} variant="artwork" showAlbum showQuality={false} columns />
			</section>
		{/if}

		{#if data.discover.length > 0}
			<section>
				<SectionHeader
					title="Something different"
					eyebrow="Picked at random"
					index={shelves.length + (favouriteSongs.length > 0 ? 2 : 1)}
				/>
				<TrackList songs={data.discover} variant="artwork" showAlbum showQuality={false} columns />
			</section>
		{/if}

		{#if !featured && favouriteSongs.length === 0}
			<div class="empty">
				<h2>Nothing to show yet</h2>
				<p class="hh-muted">
					Heddohon could not read any albums from your music server. Check that the library has
					finished scanning, then reload.
				</p>
			</div>
		{/if}
	{/await}
</div>

<style>
	.page {
		/* The lead decides between side by side and stacked on this width. */
		container-type: inline-size;
		display: grid;
		gap: var(--space-6);
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

	.lead {
		display: grid;
		gap: var(--space-5);
	}

	/*
	 * 19rem holds a 48px cover and about 25 characters of title. Six tiles are
	 * 336px, about the height of the featured release beside them at 1440px.
	 */
	.lead.paired {
		grid-template-columns: minmax(0, 1fr) 19rem;
		align-items: stretch;
	}

	.resume {
		display: grid;
		align-content: start;
		gap: var(--space-2);
		min-width: 0;
	}

	.resume-head {
		display: flex;
		align-items: center;
		gap: var(--space-1);
		padding: 0 var(--space-1) var(--space-2);
		border-bottom: 1px solid var(--border-hairline);
		color: var(--text-faint);
		text-decoration: none;
	}

	.resume-head h2 {
		margin: 0;
	}

	.resume-head :global(svg) {
		transition:
			translate var(--transition),
			color var(--transition);
	}

	.resume-head:hover :global(svg) {
		translate: 3px 0;
		color: var(--accent);
	}

	.tiles {
		display: grid;
		gap: 2px;
	}

	/* Too narrow for the pair: the lead across the page, and the column under
	   it as a grid of tiles, two to a row on a phone and more as it widens. */
	@container (max-width: 52rem) {
		.lead.paired {
			grid-template-columns: minmax(0, 1fr);
		}

		.tiles {
			grid-template-columns: repeat(auto-fill, minmax(min(10.5rem, 45%), 1fr));
			column-gap: var(--space-2);
		}
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
