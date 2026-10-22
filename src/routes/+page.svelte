<script lang="ts">
	import { onMount } from 'svelte';
	import { player } from '$lib/client/player.svelte';
	import AlbumTile from '$lib/components/AlbumTile.svelte';
	import FeaturedRelease from '$lib/components/FeaturedRelease.svelte';
	import MediaCard from '$lib/components/MediaCard.svelte';
	import MediaShelf from '$lib/components/MediaShelf.svelte';
	import OnThisDayShelf from '$lib/components/OnThisDayShelf.svelte';
	import RediscoverShelf from '$lib/components/RediscoverShelf.svelte';
	import NewReleasesShelf from '$lib/components/NewReleasesShelf.svelte';
	import FeatureNotice from '$lib/components/FeatureNotice.svelte';
	import SectionHeader from '$lib/components/SectionHeader.svelte';
	import TrackList from '$lib/components/TrackList.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import Avatar from '$lib/components/Avatar.svelte';
	import { avatarUrl } from '$lib/client/listeners.svelte';
	import { playContainer } from '$lib/client/actions';
	import type { RememberedAlbum } from '$lib/server/history';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

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

	/*
	 * Albums played on this date in earlier years. The date is this browser's,
	 * in its time zone, which the server does not know, so the shelf is asked
	 * for once the page is in the browser. The first paint does not need it.
	 */
	let onThisDay = $state<{ today: Date; albums: RememberedAlbum[] } | null>(null);

	onMount(() => {
		const today = new Date();
		const pad = (n: number) => String(n).padStart(2, '0');
		const date = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
		const offset = -today.getTimezoneOffset();
		const controller = new AbortController();
		fetch(`/api/on-this-day?date=${date}&offset=${offset}`, { signal: controller.signal })
			.then((response) => (response.ok ? response.json() : null))
			.then((body: { albums: RememberedAlbum[] } | null) => {
				if (body) onThisDay = { today, albums: body.albums };
			})
			// The shelf is left out when it cannot be read.
			.catch(() => {});
		return () => controller.abort();
	});

	const rediscovering = $derived(data.rediscover.length > 0);
	const remembering = $derived((onThisDay?.albums.length ?? 0) > 0);

	/*
	 * Whether the daily mixes have arrived with any, for the numbers of the
	 * sections after them. Streamed, so Favourites and Something different can
	 * be drawn first and take the next number when the mixes arrive.
	 */
	let mixing = $state(false);
	$effect(() => {
		let current = true;
		mixing = false;
		data.mixes.then((mixes) => {
			if (current) mixing = mixes.length > 0;
		});
		return () => {
			current = false;
		};
	});

	// The same for the new releases, which follow the mixes.
	let releasing = $state(false);
	$effect(() => {
		let current = true;
		releasing = false;
		data.newReleases.then((releases) => {
			if (current) releasing = releases.length > 0;
		});
		return () => {
			current = false;
		};
	});

	// The numbered album shelves, ahead of the daily mixes.
	const albumShelves = $derived(shelves.length + Number(rediscovering) + Number(remembering));
	// Every numbered section above Favourites.
	const aboveFavourites = $derived(albumShelves + Number(mixing) + Number(releasing));
</script>

<svelte:head>
	<title>Home · Heddohon</title>
</svelte:head>

<div class="page">
	<header class="masthead">
		<div class="hello">
			<!-- The account's picture, or its initial, leading to its profile page. -->
			{#if data.me}
				<a class="me" href="/people/{data.me.handle}" aria-label="Your profile" title="Your profile">
					<Avatar name={data.me.name} src={avatarUrl(data.me.handle, data.me.avatar)} size={3.25} />
				</a>
			{/if}
			<h1>Your library</h1>
		</div>
		{#if data.discover.length > 0}
			<button class="hh-button shuffle" onclick={() => player.playShuffled(data.discover)}>
				<Icon name="shuffle" size={16} />
				Shuffle something
			</button>
		{/if}
	</header>

	<!-- Streamed, for an administrator; see features.ts. -->
	{#await data.featureNotice then features}
		{#if features.length > 0}
			<FeatureNotice {features} seen={data.settings?.featuresSeen ?? []} />
		{/if}
	{/await}

	<!--
		The front page: the newest release as the lead, and what was played last
		in a column beside it. Stacked where the two do not fit side by side.
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
					<div class="tiles hh-stagger" data-glide>
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
					album={album}
					onplay={() => playContainer('album', album.id)}
				/>
			{/each}
		</MediaShelf>
	{/each}

	<!-- From the history on this server; see forgottenAlbums and onThisDay. -->
	{#if rediscovering}
		<RediscoverShelf albums={data.rediscover} index={shelves.length + 1} />
	{/if}

	{#if onThisDay && remembering}
		<OnThisDayShelf albums={onThisDay.albums} today={onThisDay.today} index={shelves.length + Number(rediscovering) + 1} />
	{/if}

	<!--
		Streamed, and numbered after the album shelves; the sections below it
		take the next numbers when it arrives. See mixes.ts.
	-->
	{#await data.mixes then mixes}
		{#if mixes.length > 0}
			<MediaShelf title="Made for you" index={albumShelves + 1}>
				{#each mixes as mix (mix.n)}
					<MediaCard
						href="/mixes/{mix.n}"
						title={mix.title}
						subtitle={mix.subtitle}
						coverArt={mix.coverArt}
						onplay={() => playContainer('daily', String(mix.n))}
					/>
				{/each}
			</MediaShelf>
		{/if}
	{/await}

	<!-- Streamed, after the mixes; see newreleases.ts. -->
	{#await data.newReleases then releases}
		{#if releases.length > 0}
			<NewReleasesShelf {releases} index={albumShelves + Number(mixing) + 1} />
		{/if}
	{/await}

	<!-- Streamed: the page does not wait for the favourites. See the loader. -->
	{#await data.favouriteSongs then favouriteSongs}
		{#if favouriteSongs.length > 0}
			<section>
				<SectionHeader title="Favourites" href="/favourites" index={aboveFavourites + 1} />
				<TrackList songs={favouriteSongs} variant="artwork" showAlbum showQuality={false} columns />
			</section>
		{/if}

		{#if data.discover.length > 0}
			<section>
				<SectionHeader
					title="Something different"
					index={aboveFavourites + (favouriteSongs.length > 0 ? 2 : 1)}
				/>
				<TrackList songs={data.discover} variant="artwork" showAlbum showQuality={false} columns />
			</section>
		{/if}

		{#if !featured && favouriteSongs.length === 0}
			<div class="empty">
				<h2>Nothing to show yet</h2>
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
		position: relative;
		display: flex;
		align-items: flex-end;
		justify-content: space-between;
		gap: var(--space-5);
		flex-wrap: wrap;
		padding-bottom: var(--space-4);
		/* The rule under the masthead starts the ruled index the section headers
		   continue. */
		border-bottom: 1px solid var(--border-hairline);
	}

	.masthead h1 {
		margin-top: var(--space-1);
	}

	.hello {
		display: flex;
		align-items: center;
		gap: var(--space-4);
		min-width: 0;
	}

	.me {
		flex: none;
		border-radius: 50%;
		transition: transform var(--dur-press) var(--ease-out);
	}

	.me:hover {
		transform: scale(1.05);
	}

	.me:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 3px;
	}

	@media (prefers-reduced-motion: reduce) {
		.me {
			transition: none;
		}
	}

	@media (max-width: 60rem) {
		/* The title takes the whole row, and Shuffle something goes under it. */
		.masthead > div {
			flex: 1 1 100%;
		}

		.masthead {
			gap: var(--space-3);
		}
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

</style>
