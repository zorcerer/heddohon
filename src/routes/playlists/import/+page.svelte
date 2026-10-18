<script lang="ts">
	/**
	 * A playlist from a file: read here (`client/playlistfile.ts`), looked for
	 * in the library on the server (`/api/playlists/match`), shown as a report,
	 * and saved on the music server once the listener has seen it.
	 */
	import { goto } from '$app/navigation';
	import Icon from '$lib/components/Icon.svelte';
	import { decode, readPlaylistFile, type FilePlaylist, type FileTrack } from '$lib/client/playlistfile';
	import { createPlaylist } from '$lib/client/playlists.svelte';
	import { formatDuration } from '$lib/client/format';
	import type { Song } from '$lib/types';

	/** What one request asks for and one playlist holds; see `MAX_IMPORT_TRACKS`. */
	const MAX_TRACKS = 1000;

	interface Row {
		wanted: FileTrack;
		song: Song | null;
		quality: 'exact' | 'loose' | 'none';
		keep: boolean;
	}

	let playlists = $state<FilePlaylist[]>([]);
	let chosen = $state(0);
	let name = $state('');
	let error = $state<string | null>(null);
	let busy = $state<'reading' | 'matching' | 'saving' | null>(null);
	let report = $state<Row[] | null>(null);

	const tracks = $derived(playlists[chosen]?.tracks ?? []);
	const found = $derived(report?.filter((row) => row.quality === 'exact') ?? []);
	const close = $derived(report?.filter((row) => row.quality === 'loose') ?? []);
	const missing = $derived(report?.filter((row) => row.quality === 'none') ?? []);
	const kept = $derived(report?.filter((row) => row.song && row.keep) ?? []);

	async function pick(event: Event) {
		const file = (event.currentTarget as HTMLInputElement).files?.[0];
		if (!file) return;
		busy = 'reading';
		error = null;
		report = null;
		playlists = [];
		try {
			playlists = readPlaylistFile(decode(await file.arrayBuffer()), file.name);
			chosen = 0;
			name = playlists[0].name;
		} catch (err) {
			error = err instanceof Error ? err.message : 'The file could not be read.';
		} finally {
			busy = null;
		}
	}

	function choose(index: number) {
		chosen = index;
		name = playlists[index]?.name ?? name;
		report = null;
	}

	async function match() {
		busy = 'matching';
		error = null;
		const asked = tracks.slice(0, MAX_TRACKS);
		try {
			const response = await fetch('/api/playlists/match', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ tracks: asked })
			});
			if (!response.ok) {
				const payload = (await response.json().catch(() => null)) as { message?: string } | null;
				throw new Error(payload?.message ?? `The music server could not be searched (${response.status}).`);
			}
			const { matches } = (await response.json()) as { matches: { song: Song | null; quality: Row['quality'] }[] };
			report = asked.map((wanted, index) => ({ wanted, ...matches[index], keep: matches[index].song !== null }));
		} catch (err) {
			error = err instanceof Error ? err.message : 'The music server could not be searched.';
		} finally {
			busy = null;
		}
	}

	async function save() {
		const title = name.trim();
		if (!title || kept.length === 0) return;
		busy = 'saving';
		error = null;
		try {
			const id = await createPlaylist(title.slice(0, 200), kept.map((row) => row.song!.id));
			await goto(`/playlists/${id}`);
		} catch (err) {
			error = err instanceof Error ? err.message : 'The playlist could not be saved.';
			busy = null;
		}
	}

	const described = (track: FileTrack) => [track.artist, track.album].filter(Boolean).join(' · ');
</script>

<svelte:head>
	<title>Import a playlist · Heddohon</title>
</svelte:head>

