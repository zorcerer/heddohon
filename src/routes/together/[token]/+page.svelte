<script lang="ts">
	/**
	 * A listen-together link: what the host plays, at the same moment, for a
	 * visitor with no account. `server/together.ts` has how it works.
	 *
	 * The page follows the host from the moment it opens; the sound starts on
	 * "Join", since a browser plays nothing a visitor has not pressed for.
	 * From then the audio follows each report: the track, playing or paused,
	 * and the position, corrected when it has drifted more than 0.75 seconds.
	 *
	 * A visitor signed in on the host's music server joins as a member with
	 * the same press: shown to the host by name, with a search of their own
	 * library and an Add button on each result. Everyone sees what is up next
	 * and who added it; a member can take back a track of their own.
	 */
	import { onMount, untrack } from 'svelte';
	import { colorOfImage, DEFAULT_ARTWORK_COLOR, holdArtworkColor } from '$lib/client/artwork';
	import { formatDuration } from '$lib/client/format';
	import Reactions from '$lib/components/Reactions.svelte';
	import type { FloatingReaction } from '$lib/client/together.svelte';
	import type { MemberView, PartyState, QueueRow } from '$lib/server/together';
	import type { Song } from '$lib/types';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	/** Past this, the audio is moved to where the host is. */
	const DRIFT_S = 0.75;
	const REACTION_MS = 2400;

	// Where it starts; the event stream keeps it current.
	let current = $state<PartyState | null>(untrack(() => data.state));
	let listeners = $state(0);
	let ended = $state(false);
	let joined = $state(false);
	let listenerId: string | null = null;
	let skew = 0;
	let audio = $state<HTMLAudioElement | null>(null);
	let position = $state(0);
	let volume = $state(1);
	let reactions = $state<FloatingReaction[]>([]);
	let reactionKey = 0;
	let problem = $state<string | null>(null);

	// What is up next, as the host's queue has it; the event stream keeps it current.
	let queue = $state<QueueRow[]>(untrack(() => data.queue));
	let queueTotal = $state(untrack(() => data.queueTotal));
	/** Whether this visitor's account may join as a member, and the member it is once it has. */
	const mayAdd = $derived(data.viewer?.standing === 'member');
	let member = $state<MemberView | null>(null);
	let removed = $state(false);
	let query = $state('');
	let results = $state<Song[]>([]);
	let searched = $state(false);
	let searching = $state(false);
	let note = $state<{ text: string; failed: boolean } | null>(null);

	const base = $derived(`/together/${data.token}`);
	const coverUrl = $derived(current?.coverArt ? `${base}/cover?song=${encodeURIComponent(current.songId)}&size=768` : null);

	/** Where the host is now, from its last report and this clock's offset from the server's. */
	function expected(): number {
		if (!current) return 0;
		const elapsed = current.playing ? Math.max(0, Date.now() - skew - current.at) / 1000 : 0;
		return Math.min(current.position + elapsed, current.duration || Infinity);
	}

	function float(emoji: string) {
		const key = ++reactionKey;
		reactions = [...reactions.slice(-11), { key, emoji }];
		setTimeout(() => (reactions = reactions.filter((reaction) => reaction.key !== key)), REACTION_MS);
	}

	/** Brings the audio to the host's track, the play state and the position. */
	async function follow() {
		const element = audio;
		if (!joined || !element) return;
		if (!current || ended || removed) {
			element.pause();
			return;
		}
		const src = `${base}/stream?song=${encodeURIComponent(current.songId)}`;
		if (element.getAttribute('src') !== src) {
			element.src = src;
			element.currentTime = expected();
		} else if (Math.abs(element.currentTime - expected()) > DRIFT_S) {
			element.currentTime = expected();
		}
		if (current.playing && element.paused) {
			await element.play().catch((err) => {
				if (!(err instanceof DOMException && err.name === 'AbortError')) problem = 'This browser would not start the sound. Press Join again.';
			});
		} else if (!current.playing && !element.paused) {
			element.pause();
		}
	}

	async function join() {
		joined = true;
		problem = null;
		// Started before anything is awaited: the press is what lets the sound start.
		const following = follow();
		await enrol();
		await following;
	}

	/**
	 * Makes this page's stream a member's, once the visitor has pressed Join.
	 * Asked again when the stream reopens, since the server knows a member's
	 * page by its stream.
	 */
	async function enrol() {
		if (!joined || !mayAdd || !listenerId) return;
		const response = await fetch(`${base}/join`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ listener: listenerId })
		}).catch(() => null);
		if (response?.ok) member = (await response.json()).member as MemberView;
	}

	async function search(event: SubmitEvent) {
		event.preventDefault();
		const wanted = query.trim();
		if (wanted.length < 2) return;
		searching = true;
		note = null;
		try {
			const response = await fetch(`/api/search?q=${encodeURIComponent(wanted)}`);
			if (!response.ok) throw new Error('search failed');
			results = (await response.json()).songs as Song[];
			searched = true;
		} catch {
			note = { text: 'The search did not come back. Try again.', failed: true };
		} finally {
			searching = false;
		}
	}

	async function add(song: Song) {
		const response = await fetch(`${base}/queue`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ songId: song.id })
		}).catch(() => null);
		note = response?.ok
			? { text: `${song.title} was added.`, failed: false }
			: { text: (await response?.json().catch(() => null))?.message ?? 'The track could not be added.', failed: true };
	}

	async function takeBack(row: QueueRow) {
		await fetch(`${base}/queue`, {
			method: 'DELETE',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ entry: row.entry })
		}).catch(() => undefined);
	}

	async function react(emoji: string) {
		if (!listenerId) return;
		float(emoji);
		await fetch(`${base}/react`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ listener: listenerId, emoji })
		}).catch(() => undefined);
	}

	onMount(() => {
		const source = new EventSource(`${base}/events`);
		source.addEventListener('hello', (event) => {
			listenerId = JSON.parse((event as MessageEvent).data).id;
			void enrol();
		});
		source.addEventListener('queue', (event) => {
			const message = JSON.parse((event as MessageEvent).data) as { queue: QueueRow[]; total: number };
			queue = message.queue;
			queueTotal = message.total;
		});
		// The host removed this account: the stream is closed from the other end
		// and is not to be opened again.
		source.addEventListener('removed', () => {
			removed = true;
			member = null;
			source.close();
			audio?.pause();
		});
		source.addEventListener('state', (event) => {
			const message = JSON.parse((event as MessageEvent).data) as { now: number; state: PartyState | null };
			skew = Date.now() - message.now;
			current = message.state;
			void follow();
		});
		source.addEventListener('listeners', (event) => (listeners = JSON.parse((event as MessageEvent).data).count));
		source.addEventListener('reaction', (event) => {
			const message = JSON.parse((event as MessageEvent).data) as { emoji: string; from: string };
			// This browser's own shows when it is pressed.
			if (message.from !== listenerId) float(message.emoji);
		});
		source.addEventListener('ended', () => {
			ended = true;
			source.close();
			audio?.pause();
		});
		// Drift is checked each second between reports, which come every 15.
		const drift = setInterval(() => {
			position = expected();
			void follow();
		}, 1000);
		return () => {
			source.close();
			clearInterval(drift);
		};
	});

	$effect(() => {
		if (audio) audio.volume = volume;
	});

	/*
	 * The room takes its colour from the cover. The first cover is in the
	 * server's HTML and has usually loaded before this page's script runs, so
	 * a load handler alone missed it.
	 */
	let cover = $state<HTMLImageElement | null>(null);
	$effect(() => {
		const image = cover;
		if (!image || !coverUrl) return;
		// Held, as the shared-link page does: the layout's own tint resolves an
		// empty cover a moment later and would put the room back to neutral.
		const tint = () => holdArtworkColor(document.documentElement, colorOfImage(image) ?? DEFAULT_ARTWORK_COLOR);
		// A frame late, as on the shared-link page: the layout's tint runs after
		// this page mounts, and a colour held sooner was taken straight back.
		const frame = requestAnimationFrame(() => {
			if (image.complete && image.naturalWidth > 0) tint();
		});
		image.addEventListener('load', tint);
		return () => {
			cancelAnimationFrame(frame);
			image.removeEventListener('load', tint);
		};
	});
