<script lang="ts">
	import HeroTitle from '$lib/components/HeroTitle.svelte';
	import Cover from '$lib/components/Cover.svelte';
	import FeaturedRelease from '$lib/components/FeaturedRelease.svelte';
	import FavouriteButton from '$lib/components/FavouriteButton.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import MediaCard from '$lib/components/MediaCard.svelte';
	import MediaGrid from '$lib/components/MediaGrid.svelte';
	import MediaShelf from '$lib/components/MediaShelf.svelte';
	import SectionHeader from '$lib/components/SectionHeader.svelte';
	import TrackList from '$lib/components/TrackList.svelte';
	import { playContainer } from '$lib/client/actions';
	import { heroSweep } from '$lib/client/motion';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	// The heading sweeps in from the left after a navigation; see `heroSweep`.
	const sweep = heroSweep();

	const artist = $derived(data.artist);
	let bioExpanded = $state(false);

	/** Albums newest first, with undated releases last rather than treated as year 0. */
	const albums = $derived(
		[...artist.albums].sort((a, b) => (b.year ?? -Infinity) - (a.year ?? -Infinity))
	);

	/** The years the releases span, where any are dated: "1998 to 2024". */
	const span = $derived.by(() => {
		const years = albums.map((album) => album.year).filter((year): year is number => !!year);
		if (years.length === 0) return null;
		const first = Math.min(...years);
		const last = Math.max(...years);
		return first === last ? String(first) : `${first} to ${last}`;
	});

	/*
	 * The newest release leads beside the most played tracks. Only when there
	 * are both, and more than one release: an artist with one record would
	 * show it twice in a row.
	 */
	const latest = $derived(albums.length > 1 && artist.topSongs.length > 0 ? albums[0] : null);
	const popular = $derived(artist.topSongs.slice(0, 5));
</script>

<svelte:head>
	<title>{artist.name} · Heddohon</title>
</svelte:head>

<div class="page">
	<header class="hero">
		<div class="portrait">
			<Cover coverArt={artist.coverArt} size={384} alt="Photo of {artist.name}" rounded />
		</div>
		<div class="details" {@attach sweep}>
			<span class="hh-eyebrow">Artist</span>
			<HeroTitle text={artist.name} max={3.25} />
			<p class="meta hh-numeric hh-muted">
				{albums.length} release{albums.length === 1 ? '' : 's'}{#if span}<span class="dot" aria-hidden="true">·</span>{span}{/if}
			</p>
			{#if artist.biography}
				<div class="bio">
					<p class:clamped={!bioExpanded}>{artist.biography}</p>
					{#if artist.biography.length > 200}
						<button class="more" onclick={() => (bioExpanded = !bioExpanded)}>
							{bioExpanded ? 'Show less' : 'Read more'}
						</button>
					{/if}
				</div>
			{/if}
			<div class="actions">
				<button class="hh-button hh-button--primary" onclick={() => playContainer('artist', artist.id)}>
					<Icon name="play" size={16} />
					Play all
				</button>
				<FavouriteButton id={artist.id} kind="artist" starred={artist.starred} size={20} />
			</div>
		</div>
	</header>

	{#if popular.length > 0}
		<div class="spread" class:paired={latest}>
			{#if latest}
				<FeaturedRelease
					album={latest}
					eyebrow="Latest release"
					onplay={() => playContainer('album', latest.id)}
				/>
			{/if}
			<section class="popular">
				<SectionHeader title="Popular" eyebrow="Most played" index={1} />
				<TrackList songs={popular} variant="artwork" showAlbum={!latest} showQuality={false} />
			</section>
		</div>
	{/if}

	{#if albums.length > 0}
		<section>
			<SectionHeader title="Releases" index={popular.length > 0 ? 2 : 1} />
			<MediaGrid density={data.settings.gridSize}>
				{#each albums as album (album.id)}
					<MediaCard
						href="/albums/{album.id}"
						title={album.name}
						subtitle={album.year ? String(album.year) : null}
						coverArt={album.coverArt}
						transitionId={album.id}
						onplay={() => playContainer('album', album.id)}
					/>
				{/each}
			</MediaGrid>
		</section>
	{/if}

	<!-- Awaited here rather than in the loader; see the album page. -->
	{#await data.similar then similar}
		{#if similar.length > 0}
			<!-- Compact: a suggestion is secondary to the page it sits under. -->
			<MediaShelf
				title="You might like"
				eyebrow="Related artists"
				index={(popular.length > 0 ? 1 : 0) + (albums.length > 0 ? 1 : 0) + 1}
				density="compact"
			>
				{#each similar as suggestion (suggestion.id)}
					<MediaCard
						href="/artists/{suggestion.id}"
						title={suggestion.name}
						subtitle={suggestion.albumCount ? `${suggestion.albumCount} album${suggestion.albumCount === 1 ? '' : 's'}` : null}
						coverArt={suggestion.coverArt}
						rounded
						onplay={() => playContainer('artist', suggestion.id)}
					/>
				{/each}
			</MediaShelf>
		{/if}
	{/await}
</div>

<style>
	.page {
		/* The spread decides between side by side and stacked on this width. */
		container-type: inline-size;
		display: grid;
		gap: var(--space-6);
		max-width: 88rem;
	}

	.hero {
		display: grid;
		grid-template-columns: 11rem minmax(0, 1fr);
		gap: var(--space-5);
		align-items: center;
	}

	.details {
		/* The hero title sizes itself against this column — see HeroTitle. */
		container-type: inline-size;
		display: grid;
		gap: var(--space-2);
		justify-items: start;
	}

	.meta {
		margin: 0;
		font-size: 0.8125rem;
	}

	.actions {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		margin-top: var(--space-2);
	}

	.actions .hh-button {
		padding: 0.55rem 1.05rem;
		border-radius: var(--r-md);
	}

	.dot {
		margin: 0 0.4rem;
	}

	/* In the header, under the name, rather than in a panel of its own. */
	.bio {
		margin-top: var(--space-1);
	}

	.bio p {
		margin: 0;
		font-size: 0.875rem;
		line-height: 1.5;
		color: var(--text-muted);
		max-width: 62ch;
	}

	.bio p.clamped {
		display: -webkit-box;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}

	.more {
		margin-top: var(--space-2);
		font-size: 0.8125rem;
		font-weight: 600;
		color: var(--accent);
	}

	.more:hover {
		text-decoration: underline;
		text-underline-offset: 3px;
	}

	.spread {
		display: grid;
		gap: var(--space-5);
	}

	/* The release beside the tracks once each has about 28rem. */
	.spread.paired {
		grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
		align-items: start;
	}

	@container (max-width: 58rem) {
		.spread.paired {
			grid-template-columns: minmax(0, 1fr);
		}
	}

	.popular {
		min-width: 0;
	}

	@media (max-width: 46rem) {
		.hero {
			grid-template-columns: minmax(0, 1fr);
			justify-items: start;
		}

		.portrait {
			width: 8rem;
		}
	}
</style>
