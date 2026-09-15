<script lang="ts">
	import HeroTitle from '$lib/components/HeroTitle.svelte';
	import Cover from '$lib/components/Cover.svelte';
	import FavouriteButton from '$lib/components/FavouriteButton.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import MediaCard from '$lib/components/MediaCard.svelte';
	import MediaGrid from '$lib/components/MediaGrid.svelte';
	import SectionHeader from '$lib/components/SectionHeader.svelte';
	import TrackList from '$lib/components/TrackList.svelte';
	import { playContainer } from '$lib/client/actions';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const artist = $derived(data.artist);
	let bioExpanded = $state(false);

	/** Albums newest first, with undated releases last rather than treated as year 0. */
	const albums = $derived(
		[...artist.albums].sort((a, b) => (b.year ?? -Infinity) - (a.year ?? -Infinity))
	);
</script>

<svelte:head>
	<title>{artist.name} · Heddohon</title>
</svelte:head>

<div class="page">
	<header class="hero">
		<div class="portrait">
			<Cover coverArt={artist.coverArt} size={384} alt="Photo of {artist.name}" rounded />
		</div>
		<div class="details">
			<span class="hh-eyebrow">Artist</span>
			<HeroTitle text={artist.name} max={3.25} />
			<p class="meta hh-numeric hh-muted">
				{albums.length} release{albums.length === 1 ? '' : 's'}
			</p>
			<div class="actions">
				<button class="hh-button hh-button--primary" onclick={() => playContainer('artist', artist.id)}>
					<Icon name="play" size={16} />
					Play all
				</button>
				<FavouriteButton id={artist.id} kind="artist" starred={artist.starred} size={20} />
			</div>
		</div>
	</header>

	{#if artist.biography}
		<section class="bio hh-card hh-glass">
			<p class:clamped={!bioExpanded}>{artist.biography}</p>
			{#if artist.biography.length > 280}
				<button class="more" onclick={() => (bioExpanded = !bioExpanded)}>
					{bioExpanded ? 'Show less' : 'Read more'}
				</button>
			{/if}
		</section>
	{/if}

	{#if artist.topSongs.length > 0}
		<section>
			<SectionHeader title="Popular" eyebrow="Most played" index={1} />
			<TrackList songs={artist.topSongs} variant="artwork" showAlbum />
		</section>
	{/if}

	{#if albums.length > 0}
		<section>
			<SectionHeader title="Releases" index={2} />
			<MediaGrid density="comfortable">
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
			<section>
				<SectionHeader title="You might like" eyebrow="Related artists" index={3} />
				<!-- Compact: a suggestion is secondary to the page it sits under, and at
				     this size the whole shelf fits without dominating the scroll. -->
				<MediaGrid density="compact">
					{#each similar as suggestion (suggestion.id)}
						<MediaCard
							href="/artists/{suggestion.id}"
							title={suggestion.name}
							subtitle={suggestion.albumCount ? `${suggestion.albumCount} albums` : null}
							coverArt={suggestion.coverArt}
							rounded
							onplay={() => playContainer('artist', suggestion.id)}
						/>
					{/each}
				</MediaGrid>
			</section>
		{/if}
	{/await}
</div>

<style>
	.page {
		display: grid;
		gap: var(--space-6);
		max-width: 88rem;
	}

	.hero {
		display: grid;
		grid-template-columns: 10rem minmax(0, 1fr);
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

	.bio {
		padding: var(--space-4) var(--space-5);
	}

	.bio p {
		margin: 0;
		font-size: 0.9375rem;
		color: var(--text-muted);
		max-width: 62ch;
	}

	.bio p.clamped {
		display: -webkit-box;
		-webkit-line-clamp: 3;
		line-clamp: 3;
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
