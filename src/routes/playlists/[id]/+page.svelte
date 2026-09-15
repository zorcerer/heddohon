<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import Icon from '$lib/components/Icon.svelte';
	import HeroTitle from '$lib/components/HeroTitle.svelte';
	import Sleeve from '$lib/components/Sleeve.svelte';
	import TrackList from '$lib/components/TrackList.svelte';
	import { formatLongDuration } from '$lib/client/format';
	import { player } from '$lib/client/player.svelte';
	import { addSongsToPlaylist, deletePlaylist, removeTracks, renamePlaylist } from '$lib/client/playlists.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

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

	async function removeAt(index: number) {
		if (busy) return;
		busy = true;
		error = null;
		try {
			await removeTracks(playlist.id, [index]);
			await invalidateAll();
		} catch (err) {
			error = err instanceof Error ? err.message : 'Could not remove that track';
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
		<div class="details">
			<span class="hh-eyebrow">Playlist</span>

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
				{#if playlist.owner}<span class="dot" aria-hidden="true">·</span>{playlist.owner}{/if}
			</p>

			<!--
			  Two groups, deliberately: playback on the left, everything that
			  changes the playlist set apart and quieter on the right. Six buttons
			  of equal weight in one row reads as a toolbar to wade through.
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
				</div>

				<div class="group group--edit">
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
				</div>
			</div>
		</div>
	</header>

	{#if error}
		<p class="alert" role="alert">{error}</p>
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
		<TrackList songs={playlist.songs} variant="artwork" showAlbum onremove={removeAt} />
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
		/* Same reasoning as the album hero: the gutter clears the record at its
		   furthest, so the text is never underneath it. */
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

	/* Pushed to the far edge on a wide hero so the two groups cannot be mistaken
	   for one run of controls. */
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
