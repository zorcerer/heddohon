<script lang="ts">
	/**
	 * The "add to playlist" dialog. Mounted once in the root layout, because a
	 * library page can render hundreds of track rows and one picker per row would
	 * mean hundreds of identical requests for the same list.
	 */
	import { playlistPicker } from '$lib/client/playlists.svelte';
	import { formatLongDuration } from '$lib/client/format';
	import Icon from './Icon.svelte';

	let dialog = $state<HTMLDialogElement | null>(null);
	let newName = $state('');

	const open = $derived(playlistPicker.request !== null);
	const count = $derived(playlistPicker.request?.songIds.length ?? 0);

	$effect(() => {
		if (!dialog) return;
		if (open && !dialog.open) {
			newName = '';
			dialog.showModal();
		} else if (!open && dialog.open) {
			dialog.close();
		}
	});

	function submitNew(event: SubmitEvent) {
		event.preventDefault();
		const name = newName.trim();
		if (name) void playlistPicker.createWith(name);
	}
</script>

<dialog bind:this={dialog} onclose={() => playlistPicker.close()} class="picker hh-glass">
	{#if playlistPicker.request}
		<header>
			<div>
				<span class="hh-eyebrow">Add to playlist</span>
				<h2>{playlistPicker.request.label}</h2>
				<p class="hh-numeric hh-muted count">{count} track{count === 1 ? '' : 's'}</p>
			</div>
			<button class="close" onclick={() => playlistPicker.close()} aria-label="Close">
				<Icon name="close" size={18} />
			</button>
		</header>

		{#if playlistPicker.error}
			<p class="alert" role="alert">{playlistPicker.error}</p>
		{/if}

		{#if playlistPicker.done}
			<p class="done" role="status">
				Added to <strong>{playlistPicker.done}</strong>.
			</p>
		{/if}

		<div class="list">
			{#if playlistPicker.loading}
				<p class="hh-muted empty">Loading your playlists…</p>
			{:else if playlistPicker.playlists.length === 0}
				<p class="hh-muted empty">No playlists yet — make one below.</p>
			{:else}
				{#each playlistPicker.playlists as playlist (playlist.id)}
					<button
						class="row"
						disabled={playlistPicker.busy}
						onclick={() => playlistPicker.addTo(playlist)}
					>
						<span class="name hh-truncate">{playlist.name}</span>
						<span class="hh-numeric hh-muted meta">
							{playlist.songCount ?? 0} · {formatLongDuration(playlist.duration) || '—'}
						</span>
					</button>
				{/each}
			{/if}
		</div>

		<form class="create" onsubmit={submitNew}>
			<label class="hh-visually-hidden" for="new-playlist-name">New playlist name</label>
			<input
				id="new-playlist-name"
				class="hh-input"
				bind:value={newName}
				placeholder="New playlist…"
				maxlength="200"
				autocomplete="off"
			/>
			<button
				class="hh-button hh-button--primary"
				type="submit"
				disabled={playlistPicker.busy || newName.trim().length === 0}
			>
				<Icon name="plus" size={15} />
				Create
			</button>
		</form>
	{/if}
</dialog>

<style>
	.picker {
		width: min(26rem, calc(100vw - 2rem));
		padding: 0;
		border: 1px solid var(--glass-edge);
		border-radius: var(--r-lg);
		color: var(--text-default);
		box-shadow: var(--shadow-high);
	}

	.picker::backdrop {
		background: rgb(0 0 0 / 0.45);
		backdrop-filter: blur(2px);
	}

	header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: var(--space-3);
		padding: var(--space-4) var(--space-4) var(--space-3);
		border-bottom: 1px solid var(--border-hairline);
	}

	h2 {
		font-size: 1.15rem;
		margin: 0.15rem 0 0;
	}

	.count {
		margin: 0.2rem 0 0;
		font-size: 0.6875rem;
	}

	.close {
		display: grid;
		place-items: center;
		padding: 0.3rem;
		border-radius: var(--r-sm);
		color: var(--text-faint);
		transition:
			color var(--transition),
			background var(--transition);
	}

	.close:hover {
		color: var(--glow-color);
		filter: var(--glow-icon);
	}

	.alert,
	.done {
		margin: var(--space-3) var(--space-4) 0;
		padding: var(--space-2) var(--space-3);
		border-radius: var(--r-sm);
		font-size: 0.8125rem;
	}

	.alert {
		background: color-mix(in srgb, var(--danger) 14%, var(--bg-sunken));
		border: 1px solid color-mix(in srgb, var(--danger) 40%, transparent);
		color: var(--text-strong);
	}

	.done {
		background: color-mix(in srgb, var(--positive) 14%, var(--bg-sunken));
		border: 1px solid color-mix(in srgb, var(--positive) 40%, transparent);
		color: var(--text-strong);
	}

	.done strong {
		color: var(--text-strong);
	}

	.list {
		max-height: min(22rem, 45vh);
		overflow-y: auto;
		padding: var(--space-2);
		display: grid;
		gap: 1px;
	}

	.row {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: var(--space-3);
		width: 100%;
		padding: 0.5rem var(--space-3);
		border-radius: var(--r-sm);
		text-align: left;
		transition:
			text-shadow var(--transition),
			color var(--transition);
	}

	.row:hover:not(:disabled) {
		color: var(--glow-color);
		text-shadow: var(--glow-text);
	}

	.row:disabled {
		opacity: 0.55;
		cursor: progress;
	}

	.name {
		color: var(--text-strong);
		font-weight: 500;
		font-size: 0.9375rem;
	}

	.meta {
		font-size: 0.6875rem;
		flex: none;
	}

	.empty {
		padding: var(--space-5);
		text-align: center;
		font-size: 0.875rem;
		margin: 0;
	}

	.create {
		display: flex;
		gap: var(--space-2);
		padding: var(--space-3) var(--space-4) var(--space-4);
		border-top: 1px solid var(--border-hairline);
	}

	.create .hh-button {
		flex: none;
	}

	.create .hh-button:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
</style>
