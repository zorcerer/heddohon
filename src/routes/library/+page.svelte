<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import MediaCard from '$lib/components/MediaCard.svelte';
	import MediaShelf from '$lib/components/MediaShelf.svelte';
	import { playContainer } from '$lib/client/actions';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	/*
	 * The destinations the rail lists one by one on a wider screen. On a phone
	 * the dock has room for four, and these four are one of them.
	 */
	const WAYS = [
		{ href: '/albums', label: 'Albums', icon: 'album' as const },
		{ href: '/artists', label: 'Artists', icon: 'artist' as const },
		{ href: '/playlists', label: 'Playlists', icon: 'playlist' as const },
		{ href: '/genres', label: 'Genres', icon: 'genre' as const },
		{ href: '/folders', label: 'Folders', icon: 'folder' as const },
		{ href: '/history', label: 'Recently played', icon: 'history' as const }
	];
</script>

<svelte:head>
	<title>Library · Heddohon</title>
</svelte:head>

<div class="page">
	<header>
		<span class="hh-eyebrow">Your collection</span>
		<h1>Library</h1>
	</header>

	<nav class="ways hh-stagger" aria-label="Library">
		{#each WAYS as way (way.href)}
			<a class="way hh-glass" href={way.href}>
				<span class="glyph"><Icon name={way.icon} size={22} /></span>
				<span class="name">{way.label}</span>
				<Icon name="chevron-right" size={16} />
			</a>
		{/each}
	</nav>

	<a class="settings hh-glass" href="/settings">
		<Icon name="settings" size={19} />
		<span>Settings</span>
		<span class="hh-muted note">Theme, playback, account</span>
		<Icon name="chevron-right" size={16} />
	</a>

	{#if data.recentlyAdded.length > 0}
		<MediaShelf title="Recently added" href="/albums?sort=recentlyAdded" index={1}>
			{#each data.recentlyAdded as album (album.id)}
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
	{/if}

	{#if data.playlists.length > 0}
		<MediaShelf
			title="Playlists"
			href="/playlists"
			index={data.recentlyAdded.length > 0 ? 2 : 1}
			density="compact"
		>
			{#each data.playlists as playlist (playlist.id)}
				<MediaCard
					href="/playlists/{playlist.id}"
					title={playlist.name}
					subtitle={playlist.songCount ? `${playlist.songCount} tracks` : null}
					coverArt={playlist.coverArt}
					onplay={() => playContainer('playlist', playlist.id)}
				/>
			{/each}
		</MediaShelf>
	{/if}
</div>

<style>
	.page {
		display: grid;
		gap: var(--space-5);
		max-width: 64rem;
	}

	header {
		display: grid;
		gap: var(--space-1);
	}

	/*
	 * Six doors, two across on a phone and three across wider, a lone last one
	 * taking the width. Each is a pane of the same glass as the dock, so the
	 * page reads as the dock's tab opened out rather than as a list of links.
	 */
	.ways {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: var(--space-2);
	}

	.way:last-child:nth-child(odd) {
		grid-column: 1 / -1;
	}

	@media (min-width: 48rem) {
		.ways {
			grid-template-columns: repeat(3, minmax(0, 1fr));
		}

		.way:last-child:nth-child(odd) {
			grid-column: auto;
		}
	}

	.way {
		position: relative;
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		grid-template-rows: auto 1fr;
		align-items: end;
		min-height: 6.25rem;
		padding: var(--space-3) var(--space-3) var(--space-3) var(--space-4);
		border-radius: var(--r-lg);
		color: var(--text-muted);
		transition:
			color var(--transition),
			scale var(--dur-press) var(--ease-out);
	}

	.way:active {
		scale: 0.97;
	}

	.glyph {
		grid-column: 1 / -1;
		align-self: start;
		display: grid;
		place-items: center;
		width: 2.5rem;
		height: 2.5rem;
		border-radius: var(--r-md);
		color: var(--accent);
		background: color-mix(in srgb, var(--accent) 14%, transparent);
		box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 20%, transparent);
	}

	.name {
		font-family: var(--font-display);
		font-size: 1.125rem;
		font-weight: 750;
		letter-spacing: -0.015em;
		color: var(--text-strong);
		text-shadow: var(--text-shade);
	}

	.way:hover .name,
	.settings:hover span:first-of-type {
		color: var(--glow-color);
		text-shadow: var(--glow-text);
	}

	.settings {
		display: grid;
		grid-template-columns: auto auto minmax(0, 1fr) auto;
		align-items: center;
		gap: var(--space-3);
		padding: var(--space-3) var(--space-3) var(--space-3) var(--space-4);
		border-radius: var(--r-lg);
		color: var(--text-muted);
		font-weight: 600;
	}

	.settings span:first-of-type {
		color: var(--text-strong);
		text-shadow: var(--text-shade);
	}

	.note {
		font-size: 0.8125rem;
		font-weight: 400;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
</style>
