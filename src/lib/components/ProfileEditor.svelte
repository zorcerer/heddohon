<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import type { PageSettings, ProfileView } from '$lib/server/profilepage';
	import { listeners } from '$lib/client/listeners.svelte';
	import Cover from './Cover.svelte';
	import Icon from './Icon.svelte';

	/**
	 * The owner's controls for their profile page: the name and picture (the
	 * same ones "Listening now" shows), the bio, the four albums, who sees the
	 * page, and its public link. Albums are found through `/api/search`, as
	 * the command line finds them; the server reads each one picked through
	 * the account's own credential before it keeps it.
	 *
	 * A dialog, opened by the button on the owner's own page (`open`): the page
	 * shows the profile as others see it, and the editor only when asked for.
	 * Closing it without saving drops what was changed; a save closes it.
	 */
	let {
		page,
		settings,
		maxBio,
		username,
		open = $bindable(false)
	}: { page: ProfileView; settings: PageSettings; maxBio: number; username: string; open?: boolean } = $props();

	let dialog = $state<HTMLDialogElement | null>(null);

	interface Found {
		id: string;
		name: string;
		artist: string | null;
		year: number | null;
		coverArt: string | null;
	}
	type Slot = { id: string; title: string; artist: string | null } | null;

	// Seeded from the page as loaded, and again each time the dialog opens.
	let name = $state('');
	let bio = $state('');
	let slots = $state<Slot[]>([]);
	let listed = $state(false);
	let recent = $state(false);
	let top = $state(false);
	function reset() {
		name = page.name === username ? '' : page.name;
		bio = page.bio ?? '';
		slots = page.favourites.map((album) => album && { id: album.id, title: album.title, artist: album.artist });
		listed = settings.listed;
		recent = settings.recent;
		top = settings.top;
	}
	$effect.pre(reset);

	$effect(() => {
		if (!dialog) return;
		if (open && !dialog.open) {
			reset();
			message = null;
			problem = null;
			dialog.showModal();
		} else if (!open && dialog.open) dialog.close();
	});

	let query = $state('');
	let found = $state<Found[]>([]);
	let searching = $state(false);
	let busy = $state(false);
	let message = $state<string | null>(null);
	let problem = $state<string | null>(null);
	let link = $state<string | null>(null);
	let pictureInput = $state<HTMLInputElement | null>(null);

	const bioLength = $derived(Array.from(bio).length);
	let searchTimer: ReturnType<typeof setTimeout> | undefined;

	function search() {
		clearTimeout(searchTimer);
		const text = query.trim();
		if (text.length < 2) {
			found = [];
			return;
		}
		searchTimer = setTimeout(async () => {
			searching = true;
			const response = await fetch(`/api/search?q=${encodeURIComponent(text)}`).catch(() => null);
			const body = (await response?.json().catch(() => null)) as { albums?: Found[] } | null;
			if (query.trim() === text) found = (body?.albums ?? []).slice(0, 12);
			searching = false;
		}, 250);
	}

	function pick(album: Found) {
		if (slots.some((slot) => slot?.id === album.id)) return;
		const empty = slots.findIndex((slot) => slot === null);
		if (empty < 0) {
			problem = 'All four places are taken. Remove one first.';
			return;
		}
		problem = null;
		slots[empty] = { id: album.id, title: album.name, artist: album.artist };
	}

	function move(index: number, by: -1 | 1) {
		const to = index + by;
		if (to < 0 || to >= slots.length) return;
		[slots[index], slots[to]] = [slots[to], slots[index]];
	}

	async function send(url: string, init: RequestInit): Promise<Record<string, any> | null> {
		const response = await fetch(url, init).catch(() => null);
		const body = await response?.json().catch(() => null);
		if (!response?.ok) {
			problem = body?.error ?? body?.message ?? 'That could not be saved. Try again.';
			return null;
		}
		return body ?? {};
	}

	async function save(event: SubmitEvent) {
		event.preventDefault();
		busy = true;
		problem = null;
		message = null;
		const wanted = name.trim() || null;
		if (wanted !== (page.name === username ? null : page.name) && !(await listeners.save({ name: wanted }))) {
			problem = listeners.error ?? 'The name could not be saved.';
			busy = false;
			return;
		}
		const saved = await send('/api/profile/page', {
			method: 'PATCH',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ bio: bio.trim() || null, albums: slots.map((slot) => slot?.id ?? null), listed, recent, top })
		});
		if (saved) {
			await invalidateAll();
			open = false;
		}
		busy = false;
	}

	async function choosePicture(input: HTMLInputElement) {
		const file = input.files?.[0];
		input.value = '';
		if (!file) return;
		busy = true;
		if (await listeners.setPicture(file)) await invalidateAll();
		else problem = listeners.error;
		busy = false;
	}

	async function removePicture() {
		busy = true;
		if (await listeners.removePicture()) await invalidateAll();
		busy = false;
	}

	async function makeLink() {
		busy = true;
		problem = null;
		const made = await send('/api/profile/page', { method: 'POST' });
		if (made) {
			link = made.url;
			await invalidateAll();
		}
		busy = false;
	}

	async function withdrawLink() {
		busy = true;
		problem = null;
		if (await send('/api/profile/page', { method: 'DELETE' })) {
			link = null;
			message = 'The public link no longer works.';
			await invalidateAll();
		}
		busy = false;
	}

	async function copyLink() {
		if (!link) return;
		await navigator.clipboard.writeText(link).catch(() => undefined);
		message = 'Copied.';
	}