</script>

<svelte:head>
	<title>{current ? `${current.title} · Listening together` : 'Listening together'} · Heddohon</title>
</svelte:head>

<div class="hh-ambience" aria-hidden="true"></div>
<Reactions {reactions} />

<main class="stage">
	<div class="art">
		{#if coverUrl}
			<img bind:this={cover} src={coverUrl} alt="" />
		{/if}
	</div>

	<section class="info">
		<p class="live hh-eyebrow"><span class="dot" aria-hidden="true"></span> Listening together{listeners > 0 ? ` · ${listeners} here` : ''}</p>

		{#if removed}
			<h1 class="hh-display">You were removed</h1>
			<p class="hh-muted">The host removed you from this listening session.</p>
		{:else if ended}
			<h1 class="hh-display">It has ended</h1>
			<p class="hh-muted">The host ended listening together, or it ran its course.</p>
		{:else if current}
			<h1 class="hh-display hh-clamp-2">{current.title}</h1>
			<p class="artist hh-truncate">{current.artist ?? 'Unknown artist'}</p>
			{#if current.album}<p class="hh-muted hh-truncate">{current.album}</p>{/if}
			<p class="time hh-numeric hh-muted">
				{current.playing ? '' : 'Paused · '}{formatDuration(position)} / {formatDuration(current.duration)}
			</p>
		{:else}
			<h1 class="hh-display">Waiting for the host</h1>
			<p class="hh-muted">Nothing is playing yet. The page follows as soon as it does.</p>
		{/if}

		{#if !ended && !removed}
			<div class="controls">
				{#if !joined}
					<button class="hh-button hh-button--primary join" onclick={join}>Join{mayAdd ? ` as ${data.viewer?.name}` : ''}</button>
					{#if mayAdd}
						<p class="hh-muted hint">Joining shows your name to the host, and to everyone here on the tracks you add.</p>
					{:else if data.viewer?.standing === 'listener'}
						<p class="hh-muted hint">Your account is on another music server than the host's, so you can listen here and not add tracks.</p>
					{/if}
				{:else}
					<label class="volume">
						<span class="hh-visually-hidden">Volume</span>
						<input type="range" min="0" max="1" step="0.05" bind:value={volume} />
					</label>
				{/if}
			</div>

			<div class="reacts" role="group" aria-label="Send a reaction">
				{#each data.reactions as emoji (emoji)}
					<button class="react" onclick={() => react(emoji)} aria-label="Send {emoji}">{emoji}</button>
				{/each}
			</div>
		{/if}

		{#if problem}<p class="problem" role="alert">{problem}</p>{/if}
	</section>

	{#if !ended && !removed}
		<section class="next">
			{#if member}
				<form class="search" role="search" onsubmit={search}>
					<input
						class="hh-input"
						type="search"
						bind:value={query}
						maxlength="200"
						placeholder="Search your library for a track to add"
						aria-label="Search your library"
					/>
					<button class="hh-button" disabled={searching}>Search</button>
				</form>
				{#if note}<p class="note" class:failed={note.failed} role="status">{note.text}</p>{/if}
				{#if results.length > 0}
					<ul class="rows found" aria-label="Search results">
						{#each results as song (song.id)}
							<li>
								<span class="text">
									<span class="title hh-truncate">{song.title}</span>
									<span class="sub hh-truncate hh-muted">{song.artist ?? 'Unknown artist'}</span>
								</span>
								<button class="hh-button" onclick={() => add(song)} aria-label="Add {song.title} to the queue">Add</button>
							</li>
						{/each}
					</ul>
				{:else if searched}
					<p class="hh-muted empty">Nothing found.</p>
				{/if}
			{/if}

			<h2 class="hh-eyebrow">Up next</h2>
			{#if queue.length === 0}
				<p class="hh-muted empty">Nothing is queued.</p>
			{:else}
				<ol class="rows" aria-label="Up next">
					{#each queue as row, i (row.entry ?? `host-${i}`)}
						<li>
							<span class="text">
								<span class="title hh-truncate">{row.title}</span>
								<span class="sub hh-truncate hh-muted">
									{row.artist ?? 'Unknown artist'}{#if row.by}{` · Added by ${row.by.id === member?.id ? 'you' : row.by.name}`}{/if}
								</span>
							</span>
							{#if row.entry && member && row.by?.id === member.id}
								<button class="hh-button" onclick={() => takeBack(row)} aria-label="Remove {row.title} from the queue">Remove</button>
							{/if}
						</li>
					{/each}
				</ol>
				{#if queueTotal > queue.length}<p class="hh-muted empty">and {queueTotal - queue.length} more</p>{/if}
			{/if}
		</section>
	{/if}
</main>

<audio class="together-audio" bind:this={audio} preload="auto"></audio>

<style>
	/* The room behind the page, coloured from the cover as it loads. */
	.hh-ambience {
		position: fixed;
		inset: 0;
	}

	.stage {
		position: relative;
		min-height: 100dvh;
		display: grid;
		grid-template-columns: minmax(0, 22rem) minmax(0, 26rem);
		align-items: center;
		justify-content: center;
		gap: var(--space-7);
		padding: var(--space-6) var(--space-5);
		padding-top: var(--bare-top);
		color: var(--text-default);
	}

	.art {
		aspect-ratio: 1;
		border-radius: var(--r-xl);
		overflow: hidden;
		background: var(--bg-sunken);
		box-shadow: var(--shadow-high);
	}

	.art img {
		width: 100%;
		height: 100%;
		object-fit: cover;
		display: block;
	}

	.info {
		display: grid;
		gap: 0.4rem;
		min-width: 0;
	}

	.live {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
	}

	.dot {
		width: 0.5rem;
		height: 0.5rem;
		border-radius: 50%;
		background: var(--danger);
	}

	h1 {
		margin: 0.2rem 0 0;
		font-size: clamp(2rem, 1.2rem + 2.4vw, 3rem);
		line-height: 1.1;
		color: var(--text-strong);
	}

	.artist {
		margin: 0;
		font-size: 1.25rem;
		font-weight: 600;
		color: var(--text-strong);
	}

	.info p {
		margin: 0;
	}

	.time {
		margin-top: var(--space-2) !important;
		font-size: 0.875rem;
	}

	.controls {
		margin-top: var(--space-4);
	}

	.join {
		padding: 0.7rem 1.6rem;
		border-radius: var(--r-pill);
		font-size: 1rem;
	}

	.volume input {
		width: min(100%, 14rem);
		accent-color: var(--glow-color);
	}

	.reacts {
		display: flex;
		gap: var(--space-2);
		margin-top: var(--space-3);
	}

	.react {
		display: grid;
		place-items: center;
		width: 2.75rem;
		height: 2.75rem;
		border-radius: 50%;
		border: 1px solid var(--border-hairline);
		background: var(--control-face);
		font-size: 1.25rem;
		transition: scale var(--dur-press) var(--ease-out);
	}

	.react:active {
		scale: 0.9;
	}

	.problem {
		color: var(--danger);
		font-size: 0.875rem;
	}

	.hint {
		margin-top: var(--space-2) !important;
		font-size: 0.8125rem;
		line-height: 1.5;
	}

	/* What is up next, and a member's search, under the track and across both columns. */
	.next {
		grid-column: 1 / -1;
		display: grid;
		gap: var(--space-3);
		min-width: 0;
	}

	.next h2,
	.next p {
		margin: 0;
	}

	.search {
		display: flex;
		gap: var(--space-2);
	}

	.search .hh-input {
		flex: 1;
		min-width: 0;
	}

	.rows {
		display: grid;
		gap: var(--space-2);
		margin: 0;
		padding: 0;
		list-style: none;
	}

	/* 24 results at most: five and a half rows show, and the rest scroll, so what is up next stays in reach. */
	.found {
		max-height: 15rem;
		overflow-y: auto;
		padding-right: var(--space-2);
	}

	.rows li {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-3);
		min-width: 0;
	}

	.rows .text {
		display: grid;
		min-width: 0;
	}

	.rows .title {
		color: var(--text-strong);
		font-size: 0.9375rem;
	}

	.rows .sub,
	.note,
	.empty {
		font-size: 0.8125rem;
	}

	.note.failed {
		color: var(--danger);
	}

	.next .hh-button {
		flex: none;
		padding: 0.4rem 0.8rem;
		border-radius: var(--r-md);
		font-size: 0.8125rem;
	}

	@media (max-width: 44rem) {
		.stage {
			grid-template-columns: minmax(0, 20rem);
			gap: var(--space-5);
		}
	}
</style>
