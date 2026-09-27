<script lang="ts">
	import { goto } from '$app/navigation';
	import { untrack } from 'svelte';
	import Icon from '$lib/components/Icon.svelte';
	import MediaCard from '$lib/components/MediaCard.svelte';
	import MediaGrid from '$lib/components/MediaGrid.svelte';
	import SectionHeader from '$lib/components/SectionHeader.svelte';
	import TrackList from '$lib/components/TrackList.svelte';
	import { playContainer } from '$lib/client/actions';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	let value = $state(untrack(() => data.query));
	let input = $state<HTMLInputElement | null>(null);
	let timer: ReturnType<typeof setTimeout> | null = null;

	// Back/forward navigation changes the query without touching the field.
	$effect(() => {
		value = data.query;
	});

	$effect(() => {
		input?.focus();
	});

	/**
	 * Debounced so typing does not fire a request per character, and pushed
	 * through the URL so back/forward move between searches.
	 */
	function onInput() {
		if (timer) clearTimeout(timer);
		const next = value;
		timer = setTimeout(() => {
			const target = next.trim() ? `/search?q=${encodeURIComponent(next.trim())}` : '/search';
			void goto(target, { keepFocus: true, replaceState: true, noScroll: true });
		}, 280);
	}

	const { songs, albums, artists } = $derived(data.results);
	const nothing = $derived(
		data.searched && songs.length === 0 && albums.length === 0 && artists.length === 0
	);
</script>

<svelte:head>
	<title>{data.query ? `${data.query} · Search` : 'Search'} · Heddohon</title>
</svelte:head>

<div class="page">
	<div class="searchbox">
		<Icon name="search" size={19} />
		<input
			bind:this={input}
			bind:value
			oninput={onInput}
			type="search"
			placeholder="Search albums, artists and tracks"
			aria-label="Search your library"
			autocomplete="off"
			spellcheck="false"
		/>
	</div>

	{#if !data.searched}
		<p class="hint hh-muted">Type at least two characters to search your library.</p>
		<!-- Somewhere to go before anything is typed. Streamed; see the loader. -->
		{#await data.genres then genres}
			{#if genres.length > 0}
				<section>
					<SectionHeader title="Browse by genre" href="/genres" index={1} />
					<div class="genres hh-stagger">
						{#each genres as genre (genre.id)}
							<a class="genre hh-glass" href="/genres/{encodeURIComponent(genre.id)}">
								<span class="genre-name">{genre.name}</span>
								<span class="genre-count hh-numeric hh-muted">
									{genre.albumCount} {genre.albumCount === 1 ? 'album' : 'albums'}
								</span>
							</a>
						{/each}
					</div>
				</section>
			{/if}
		{/await}
	{:else if nothing}
		<p class="hint hh-muted">Nothing matched “{data.query}”.</p>
	{:else}
		{#if artists.length > 0}
			<section>
				<SectionHeader title="Artists" index={1} />
				<MediaGrid density="compact">
					{#each artists as artist (artist.id)}
						<MediaCard
							href="/artists/{artist.id}"
							title={artist.name}
							subtitle={artist.albumCount ? `${artist.albumCount} albums` : null}
							coverArt={artist.coverArt}
							rounded
						/>
					{/each}
				</MediaGrid>
			</section>
		{/if}

		{#if albums.length > 0}
			<section>
				<SectionHeader title="Albums" index={2} />
				<MediaGrid density={data.settings.gridSize}>
					{#each albums as album (album.id)}
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
			</section>
		{/if}

		{#if songs.length > 0}
			<section>
				<SectionHeader title="Tracks" index={3} />
				<TrackList {songs} variant="artwork" showAlbum />
			</section>
		{/if}
	{/if}
</div>

<style>
	.page {
		display: grid;
		gap: var(--space-6);
		max-width: var(--grid-max);
	}

	.searchbox {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		padding: 0.75rem 1.1rem;
		background: var(--field-face);
		-webkit-backdrop-filter: var(--field-blur);
		backdrop-filter: var(--field-blur);
		border: 1px solid var(--field-edge);
		/* The search field gets the largest radius in the app — it is the one
		   control the eye should land on first when the page opens. */
		border-radius: var(--r-xl);
		color: var(--text-faint);
		transition: border-color var(--transition);
		max-width: 44rem;
	}

	.searchbox:focus-within {
		border-color: var(--accent);
		color: var(--accent);
	}

	.searchbox input {
		flex: 1;
		min-width: 0;
		background: none;
		border: none;
		outline: none;
		color: var(--text-strong);
		font-size: 1.0625rem;
	}

	.searchbox input::placeholder {
		color: var(--text-faint);
	}

	/* Chrome draws its own clear button; it clashes with the field's chrome. */
	.searchbox input::-webkit-search-cancel-button {
		appearance: none;
	}

	/*
	 * The genres before a search, two across on a phone and as many as fit wider. Glass
	 * like the Library page's doors, with the name set large, as the genres
	 * page sets its largest.
	 */
	.genres {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(min(100%, 10rem), 1fr));
		gap: var(--space-2);
	}

	.genre {
		display: grid;
		align-content: space-between;
		gap: var(--space-3);
		min-height: 5.5rem;
		padding: var(--space-3) var(--space-4);
		border-radius: var(--r-lg);
		transition: scale var(--dur-press) var(--ease-out);
	}

	.genre:active {
		scale: 0.97;
	}

	.genre-name {
		font-family: var(--font-display);
		font-size: 1.125rem;
		font-weight: 750;
		letter-spacing: -0.015em;
		line-height: 1.15;
		color: var(--text-strong);
		text-shadow: var(--text-shade);
		overflow-wrap: anywhere;
	}

	.genre:hover .genre-name {
		color: var(--glow-color);
		text-shadow: var(--glow-text);
	}

	.genre-count {
		font-size: 0.75rem;
	}

	.hint {
		padding: var(--space-6) 0;
	}

</style>
