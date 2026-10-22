<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import Icon from '$lib/components/Icon.svelte';
	import { page } from '$app/state';
	import { shareComposer } from '$lib/client/share.svelte';
	import HeroTitle from '$lib/components/HeroTitle.svelte';
	import Sleeve from '$lib/components/Sleeve.svelte';
	import SmartPlaylistEditor from '$lib/components/SmartPlaylistEditor.svelte';
	import TrackList from '$lib/components/TrackList.svelte';
	import { formatLongDuration } from '$lib/client/format';
	import { player } from '$lib/client/player.svelte';
	import {
		addSongsToPlaylist,
		deletePlaylist,
		moveTrack,
		removeTracks,
		renamePlaylist,
		setPlaylistPublic,
		setPlaylistRules
	} from '$lib/client/playlists.svelte';
	import { describeRules, type SmartRules } from '$lib/smartrules';
	import { heroSweep } from '$lib/client/motion';
	import type { Song } from '$lib/types';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	// The heading sweeps in from the left after a navigation; see `heroSweep`.
	const sweep = heroSweep();

	const playlist = $derived(data.playlist);
	const totalDuration = $derived(
		playlist.duration ?? playlist.songs.reduce((sum, song) => sum + song.duration, 0)
	);

	let renaming = $state(false);
	let draftName = $state('');
	let busy = $state(false);
	let error = $state<string | null>(null);
	let confirmingDelete = $state(false);
	let field = $state<HTMLInputElement | null>(null);

	$effect(() => {
		if (renaming) field?.focus();
	});

	function startRename() {
		draftName = playlist.name;
		renaming = true;
		error = null;
	}

	async function commitRename(event: SubmitEvent) {
		event.preventDefault();
		const next = draftName.trim();
		if (!next || busy) return;
		if (next === playlist.name) {
			renaming = false;
			return;
		}

		busy = true;
		error = null;
		try {
			await renamePlaylist(playlist.id, next);
			renaming = false;
			await invalidateAll();
		} catch (err) {
			error = err instanceof Error ? err.message : 'Could not rename this playlist';
		} finally {
			busy = false;
		}
	}

	/**
	 * Removes one row or the rows picked together. The server takes 1000
	 * positions a request, so more go in turns from the end of the list, which
	 * leaves the positions before each turn where they were.
	 */
	async function removeAll(indexes: number[]) {
		if (busy || indexes.length === 0) return;
		busy = true;
		error = null;
		const highestFirst = [...indexes].sort((a, b) => b - a);
		try {
			for (let at = 0; at < highestFirst.length; at += 1000) {
				await removeTracks(playlist.id, highestFirst.slice(at, at + 1000));
			}
			await invalidateAll();
		} catch (err) {
			await invalidateAll();
			error = err instanceof Error ? err.message : indexes.length === 1 ? 'Could not remove that track' : 'Could not remove those tracks';
		} finally {
			busy = false;
		}
	}

	/*
	 * The new order is shown at once and written behind it. A refusal (the
	 * playlist changed in another player since this page loaded, or the music
	 * server would not write it) puts the page back to what the server holds
	 * and says why.
	 */
	let reordered = $state<Song[] | null>(null);
	const shownSongs = $derived(reordered ?? playlist.songs);

	async function move(from: number, to: number) {
		if (busy) return;
		const before = shownSongs;
		const next = [...before];
		const [moved] = next.splice(from, 1);
		next.splice(to, 0, moved);
		reordered = next;
		busy = true;
		error = null;
		try {
			await moveTrack(playlist.id, { from, to, songId: moved.id, count: before.length });
		} catch (err) {
			error =
				err instanceof Error && /changed/.test(err.message)
					? 'This playlist was changed somewhere else. It has been reloaded; try the move again.'
					: err instanceof Error
						? err.message
						: 'Could not move that track';
		} finally {
			await invalidateAll();
			reordered = null;
			busy = false;
		}
	}


	const smart = $derived(data.smart);
	// Rules from a file on the server, or beyond what the editor edits, are shown and left alone.
	const rulesEditable = $derived(playlist.editable && smart !== null && smart.rules !== null && !smart.fromFile);
	let editingRules = $state(false);

	/** "Private", "Smart, public", "By someone, read only". */
	const access = $derived.by(() => {
		const whose = playlist.editable
			? playlist.isPublic
				? 'public'
				: 'private'
			: `${playlist.owner ? `by ${playlist.owner}` : "another user's"}, read only`;
		const text = smart ? `smart, ${whose}` : whose;
		return text[0].toUpperCase() + text.slice(1);
	});

	async function saveRules(rules: SmartRules) {
		if (busy) return;
		busy = true;
		error = null;
		try {
			await setPlaylistRules(playlist.id, rules);
			await invalidateAll();
			editingRules = false;
		} catch (err) {
			error = err instanceof Error ? err.message : 'Could not save these rules';
		} finally {
			busy = false;
		}
	}

	async function toggleVisibility() {
		if (busy) return;
		busy = true;
		error = null;
		try {
			await setPlaylistPublic(playlist.id, !playlist.isPublic);
			await invalidateAll();
		} catch (err) {
			error = err instanceof Error ? err.message : 'Could not change who can see this playlist';
		} finally {
			busy = false;
		}
	}
	async function destroy() {
		if (busy) return;
		busy = true;
		error = null;
		try {
			await deletePlaylist(playlist.id);
			await goto('/playlists');
		} catch (err) {
			error = err instanceof Error ? err.message : 'Could not delete this playlist';
			busy = false;
			confirmingDelete = false;
		}
	}
