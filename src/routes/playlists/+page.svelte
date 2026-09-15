<script lang="ts">
	import { goto } from '$app/navigation';
	import { page as pageState } from '$app/state';
	import Icon from '$lib/components/Icon.svelte';
	import MediaCard from '$lib/components/MediaCard.svelte';
	import MediaGrid from '$lib/components/MediaGrid.svelte';
	import SortChips from '$lib/components/SortChips.svelte';
	import { playContainer } from '$lib/client/actions';
	import { createPlaylist } from '$lib/client/playlists.svelte';
	import { formatLongDuration } from '$lib/client/format';
	import type { PlaylistSort } from '$lib/types';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const LABELS: Record<PlaylistSort, string> = {
		recentlyUpdated: 'Recently updated',
		recentlyAdded: 'Recently added',
		alphabetical: 'A–Z',
		trackCount: 'Most tracks',
		duration: 'Longest'
	};

	let creating = $state(false);
	let name = $state('');
	let busy = $state(false);
	let error = $state<string | null>(null);
	let field = $state<HTMLInputElement | null>(null);

	$effect(() => {
		if (creating) field?.focus();
	});

	async function create(event: SubmitEvent) {
		event.preventDefault();
		const trimmed = name.trim();
		if (!trimmed || busy) return;

		busy = true;
		error = null;
		try {
			const id = await createPlaylist(trimmed);
			name = '';
			creating = false;
			// Straight into the new playlist: an empty one is only useful once you
			// start putting things in it.
			await goto(`/playlists/${id}`);
		} catch (err) {
			error = err instanceof Error ? err.message : 'Could not create that playlist';
		} finally {
			busy = false;
		}
	}

	function subtitle(playlist: PageData['playlists'][number]): string {
		return [
			playlist.songCount ? `${playlist.songCount} tracks` : null,
			formatLongDuration(playlist.duration) || null
		]
			.filter(Boolean)
			.join(' · ');
	}

	function sortHref(sort: PlaylistSort): string {
		const params = new URLSearchParams(pageState.url.searchParams);
		params.set('sort', sort);
		return `/playlists?${params}`;
	}
</script>

<svelte:head>
	<title>Playlists · Heddohon</title>
</svelte:head>

<div class="page">
	<header>
		<div>
			<span class="hh-eyebrow">Library</span>
			<h1>Playlists</h1>
		</div>
		<div class="controls">
			<SortChips
				sorts={data.sorts}
				active={data.sort}
				labels={LABELS}
				href={sortHref}
				label="Sort playlists"
			/>
			<button class="hh-button hh-button--primary new" onclick={() => (creating = !creating)}>
				<Icon name="plus" size={16} />
				New playlist
			</button>
		</div>
	</header>

	{#if creating}
		<form class="create" onsubmit={create}>
			<label class="hh-visually-hidden" for="playlist-name">Playlist name</label>
			<input
				id="playlist-name"
				class="hh-input"
				bind:this={field}
				bind:value={name}
				placeholder="Name your playlist"
				maxlength="200"
				autocomplete="off"
			/>
			<button class="hh-button hh-button--primary" type="submit" disabled={busy || !name.trim()}>
				{busy ? 'Creating…' : 'Create'}
			</button>
			<button
				class="hh-button"
				type="button"
				onclick={() => {
					creating = false;
					error = null;
				}}
			>
				Cancel
			</button>
		</form>
		{#if error}
			<p class="alert" role="alert">{error}</p>
		{/if}
	{/if}

	{#if data.playlists.length > 0}
		<MediaGrid density={data.settings.gridSize}>
			{#each data.playlists as playlist (playlist.id)}
				<MediaCard
					href="/playlists/{playlist.id}"
					title={playlist.name}
					subtitle={subtitle(playlist)}
					coverArt={playlist.coverArt}
					onplay={() => playContainer('playlist', playlist.id)}
				/>
			{/each}
		</MediaGrid>
	{:else}
		<p class="empty hh-muted">
			No playlists yet. Make one here, or create it in your music server — either way it shows up in
			both.
		</p>
	{/if}
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

	.controls {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		flex-wrap: wrap;
	}

	.new {
		border-radius: var(--r-md);
		white-space: nowrap;
	}

	.create {
		display: flex;
		gap: var(--space-2);
		max-width: 34rem;
	}

	.create .hh-button {
		flex: none;
		border-radius: var(--r-md);
	}

	.create .hh-button:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.alert {
		margin: 0;
		padding: var(--space-2) var(--space-3);
		border-radius: var(--r-sm);
		font-size: 0.8125rem;
		background: color-mix(in srgb, var(--danger) 14%, var(--bg-surface));
		border: 1px solid color-mix(in srgb, var(--danger) 40%, transparent);
		color: var(--text-strong);
		max-width: 34rem;
	}

	.empty {
		padding: var(--space-7);
		text-align: center;
		max-width: 44ch;
		margin-inline: auto;
	}
</style>
