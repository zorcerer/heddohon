<script lang="ts">
	/**
	 * The host's library, for a guest of a listen-together party while the host
	 * lets the party add: a search, every artist, the albums, and an album's
	 * tracks, each with an Add button. `server/together-guests.ts` has what the
	 * server sends and why.
	 */
	import { formatDuration } from '#lib/client/format.ts';
	import type { GuestAlbum, GuestArtist, GuestSong } from '#lib/server/together-guests.ts';
	import Icon from './Icon.svelte';
	import { RELEASE_GROUPS, releaseKind } from '#lib/releases.ts';

	let { base, onadd }: { base: string; onadd: (song: GuestSong) => void | Promise<void> } = $props();

	type Tab = 'search' | 'artists' | 'albums' | 'genres';
	type View =
		| { kind: 'tab' }
		| { kind: 'genre'; genre: { id: string; name: string } }
		| { kind: 'artist'; artist: { id: string; name: string } }
		| { kind: 'album'; album: { id: string; name: string } };
	type Sort = 'recentlyAdded' | 'alphabetical' | 'byArtist' | 'random';

	let tab = $state<Tab>('search');
	/** Opened albums and artists, the last one shown; Back takes one off. */
	let trail = $state<View[]>([]);
	const view = $derived<View>(trail.at(-1) ?? { kind: 'tab' });

	let loading = $state(false);
	let failed = $state<string | null>(null);

	let query = $state('');
	let searched = $state(false);
	let found = $state<{ songs: GuestSong[]; albums: GuestAlbum[]; artists: GuestArtist[] }>({ songs: [], albums: [], artists: [] });

	let artists = $state<GuestArtist[] | null>(null);
	let artistFilter = $state('');
	const shownArtists = $derived.by(() => {
		const all = artists ?? [];
		const wanted = artistFilter.trim().toLocaleLowerCase();
		return wanted ? all.filter((artist) => artist.name.toLocaleLowerCase().includes(wanted)) : all;
	});
	/** The artist list is cut here; the filter finds the rest. */
	const ARTISTS_SHOWN = 300;

	let albums = $state<GuestAlbum[] | null>(null);
	let albumSort = $state<Sort>('recentlyAdded');
	let moreAlbums = $state(false);

	interface GuestGenre {
		id: string;
		name: string;
		albumCount: number | null;
	}
	let genres = $state<GuestGenre[] | null>(null);
	let genreFilter = $state('');
	const shownGenres = $derived.by(() => {
		const wanted = genreFilter.trim().toLocaleLowerCase();
		const all = genres ?? [];
		return wanted ? all.filter((genre) => genre.name.toLocaleLowerCase().includes(wanted)) : all;
	});
	let genreAlbums = $state<GuestAlbum[]>([]);
	let moreGenreAlbums = $state(false);

	let artistAlbums = $state<GuestAlbum[]>([]);
	/** The artist's releases apart, as the artist page lists them: albums first, then EPs, singles, live, compilations. */
	const artistReleases = $derived(
		RELEASE_GROUPS.map((group) => ({ ...group, albums: artistAlbums.filter((album) => releaseKind(album) === group.kind) })).filter(
			(group) => group.albums.length > 0
		)
	);
	let albumSongs = $state<GuestSong[]>([]);
	let albumInfo = $state<GuestAlbum | null>(null);

	/** Which tracks were just added, for the button's check mark. */
	let added = $state<Record<string, boolean>>({});

	async function ask<T>(params: Record<string, string>): Promise<T | null> {
		loading = true;
		failed = null;
		try {
			const response = await fetch(`${base}/library?${new URLSearchParams(params)}`);
			if (!response.ok) {
				failed = (await response.json().catch(() => null))?.message ?? 'The library did not answer. Try again.';
				return null;
			}
			return (await response.json()) as T;
		} catch {
			failed = 'The library did not answer. Try again.';
			return null;
		} finally {
			loading = false;
		}
	}

	async function search(event: SubmitEvent) {
		event.preventDefault();
		const wanted = query.trim();
		if (wanted.length < 2) return;
		const result = await ask<typeof found>({ view: 'search', q: wanted });
		if (result) {
			found = result;
			searched = true;
		}
	}

	function clearSearch() {
		query = '';
		searched = false;
		found = { songs: [], albums: [], artists: [] };
		failed = null;
	}

	async function showTab(next: Tab) {
		tab = next;
		trail = [];
		failed = null;
		if (next === 'artists' && !artists) {
			const result = await ask<{ artists: GuestArtist[] }>({ view: 'artists' });
			if (result) artists = result.artists;
		}
		if (next === 'albums' && !albums) await loadAlbums(true);
		if (next === 'genres' && !genres) {
			const result = await ask<{ genres: GuestGenre[] }>({ view: 'genres' });
			if (result) genres = result.genres;
		}
	}

	async function openGenre(genre: { id: string; name: string }) {
		const result = await ask<{ albums: GuestAlbum[]; more: boolean }>({ view: 'genre', id: genre.id, offset: '0' });
		if (!result) return;
		genreAlbums = result.albums;
		moreGenreAlbums = result.more;
		trail = [...trail, { kind: 'genre', genre }];
	}

	async function moreOfGenre(genre: { id: string }) {
		const result = await ask<{ albums: GuestAlbum[]; more: boolean }>({ view: 'genre', id: genre.id, offset: String(genreAlbums.length) });
		if (!result) return;
		genreAlbums = [...genreAlbums, ...result.albums];
		moreGenreAlbums = result.more;
	}

	async function loadAlbums(fresh: boolean) {
		const offset = fresh ? 0 : (albums?.length ?? 0);
		const result = await ask<{ albums: GuestAlbum[]; more: boolean }>({ view: 'albums', sort: albumSort, offset: String(offset) });
		if (!result) return;
		albums = fresh ? result.albums : [...(albums ?? []), ...result.albums];
		moreAlbums = result.more;
	}

	/** Opens an artist or an album from outside, for the links on what plays now. */
	export async function show(kind: 'artist' | 'album', target: { id: string | null; name: string | null }) {
		trail = [];
		await (kind === 'artist' ? openArtist(target) : openAlbum(target));
	}

	async function openArtist(artist: { id: string | null; name: string | null }) {
		if (!artist.id) return;
		const result = await ask<{ albums: GuestAlbum[] }>({ view: 'artist', id: artist.id });
		if (!result) return;
		artistAlbums = result.albums;
		trail = [...trail, { kind: 'artist', artist: { id: artist.id, name: artist.name ?? '' } }];
	}

	async function openAlbum(album: { id: string | null; name: string | null }) {
		if (!album.id) return;
		const result = await ask<{ album: GuestAlbum; songs: GuestSong[] }>({ view: 'album', id: album.id });
		if (!result) return;
		albumInfo = result.album;
		albumSongs = result.songs;
		trail = [...trail, { kind: 'album', album: { id: album.id, name: album.name ?? '' } }];
	}

	async function back() {
		const rest = trail.slice(0, -1);
		const previous = rest.at(-1);
		// What the view before showed was replaced by the one opened after it.
		if (previous?.kind === 'artist') {
			const result = await ask<{ albums: GuestAlbum[] }>({ view: 'artist', id: previous.artist.id });
			if (result) artistAlbums = result.albums;
		}
		// A genre's albums are kept as they were: opening an album does not replace them.
		trail = rest;
	}

	async function add(song: GuestSong) {
		await onadd(song);
		added = { ...added, [song.id]: true };
		setTimeout(() => (added = { ...added, [song.id]: false }), 2000);
	}