</script>

<dialog bind:this={dialog} onclose={() => (open = false)} class="editor hh-glass" aria-labelledby="profile-editor-title">
	<header>
		<div>
			<h2 id="profile-editor-title">Edit your profile</h2>
		</div>
		<button class="close" type="button" onclick={() => (open = false)} aria-label="Close">
			<Icon name="close" size={18} />
		</button>
	</header>

	<form class="body" onsubmit={save} aria-label="Edit your profile">
		<label class="field">
			<span class="hh-eyebrow">Name</span>
			<input class="hh-input" bind:value={name} maxlength="32" placeholder={username} autocomplete="nickname" spellcheck="false" />
		</label>

		<div class="field">
			<span class="hh-eyebrow">Picture</span>
			<div class="row">
				<input
					bind:this={pictureInput}
					type="file"
					accept="image/*"
					hidden
					aria-label="Picture file"
					onchange={(event) => choosePicture(event.currentTarget)}
				/>
				<button class="hh-button" type="button" disabled={busy} onclick={() => pictureInput?.click()}>
					{page.avatar ? 'Change' : 'Choose a picture'}
				</button>
				{#if page.avatar}
					<button class="hh-button danger" type="button" disabled={busy} onclick={removePicture}>Remove</button>
				{/if}
			</div>
		</div>

		<label class="field">
			<span class="hh-eyebrow">Bio <span class="hh-numeric hh-muted">{bioLength}/{maxBio}</span></span>
			<textarea class="hh-input" bind:value={bio} rows="3" maxlength={maxBio * 2}></textarea>
		</label>

		<div class="field">
			<span class="hh-eyebrow">Four favourites</span>
			<ol class="slots">
				{#each slots as slot, index (index)}
					<li>
						<span class="place hh-numeric hh-muted">{index + 1}</span>
						{#if slot}
							<span class="picked hh-truncate">{slot.title}{slot.artist ? ` · ${slot.artist}` : ''}</span>
							<span class="row">
								<button class="hh-button hh-button--ghost" type="button" aria-label="Move {slot.title} up" disabled={index === 0} onclick={() => move(index, -1)}>↑</button>
								<button
									class="hh-button hh-button--ghost"
									type="button"
									aria-label="Move {slot.title} down"
									disabled={index === slots.length - 1}
									onclick={() => move(index, 1)}>↓</button
								>
								<button class="hh-button hh-button--ghost" type="button" onclick={() => (slots[index] = null)}>Remove</button>
							</span>
						{:else}
							<span class="hh-muted">Empty</span>
						{/if}
					</li>
				{/each}
			</ol>
			<input
				class="hh-input"
				type="search"
				bind:value={query}
				oninput={search}
				placeholder="Search your library for an album"
				aria-label="Search for an album"
				spellcheck="false"
			/>
			{#if found.length > 0}
				<ul class="found">
					{#each found as album (album.id)}
						<li>
							<button class="result" type="button" onclick={() => pick(album)} disabled={slots.some((slot) => slot?.id === album.id)}>
								<span class="thumb"><Cover coverArt={album.coverArt} size={64} /></span>
								<span class="hh-truncate">{album.name}</span>
								<span class="hh-truncate hh-muted">{album.artist ?? ''}{album.year ? ` · ${album.year}` : ''}</span>
							</button>
						</li>
					{/each}
				</ul>
			{:else if searching}
				<p class="hh-muted small">Searching…</p>
			{/if}
		</div>

		<fieldset class="field">
			<legend class="hh-eyebrow">Who sees it</legend>
			<label class="check"><input type="checkbox" bind:checked={listed} /> The other accounts on this server, under People</label>
			<label class="check"><input type="checkbox" bind:checked={recent} /> Show the albums I listened to lately</label>
			<label class="check"><input type="checkbox" bind:checked={top} /> Show my most played artists of the last 30 days</label>
		</fieldset>

		{#if problem}
			<p class="problem" role="alert">{problem}</p>
		{:else if message}
			<p class="hh-muted small" role="status">{message}</p>
		{/if}

		<div class="row">
			<button class="hh-button hh-button--primary" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
			<button class="hh-button hh-button--ghost" type="button" onclick={() => (open = false)}>Cancel</button>
		</div>

		<div class="field link">
			<span class="hh-eyebrow">Public link</span>
			{#if link}
				<div class="row">
					<code class="url">{link}</code>
					<button class="hh-button" type="button" onclick={copyLink}>Copy</button>
				</div>
			{/if}
			<div class="row">
				<button class="hh-button" type="button" disabled={busy} onclick={makeLink}>
					{settings.linkMadeAt ? 'Make a new link' : 'Make a public link'}
				</button>
				{#if settings.linkMadeAt}
					<button class="hh-button danger" type="button" disabled={busy} onclick={withdrawLink}>Withdraw the link</button>
					<span class="hh-muted small">Made {new Date(settings.linkMadeAt).toLocaleDateString()}</span>
				{/if}
			</div>
		</div>
	</form>
</dialog>

<style>
	.editor {
		width: min(40rem, calc(100vw - 2rem));
		max-height: calc(100dvh - 2rem);
		padding: 0;
		border: 1px solid var(--glass-edge);
		border-radius: var(--r-lg);
		color: var(--text-default);
		box-shadow: var(--shadow-high);
	}

	/* The header stays and the form scrolls under it, so a long search keeps the close button in reach. */
	.editor[open] {
		display: flex;
		flex-direction: column;
	}

	.editor::backdrop {
		background: rgb(0 0 0 / 0.45);
		backdrop-filter: blur(2px);
	}

	header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		padding: var(--space-4) var(--space-4) var(--space-3);
		border-bottom: 1px solid var(--border-hairline);
	}

	h2 {
		font-size: 1.15rem;
		margin: 0.15rem 0 0;
	}

	.close {
		display: grid;
		place-items: center;
		padding: 0.3rem;
		border-radius: var(--r-sm);
		color: var(--text-faint);
	}

	.close:hover {
		color: var(--glow-color);
	}

	.body {
		display: grid;
		gap: var(--space-4);
		padding: var(--space-4) var(--space-5) var(--space-5);
		overflow-y: auto;
		min-height: 0;
	}

	.field {
		display: grid;
		gap: var(--space-2);
		border: none;
		margin: 0;
		padding: 0;
		min-width: 0;
	}

	.row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2);
	}

	textarea {
		resize: vertical;
		font: inherit;
	}

	.slots {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: var(--space-1);
	}

	.slots li {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		min-height: 2.25rem;
	}

	.place {
		width: 1.5rem;
		text-align: center;
	}

	.picked {
		flex: 1;
		min-width: 0;
	}

	.found {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: var(--space-1);
		max-height: 20rem;
		overflow-y: auto;
	}

	.result {
		display: grid;
		grid-template-columns: 2.5rem minmax(0, 1fr) minmax(0, 1fr);
		gap: var(--space-3);
		align-items: center;
		width: 100%;
		padding: var(--space-1);
		border-radius: var(--r-sm);
		text-align: left;
		color: inherit;
		background: none;
		border: none;
		cursor: pointer;
	}

	.result:hover:not(:disabled) {
		background: var(--field-face);
	}

	.result:disabled {
		opacity: 0.5;
		cursor: default;
	}

	.thumb {
		width: 2.5rem;
	}

	.check {
		display: flex;
		gap: var(--space-2);
		align-items: center;
	}

	.small {
		font-size: 0.8125rem;
		margin: 0;
	}

	.problem {
		margin: 0;
		font-size: 0.875rem;
		color: var(--danger);
	}

	.url {
		font-family: var(--font-mono);
		font-size: 0.8125rem;
		word-break: break-all;
		user-select: all;
	}
</style>
