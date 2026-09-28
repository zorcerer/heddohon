<script lang="ts">
	import Cover from '$lib/components/Cover.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import Pager from '$lib/components/Pager.svelte';
	import TrackList from '$lib/components/TrackList.svelte';
	import { fetchTracks } from '$lib/client/actions';
	import { player } from '$lib/client/player.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const folder = $derived(data.folder);
	const href = (id: string) => `/folders/${encodeURIComponent(id)}`;
	const base = $derived(folder.id === null ? '/folders' : href(folder.id));

	const plural = (count: number, noun: string) => `${count.toLocaleString()} ${noun}${count === 1 ? '' : 's'}`;
	const meta = $derived(
		[
			data.folderCount > 0 ? plural(data.folderCount, 'folder') : null,
			data.songCount > 0 ? plural(data.songCount, 'track') : null
		].filter(Boolean)
	);

	/**
	 * Every track in the folder, not only the page's. At the top there is no
	 * id to ask by, and there the page's tracks are all of them unless the top
	 * holds more than a page.
	 */
	async function tracks() {
		return folder.id === null ? data.songs : fetchTracks('folder', folder.id);
	}

	async function play(shuffled: boolean) {
		const songs = await tracks();
		if (songs.length === 0) return;
		if (shuffled) await player.playShuffled(songs);
		else await player.playNow(songs);
	}

	async function queue() {
		const songs = await tracks();
		if (songs.length > 0) player.addToQueue(songs);
	}
</script>

<svelte:head>
	<title>{folder.id === null ? 'Folders' : `${folder.name} · Folders`} · Heddohon</title>
</svelte:head>

<div class="page">
	<header>
		<div class="heading">
			{#if folder.id === null}
				<span class="hh-eyebrow">Library</span>
			{:else}
				<!-- The way back up, a level to a link, as a path is written. -->
				<nav class="trail hh-eyebrow" aria-label="Folders above this one">
					<a href="/folders">Folders</a>
					{#each folder.parents as parent (parent.id)}
						<span class="sep" aria-hidden="true">/</span>
						<a href={href(parent.id)}>{parent.name}</a>
					{/each}
				</nav>
			{/if}
			<h1 class="hh-display hh-clamp-2">{folder.id === null ? 'Folders' : folder.name}</h1>
			{#if meta.length > 0}
				<p class="meta hh-numeric hh-muted">{meta.join(' · ')}</p>
			{/if}
		</div>

		{#if data.songCount > 0}
			<div class="actions">
				<button class="hh-button hh-button--primary" onclick={() => play(false)} aria-label="Play the tracks in this folder" title="Play">
					<Icon name="play" size={16} />
					<span class="label">Play</span>
				</button>
				<button class="hh-button" onclick={() => play(true)} aria-label="Shuffle the tracks in this folder" title="Shuffle">
					<Icon name="shuffle" size={16} />
					<span class="label">Shuffle</span>
				</button>
				<button class="hh-button" onclick={queue} aria-label="Add the tracks in this folder to the queue" title="Add to queue">
					<Icon name="queue" size={16} />
					<span class="label">Queue</span>
				</button>
			</div>
		{/if}
	</header>

	{#if data.folders.length > 0}
		<ul class="folders hh-stagger" aria-label="Folders">
			{#each data.folders as entry (entry.id)}
				<li>
					<a class="folder" href={href(entry.id)}>
						<span class="glyph">
							{#if entry.coverArt}
								<Cover coverArt={entry.coverArt} size={96} alt="" radius="var(--r-sm)" fill />
							{:else}
								<Icon name="folder" size={20} />
							{/if}
						</span>
						<span class="name hh-truncate">{entry.name}</span>
						<Icon name="chevron-right" size={16} />
					</a>
				</li>
			{/each}
		</ul>
	{/if}

	{#if data.songs.length > 0}
		<section class="tracks" aria-label="Tracks">
			<TrackList songs={data.songs} variant="numbered" showAlbum />
		</section>
	{/if}

	{#if data.page.total === 0}
		<p class="empty hh-muted">
			{folder.id === null ? 'The music server lists no folders.' : 'This folder is empty.'}
		</p>
	{/if}

	<Pager
		page={data.page.page}
		pageCount={data.page.pageCount}
		total={data.page.total}
		hasPrevious={data.page.hasPrevious}
		hasNext={data.page.hasNext}
		href={(target) => `${base}?page=${target}`}
		label="Folder pages"
		noun="entries"
	/>
</div>

<style>
	.page {
		display: grid;
		gap: var(--space-5);
		max-width: var(--grid-max);
	}

	header {
		display: flex;
		align-items: flex-end;
		justify-content: space-between;
		gap: var(--space-5);
		flex-wrap: wrap;
		padding-bottom: var(--space-4);
		border-bottom: 1px solid var(--border-hairline);
	}

	.heading {
		display: grid;
		gap: 0.2rem;
		min-width: 0;
	}

	h1 {
		margin: 0.2rem 0 0;
		font-size: clamp(2.25rem, 1.4rem + 2.6vw, 3.5rem);
		overflow-wrap: anywhere;
	}

	.trail {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 0.1rem 0.4rem;
	}

	.trail a {
		text-decoration: none;
	}

	.trail a:hover {
		color: var(--glow-color);
	}

	.sep {
		opacity: 0.5;
	}

	.meta {
		margin: var(--space-1) 0 0;
		font-size: 0.8125rem;
	}

	.actions {
		display: flex;
		gap: var(--space-2);
	}

	.actions .hh-button {
		padding: 0.55rem 1.05rem;
		border-radius: var(--r-md);
	}

	.folders {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(16rem, 1fr));
		gap: var(--space-2);
	}

	/* The sort chips' material at row size; see `SortChips`. */
	.folder {
		display: grid;
		grid-template-columns: 2.5rem minmax(0, 1fr) auto;
		align-items: center;
		gap: var(--space-3);
		padding: var(--space-2) var(--space-3) var(--space-2) var(--space-2);
		border-radius: var(--r-md);
		border: 1px solid var(--border-hairline);
		background: var(--control-face);
		-webkit-backdrop-filter: var(--control-blur);
		backdrop-filter: var(--control-blur);
		color: var(--text-default);
		text-decoration: none;
		transition:
			border-color var(--transition),
			color var(--transition);
	}

	.folder:hover {
		border-color: var(--border-strong);
		color: var(--glow-color);
	}

	.folder > :global(svg) {
		color: var(--text-faint);
	}

	.glyph {
		display: grid;
		place-items: center;
		width: 2.5rem;
		height: 2.5rem;
		border-radius: var(--r-sm);
		background: var(--bg-sunken);
		color: var(--text-muted);
		overflow: hidden;
	}

	.name {
		font-size: 0.875rem;
		font-weight: 500;
	}

	.tracks {
		padding: 0;
	}

	.empty {
		padding: var(--space-7);
		text-align: center;
	}

	/* A phone: glyphs only, as on the album page. */
	@media (max-width: 36rem) {
		.actions .label {
			display: none;
		}

		.actions .hh-button {
			width: 2.75rem;
			height: 2.75rem;
			padding: 0;
		}
	}
</style>