</script>

{#snippet songRow(song: GuestSong, showAlbum: boolean)}
	<li>
		{#if !showAlbum}
			<span class="num hh-muted hh-numeric">{song.track ?? ''}</span>
		{/if}
		<span class="text">
			<span class="title hh-truncate">{song.title}</span>
			<span class="sub hh-truncate hh-muted">
				{song.artist ?? 'Unknown artist'}{#if showAlbum && song.album}{` · ${song.album}`}{/if} · {formatDuration(song.duration)}
			</span>
		</span>
		<button class="hh-button add" onclick={() => add(song)} aria-label="Add {song.title} to the queue">
			<Icon name={added[song.id] ? 'check' : 'plus'} size={15} />
		</button>
	</li>
{/snippet}

{#snippet albumTable(list: GuestAlbum[], title: string | null = null)}
	<div class="table" role="table" aria-label={title ?? 'Albums'}>
		<div class="arow head hh-eyebrow" role="row">
			<span role="columnheader" class:kind={title !== null}>{title ?? 'Album'}</span>
			<span role="columnheader">Artist</span>
			<span role="columnheader" class="year">Year</span>
		</div>
		{#each list as album (album.id)}
			<button class="arow" role="row" onclick={() => openAlbum(album)}>
				<span class="title hh-truncate" role="cell">{album.name}</span>
				<span class="hh-muted hh-truncate" role="cell">{album.artist ?? 'Unknown artist'}</span>
				<span class="hh-muted hh-numeric year" role="cell">{album.year ?? ''}</span>
			</button>
		{/each}
	</div>
{/snippet}

{#snippet artistRow(artist: GuestArtist)}
	<li>
		<button class="line" onclick={() => openArtist(artist)}>
			<span class="text">
				<span class="title hh-truncate">{artist.name}</span>
				{#if artist.albumCount}<span class="sub hh-muted">{artist.albumCount === 1 ? '1 album' : `${artist.albumCount} albums`}</span>{/if}
			</span>
			<Icon name="chevron-right" size={16} />
		</button>
	</li>
{/snippet}

<section class="library" aria-label="The host's library">
	<div class="tabs" role="tablist" aria-label="Look through the library">
		<button role="tab" aria-selected={tab === 'search' && view.kind === 'tab'} class:on={tab === 'search'} onclick={() => showTab('search')}>
			<Icon name="search" size={15} /> Search
		</button>
		<button role="tab" aria-selected={tab === 'artists' && view.kind === 'tab'} class:on={tab === 'artists'} onclick={() => showTab('artists')}>
			<Icon name="artist" size={15} /> Artists
		</button>
		<button role="tab" aria-selected={tab === 'albums' && view.kind === 'tab'} class:on={tab === 'albums'} onclick={() => showTab('albums')}>
			<Icon name="album" size={15} /> Albums
		</button>
		<button role="tab" aria-selected={tab === 'genres' && view.kind === 'tab'} class:on={tab === 'genres'} onclick={() => showTab('genres')}>
			<Icon name="library" size={15} /> Genres
		</button>
	</div>

	{#if view.kind !== 'tab'}
		<div class="crumb">
			<button class="hh-button back" onclick={back}><Icon name="chevron-left" size={15} /> Back</button>
			<h3 class="hh-truncate">{view.kind === 'artist' ? view.artist.name : view.kind === 'genre' ? view.genre.name : view.album.name}</h3>
		</div>
	{/if}

	{#if failed}<p class="note failed" role="alert">{failed}</p>{/if}

	{#if view.kind === 'album'}
		{#if albumInfo}
			<p class="hh-muted meta">
				{#if albumInfo.artistId}
					<button class="link" onclick={() => openArtist({ id: albumInfo?.artistId ?? null, name: albumInfo?.artist ?? null })}>{albumInfo.artist}</button>
				{:else}{albumInfo.artist ?? 'Unknown artist'}{/if}{albumInfo.year ? ` · ${albumInfo.year}` : ''}
			</p>
		{/if}
		<ul class="rows">
			{#each albumSongs as song (song.id)}{@render songRow(song, false)}{/each}
		</ul>
	{:else if view.kind === 'genre'}
		{#if genreAlbums.length === 0 && !loading}<p class="hh-muted empty">No albums.</p>{/if}
		{@render albumTable(genreAlbums)}
		{#if moreGenreAlbums}
			<button class="hh-button more" disabled={loading} onclick={() => moreOfGenre(view.genre)}>Show more</button>
		{/if}
	{:else if view.kind === 'artist'}
		{#if artistAlbums.length === 0 && !loading}<p class="hh-muted empty">No albums.</p>{/if}
		{#each artistReleases as group (group.kind)}
			{@render albumTable(group.albums, group.title)}
		{/each}
	{:else if tab === 'search'}
		<form class="search" role="search" onsubmit={search}>
			<input class="hh-input" type="search" bind:value={query} maxlength="200" placeholder="Search for a track, an album or an artist" aria-label="Search the library" />
			<button class="hh-button" disabled={loading}>Search</button>
			{#if searched || query}
				<button class="hh-button clear" type="button" onclick={clearSearch} aria-label="Clear the search"><Icon name="close" size={15} /></button>
			{/if}
		</form>
		{#if searched && found.songs.length + found.albums.length + found.artists.length === 0}
			<p class="hh-muted empty">Nothing found.</p>
		{/if}
		{#if found.artists.length > 0}
			<h3 class="hh-eyebrow">Artists</h3>
			<ul class="rows">{#each found.artists.slice(0, 6) as artist (artist.id)}{@render artistRow(artist)}{/each}</ul>
		{/if}
		{#if found.albums.length > 0}
			<h3 class="hh-eyebrow">Albums</h3>
			{@render albumTable(found.albums.slice(0, 12))}
		{/if}
		{#if found.songs.length > 0}
			<h3 class="hh-eyebrow">Tracks</h3>
			<ul class="rows">{#each found.songs as song (song.id)}{@render songRow(song, true)}{/each}</ul>
		{/if}
	{:else if tab === 'artists'}
		<input class="hh-input" type="search" bind:value={artistFilter} maxlength="100" placeholder="Filter artists" aria-label="Filter artists" />
		<ul class="rows">
			{#each shownArtists.slice(0, ARTISTS_SHOWN) as artist (artist.id)}{@render artistRow(artist)}{/each}
		</ul>
		{#if shownArtists.length > ARTISTS_SHOWN}
			<p class="hh-muted empty">and {shownArtists.length - ARTISTS_SHOWN} more: filter to find them.</p>
		{/if}
	{:else if tab === 'genres'}
		<input class="hh-input" type="search" bind:value={genreFilter} maxlength="100" placeholder="Filter genres" aria-label="Filter genres" />
		<ul class="rows">
			{#each shownGenres as genre (genre.id)}
				<li>
					<button class="line" onclick={() => openGenre(genre)}>
						<span class="text">
							<span class="title hh-truncate">{genre.name}</span>
							{#if genre.albumCount}<span class="sub hh-muted">{genre.albumCount === 1 ? '1 album' : `${genre.albumCount} albums`}</span>{/if}
						</span>
						<Icon name="chevron-right" size={16} />
					</button>
				</li>
			{/each}
		</ul>
		{#if genres && genres.length === 0 && !loading}<p class="hh-muted empty">No genres.</p>{/if}
	{:else}
		<label class="sort">
			<span class="hh-muted">Order</span>
			<select class="hh-input" bind:value={albumSort} onchange={() => loadAlbums(true)}>
				<option value="recentlyAdded">Recently added</option>
				<option value="alphabetical">By name</option>
				<option value="byArtist">By artist</option>
				<option value="random">Random</option>
			</select>
		</label>
		{@render albumTable(albums ?? [])}
		{#if moreAlbums}
			<button class="hh-button more" disabled={loading} onclick={() => loadAlbums(false)}>Show more</button>
		{/if}
	{/if}

	{#if loading}<p class="hh-muted empty" role="status">Loading…</p>{/if}
</section>

<style>
	.library {
		display: grid;
		gap: var(--space-3);
		min-width: 0;
	}

	.library h3,
	.library p {
		margin: 0;
	}

	.tabs {
		display: flex;
		flex-wrap: wrap;
		max-width: 100%;
		gap: var(--space-1, 0.25rem);
		padding: 0.25rem;
		border: 1px solid var(--border-hairline);
		border-radius: var(--r-pill);
		background: var(--bg-sunken);
		justify-self: start;
	}

	.tabs button {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		padding: 0.4rem 0.9rem;
		border-radius: var(--r-pill);
		font-size: 0.8125rem;
		color: var(--text-default);
	}

	@media (max-width: 30rem) {
		.tabs button {
			padding: 0.4rem 0.55rem;
		}
	}

	.tabs button.on {
		background: var(--control-face);
		color: var(--text-strong);
		box-shadow: var(--shadow-low, none);
	}

	.crumb {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		min-width: 0;
	}

	.crumb h3 {
		font-size: 1.05rem;
		color: var(--text-strong);
	}

	/*
	 * The buttons keep the theme's own layout: Terminal draws `[` and `]` as
	 * the button's ::before and ::after, which a grid, a fixed width or
	 * padding of the other themes put out of place. Size and shape are set
	 * for the other themes only.
	 */
	.back,
	.add,
	.search .hh-button,
	.more {
		flex: none;
		font-size: 0.8125rem;
	}

	.back {
		align-items: center;
	}

	/* The closing bracket as far from the label as the opening one is from the icon. */
	:global([data-theme='terminal']) .back::after {
		margin-left: 0.15rem;
	}

	:global(:root:not([data-theme='terminal'])) .back {
		gap: 0.2rem;
		padding: 0.35rem 0.7rem;
		border-radius: var(--r-md);
	}

	.meta {
		font-size: 0.875rem;
	}

	.link {
		color: var(--text-strong);
		text-decoration: underline;
		text-underline-offset: 2px;
	}

	.search {
		display: flex;
		gap: var(--space-2);
	}

	.search .hh-input {
		flex: 1;
		min-width: 0;
	}

	:global(:root:not([data-theme='terminal'])) .search .hh-button:not(.clear),
	:global(:root:not([data-theme='terminal'])) .more {
		padding: 0.4rem 0.8rem;
		border-radius: var(--r-md);
	}

	.clear {
		flex: none;
		align-items: center;
	}

	:global(:root:not([data-theme='terminal'])) .clear {
		padding: 0.4rem 0.55rem;
		border-radius: var(--r-md);
	}

	.more {
		justify-self: start;
	}

	.sort {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		font-size: 0.8125rem;
	}

	.sort select {
		width: auto;
	}

	.rows {
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.rows {
		display: grid;
		gap: var(--space-2);
	}

	.rows li {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		min-width: 0;
	}

	.line {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		width: 100%;
		min-width: 0;
		padding: 0.15rem 0;
		text-align: left;
		color: var(--text-faint);
	}

	.text {
		display: grid;
		flex: 1;
		min-width: 0;
		text-align: left;
	}

	.title {
		color: var(--text-strong);
		font-size: 0.9375rem;
	}

	.sub,
	.note,
	.empty {
		font-size: 0.8125rem;
	}

	.note.failed {
		color: var(--danger);
	}

	.num {
		flex: none;
		width: 1.6rem;
		text-align: right;
		font-size: 0.8125rem;
	}

	.add {
		align-items: center;
		justify-content: center;
		white-space: nowrap;
	}

	:global(:root:not([data-theme='terminal'])) .add {
		min-width: 2.1rem;
		min-height: 2.1rem;
		padding: 0;
		border-radius: 50%;
	}

	/* Albums as a table: name, artist, year. No covers anywhere in the library. */
	.table {
		display: grid;
		min-width: 0;
	}

	.arow {
		display: grid;
		grid-template-columns: minmax(0, 3fr) minmax(0, 2fr) 4.5ch;
		gap: var(--space-3);
		align-items: baseline;
		width: 100%;
		min-width: 0;
		padding: 0.4rem 0;
		border-bottom: 1px solid var(--border-hairline);
		text-align: left;
		font-size: 0.875rem;
	}

	.arow.head {
		padding-top: 0;
		font-size: 0.75rem;
		color: var(--text-muted);
	}

	/* A release kind names its table in the first column's heading, in bold. */
	.arow.head .kind {
		font-weight: 700;
	}

	/* Tables one after the other keep half a line and more between them. */
	.table + .table {
		margin-top: var(--space-4);
	}

	.arow .year {
		text-align: right;
	}

	button.arow:hover .title,
	button.arow:focus-visible .title {
		color: var(--glow-color);
	}

</style>