</script>

<svelte:head>
	<title>{playlist.name} · Heddohon</title>
</svelte:head>

<div class="page">
	<header class="hero">
		<div class="art">
			<Sleeve
				coverArt={playlist.coverArt}
				size={640}
				alt="Cover of {playlist.name}"
				radius="var(--r-lg)"
			/>
		</div>
		<div class="details" {@attach sweep}>

			{#if renaming}
				<form class="rename" onsubmit={commitRename}>
					<label class="hh-visually-hidden" for="rename-playlist">Playlist name</label>
					<input
						id="rename-playlist"
						class="hh-input"
						bind:this={field}
						bind:value={draftName}
						maxlength="200"
						autocomplete="off"
					/>
					<button class="hh-button hh-button--primary" type="submit" disabled={busy || !draftName.trim()}>
						Save
					</button>
					<button class="hh-button" type="button" onclick={() => (renaming = false)}>Cancel</button>
				</form>
			{:else}
				<HeroTitle text={playlist.name} max={3.2} />
			{/if}

			{#if playlist.comment}
				<p class="comment hh-muted">{playlist.comment}</p>
			{/if}

			<p class="meta hh-numeric hh-muted">
				{playlist.songs.length} track{playlist.songs.length === 1 ? '' : 's'}
				{#if totalDuration}<span class="dot" aria-hidden="true">·</span>{formatLongDuration(totalDuration)}{/if}
				<span class="dot" aria-hidden="true">·</span>
				{access}
			</p>

			{#if smart}
				<p class="rules hh-muted">
					{#if smart.rules}
						{describeRules(smart.rules)}.
					{:else}
						Its rules use more than Heddohon edits; change them in Navidrome.
					{/if}
					{#if smart.fromFile}
						A file on the music server defines them.
					{/if}
				</p>
			{/if}

			<!--
			  Two groups: playback on the left, and what changes the playlist apart
			  and quieter on the right. Six buttons of equal weight in one row read
			  as a toolbar.
			-->
			<div class="actions">
				<div class="group">
					<button
						class="hh-button hh-button--primary"
						onclick={() => player.playNow(playlist.songs)}
						disabled={playlist.songs.length === 0}
					>
						<Icon name="play" size={16} />
						Play
					</button>
					<button
						class="hh-button"
						onclick={() => player.playShuffled(playlist.songs)}
						disabled={playlist.songs.length < 2}
					>
						<Icon name="shuffle" size={16} />
						Shuffle
					</button>
					<button
						class="hh-button"
						onclick={() => player.addToQueue(playlist.songs)}
						disabled={playlist.songs.length === 0}
					>
						<Icon name="queue" size={16} />
						Queue
					</button>
					<!-- A link plays through the sharer's account, so only the owner's own can be shared. -->
					{#if page.data.sharing && playlist.editable}
						<button
							class="hh-button"
							onclick={() =>
								shareComposer.open({
									kind: 'playlist',
									id: playlist.id,
									title: playlist.name,
									subtitle: null,
									coverArt: playlist.coverArt
								})}
							disabled={playlist.songs.length === 0}
						>
							<Icon name="share" size={16} />
							Share
						</button>
					{/if}
				</div>

				<div class="group group--edit">
					<!-- Downloads, so links: the server writes the file. -->
					<details class="export">
						<summary class="hh-button hh-button--ghost">
							<Icon name="download" size={16} />
							Export
						</summary>
						<div class="export-menu hh-glass hh-float">
							<a href="/api/playlists/{encodeURIComponent(playlist.id)}/export?format=m3u" download>
								M3U, by file
							</a>
							<a href="/api/playlists/{encodeURIComponent(playlist.id)}/export?format=m3u-titles" download>
								M3U, by artist and title
							</a>
							<a href="/api/playlists/{encodeURIComponent(playlist.id)}/export?format=csv" download>CSV</a>
						</div>
					</details>
					{#if player.queue.length > 0}
						<button
							class="hh-button hh-button--ghost"
							onclick={() => addSongsToPlaylist(player.queue, `Current queue`)}
							title="Copy what is in the play queue into a playlist"
						>
							<Icon name="plus" size={16} />
							Save the queue
						</button>
					{/if}
					{#if rulesEditable}
						<button
							class="hh-button hh-button--ghost"
							onclick={() => {
								editingRules = !editingRules;
								error = null;
							}}
							disabled={busy}
							aria-expanded={editingRules}
						>
							Edit rules
						</button>
					{/if}
					{#if playlist.editable}
						<button
							class="hh-button hh-button--ghost"
							onclick={toggleVisibility}
							disabled={busy}
							title={playlist.isPublic
								? 'Every account on the music server can see and play it. Make it yours alone.'
								: 'Only you can see it. Let every account on the music server see and play it.'}
						>
							{playlist.isPublic ? 'Make private' : 'Make public'}
						</button>
						<button
							class="hh-button hh-button--ghost"
							onclick={startRename}
							disabled={busy || renaming}
						>
							Rename
						</button>
						<button
							class="hh-button hh-button--ghost danger"
							onclick={() => (confirmingDelete = true)}
							disabled={busy}
						>
							<Icon name="trash" size={16} />
							Delete
						</button>
					{/if}
				</div>
			</div>
		</div>
	</header>

	{#if error}
		<p class="alert" role="alert">{error}</p>
	{/if}

	{#if editingRules && smart?.rules}
		<SmartPlaylistEditor
			initial={smart.rules}
			{busy}
			onsave={saveRules}
			oncancel={() => (editingRules = false)}
		/>
	{/if}

	{#if confirmingDelete}
		<div class="confirm" role="alertdialog" aria-label="Confirm deletion">
			<p>
				Delete <strong>{playlist.name}</strong>? This removes it from your music server, not just
				from Heddohon. The tracks themselves are untouched.
			</p>
			<div class="confirm-actions">
				<button class="hh-button danger" onclick={destroy} disabled={busy}>
					{busy ? 'Deleting…' : 'Delete playlist'}
				</button>
				<button class="hh-button" onclick={() => (confirmingDelete = false)} disabled={busy}>
					Keep it
				</button>
			</div>
		</div>
	{/if}

	<section class="tracks">
		<!-- Another user's playlist, and one the server fills itself, offer no edits: the music server refuses them. -->
		<TrackList
			songs={shownSongs}
			variant="artwork"
			showAlbum
			onremove={playlist.tracksEditable ? removeAll : null}
			onmove={playlist.tracksEditable ? move : null}
		/>
	</section>
</div>

<style>
	.page {
		display: grid;
		gap: var(--space-6);
		max-width: 76rem;
	}

	.hero {
		display: grid;
		grid-template-columns: minmax(0, 13rem) minmax(0, 1fr);
		/* As on the album hero: the gutter clears the record at its furthest, so
		   the text is never under it. */
		gap: calc(var(--space-7) + var(--space-2));
		/* Centred for the reason given on the album hero. */
		align-items: center;
	}

	.details {
		/* The hero title sizes itself against this column — see HeroTitle. */
		container-type: inline-size;
		display: grid;
		gap: var(--space-2);
		justify-items: start;
		min-width: 0;
		width: 100%;
	}

	.rename {
		display: flex;
		gap: var(--space-2);
		width: min(34rem, 100%);
		margin: 0.2rem 0;
	}

	.rename .hh-button {
		flex: none;
		border-radius: var(--r-md);
	}

	.rename .hh-button:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.comment {
		margin: 0;
		max-width: 56ch;
		font-size: 0.9375rem;
	}

	.meta {
		margin: 0;
		font-size: 0.8125rem;
	}

	.dot {
		margin: 0 0.45rem;
	}

	.rules {
		margin: 0;
		max-width: 60ch;
		font-size: 0.8125rem;
	}

	.actions {
		display: flex;
		align-items: center;
		gap: var(--space-5);
		margin-top: var(--space-3);
		flex-wrap: wrap;
		width: 100%;
	}

	.group {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		flex-wrap: wrap;
	}

	/* Pushed to the far edge on a wide hero, so the two groups do not read as
	   one run of controls. */
	.group--edit {
		margin-left: auto;
	}

	@media (max-width: 60rem) {
		.group--edit {
			margin-left: 0;
		}
	}

	.actions .hh-button {
		padding: 0.55rem 1.05rem;
		border-radius: var(--r-md);
	}

	.actions .hh-button:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	/* The export's three files, in a pane under its button. */
	.export {
		position: relative;
	}

	.export summary {
		list-style: none;
		cursor: default;
	}

	.export summary::-webkit-details-marker {
		display: none;
	}

	.export-menu {
		position: absolute;
		top: calc(100% + var(--space-1));
		left: 0;
		z-index: 5;
		display: grid;
		min-width: 14rem;
		padding: var(--space-1);
		border: 1px solid var(--border-strong);
		border-radius: var(--r-md);
	}

	.export-menu a {
		padding: 0.45rem var(--space-3);
		border-radius: var(--r-sm);
		color: var(--text-default);
		font-size: 0.875rem;
		text-decoration: none;
		white-space: nowrap;
	}

	.export-menu a:hover,
	.export-menu a:focus-visible {
		background: var(--bg-hover);
		color: var(--text-strong);
		outline: none;
	}

	.danger:hover:not(:disabled) {
		color: var(--danger);
		border-color: var(--danger);
	}

	.alert {
		margin: 0;
		padding: var(--space-3) var(--space-4);
		border-radius: var(--r-sm);
		font-size: 0.875rem;
		background: color-mix(in srgb, var(--danger) 14%, var(--bg-surface));
		border: 1px solid color-mix(in srgb, var(--danger) 40%, transparent);
		color: var(--text-strong);
	}

	.confirm {
		padding: var(--space-4);
		border-radius: var(--r-md);
		border: 1px solid color-mix(in srgb, var(--danger) 45%, transparent);
		background: color-mix(in srgb, var(--danger) 9%, var(--bg-surface));
		display: grid;
		gap: var(--space-3);
		max-width: 44rem;
	}

	.confirm p {
		margin: 0;
		font-size: 0.9375rem;
		max-width: 62ch;
	}

	.confirm strong {
		color: var(--text-strong);
	}

	.confirm-actions {
		display: flex;
		gap: var(--space-2);
		flex-wrap: wrap;
	}

	.tracks {
		padding: 0;
	}

	@media (max-width: 52rem) {
		.hero {
			grid-template-columns: minmax(0, 1fr);
			gap: var(--space-4);
		}

		.art {
			max-width: 11rem;
		}
	}
</style>