<div class="page">
	<header>
		<span class="hh-eyebrow"><a href="/playlists">Playlists</a></span>
		<h1>Import a playlist</h1>
		<p class="hh-muted lede">
			From an M3U file, a CSV or text export (Exportify, Apple Music, Heddohon), Spotify's account data
			(<code>Playlist1.json</code>) or an Apple Music XML export. Each track is looked for in your library by
			its title, artist, album and length, and you see what was found before the playlist is saved.
		</p>
	</header>

	<label class="file hh-button">
		<Icon name="plus" size={16} />
		{busy === 'reading' ? 'Reading…' : playlists.length > 0 ? 'Choose another file' : 'Choose a file'}
		<input
			class="hh-visually-hidden"
			type="file"
			accept=".m3u,.m3u8,.csv,.tsv,.txt,.json,.xml,audio/x-mpegurl,text/csv,application/json,text/xml"
			onchange={pick}
		/>
	</label>

	{#if error}
		<p class="alert" role="alert">{error}</p>
	{/if}

	{#if playlists.length > 0}
		<section class="setup">
			{#if playlists.length > 1}
				<label class="field">
					<span>Playlist in the file</span>
					<select class="hh-input" value={String(chosen)} onchange={(event) => choose(Number(event.currentTarget.value))}>
						{#each playlists as playlist, index (index)}
							<option value={String(index)}>{playlist.name} ({playlist.tracks.length})</option>
						{/each}
					</select>
				</label>
			{/if}
			<label class="field">
				<span>Name</span>
				<input class="hh-input" bind:value={name} maxlength="200" autocomplete="off" />
			</label>
			<p class="hh-muted count">
				{tracks.length.toLocaleString()} track{tracks.length === 1 ? '' : 's'} in the file{#if tracks.length > MAX_TRACKS}; the
					first {MAX_TRACKS.toLocaleString()} are looked for, as many as a playlist takes here{/if}.
			</p>
			{#if !report}
				<button class="hh-button hh-button--primary" type="button" onclick={match} disabled={busy !== null}>
					<Icon name="search" size={16} />
					{busy === 'matching' ? 'Looking in your library…' : 'Look for them in your library'}
				</button>
			{/if}
		</section>
	{/if}

	{#if report}
		<section class="report" aria-label="What was found">
			<p class="summary" role="status">
				{found.length.toLocaleString()} found, {close.length.toLocaleString()} close, {missing.length.toLocaleString()} not in
				your library.
			</p>

			{#snippet rows(list: Row[], heading: string, note: string)}
				{#if list.length > 0}
					<h2>{heading} <span class="hh-numeric hh-muted">{list.length}</span></h2>
					<p class="hh-muted note">{note}</p>
					<ul>
						{#each list as row, index (index)}
							<li class:none={!row.song}>
								{#if row.song}
									<input type="checkbox" bind:checked={row.keep} aria-label="Keep {row.song.title}" />
								{/if}
								<span class="wanted">
									<span class="title hh-truncate">{row.wanted.title}</span>
									<span class="sub hh-truncate hh-muted">{described(row.wanted)}</span>
								</span>
								{#if row.song}
									<span class="arrow" aria-hidden="true">→</span>
									<span class="song">
										<span class="title hh-truncate">{row.song.title}</span>
										<span class="sub hh-truncate hh-muted">
											{[row.song.artist, row.song.album, formatDuration(row.song.duration)].filter(Boolean).join(' · ')}
										</span>
									</span>
								{/if}
							</li>
						{/each}
					</ul>
				{/if}
			{/snippet}

			{@render rows(close, 'Close', 'The title matches with what is in brackets or after a dash left out, and the artist or the length agrees. Untick any that are another version.')}
			{@render rows(missing, 'Not in your library', 'Left out of the playlist.')}
			{@render rows(found, 'Found', 'The title, the artist and the length agree.')}

			<div class="save">
				<button
					class="hh-button hh-button--primary"
					type="button"
					onclick={save}
					disabled={busy !== null || kept.length === 0 || !name.trim()}
				>
					{busy === 'saving' ? 'Saving…' : `Save playlist (${kept.length.toLocaleString()} track${kept.length === 1 ? '' : 's'})`}
				</button>
				<button class="hh-button" type="button" onclick={() => (report = null)} disabled={busy !== null}>Back</button>
			</div>
		</section>
	{/if}
</div>

<style>
	.page {
		display: grid;
		gap: var(--space-5);
		max-width: 52rem;
	}

	header {
		display: grid;
		gap: var(--space-2);
		padding-bottom: var(--space-4);
		border-bottom: 1px solid var(--border-hairline);
	}

	h1 {
		margin: 0;
	}

	.lede {
		margin: 0;
		max-width: 60ch;
		font-size: 0.875rem;
	}

	.file {
		justify-self: start;
		cursor: pointer;
	}

	.file:focus-within {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}

	.setup {
		display: grid;
		gap: var(--space-3);
		justify-items: start;
	}

	.field {
		display: grid;
		gap: var(--space-1);
		width: min(100%, 28rem);
		font-size: 0.875rem;
	}

	.count,
	.note,
	.summary {
		margin: 0;
		font-size: 0.875rem;
	}

	.summary {
		color: var(--text-strong);
		font-weight: 600;
	}

	.report {
		display: grid;
		gap: var(--space-3);
	}

	h2 {
		margin: var(--space-3) 0 0;
		font-size: 1rem;
	}

	ul {
		display: grid;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	li {
		display: grid;
		grid-template-columns: 1.5rem minmax(0, 1fr) auto minmax(0, 1fr);
		align-items: center;
		gap: var(--space-3);
		padding: 0.45rem 0;
		border-top: 1px solid var(--border-hairline);
	}

	li.none {
		grid-template-columns: minmax(0, 1fr);
	}

	li input {
		accent-color: var(--accent);
	}

	.wanted,
	.song {
		display: grid;
		min-width: 0;
	}

	.title {
		color: var(--text-strong);
		font-size: 0.875rem;
	}

	.sub {
		font-size: 0.75rem;
	}

	.arrow {
		color: var(--text-faint);
	}

	.save {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
		padding-top: var(--space-3);
	}

	.alert {
		margin: 0;
		color: var(--danger);
		font-size: 0.875rem;
	}

	@media (max-width: 40rem) {
		li {
			grid-template-columns: 1.5rem minmax(0, 1fr);
		}

		.arrow {
			display: none;
		}

		.song {
			grid-column: 2;
		}
	}
</style>
