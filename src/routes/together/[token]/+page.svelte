<script lang="ts">
	/**
	 * A listen-together link: what the host plays, at the same moment, for a
	 * visitor with no account. `server/together.ts` has how it works.
	 *
	 * The page follows the host from the moment it opens. The sound starts on
	 * "Join", since a browser plays nothing a visitor has not pressed for. From
	 * then the audio follows each report: the track, playing or paused, and the
	 * position, corrected when it has drifted more than 0.75 seconds.
	 *
	 * A visitor signed in on the host's music server joins as a member with the
	 * same press: shown to the host by name, with a search of their own library
	 * and an Add button on each result. Everyone sees what is up next and who
	 * added it, and a member can take back a track of their own.
	 *
	 * Where guests are switched on (`HEDDOHON_TOGETHER_GUESTS`, `data.guests`),
	 * anyone else joins as a guest under a name they type, and otherwise only
	 * listens. While the host lets
	 * the party add, a guest looks through the host's library
	 * (`TogetherLibrary`) and adds from it; `server/together-guests.ts` has how.
	 * The artist and the album of what plays then open in that library.
	 */
	import { onMount, untrack } from 'svelte';
	import { colorOfImage, DEFAULT_ARTWORK_COLOR, holdArtworkColor } from '#lib/client/artwork.ts';
	import { formatDuration } from '#lib/client/format.ts';
	import Reactions from '#lib/components/Reactions.svelte';
	import type { FloatingReaction } from '#lib/client/together.svelte.ts';
	import type { MemberView, PartyState, QueueRow } from '#lib/server/together.ts';
	import ElasticSlider from '#lib/components/bits/ElasticSlider.svelte';
	import TogetherLibrary from '#lib/components/TogetherLibrary.svelte';
	import type { PartyAccessMode } from '#lib/server/together.ts';
	import { guestVolume, keepGuestVolume, volumeSettable } from '#lib/client/guest-volume.ts';
	import type { Song } from '#lib/types.ts';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	/** Past this, the audio is moved to where the host is. */
	const DRIFT_S = 0.75;
	const REACTION_MS = 2400;
	/** The least time between two loads of a track whose load failed, so an offline page does not ask every second. */
	const RELOAD_GAP_MS = 3000;
	let lastReload = 0;

	// Where it starts; the event stream keeps it current.
	let current = $state<PartyState | null>(untrack(() => data.state));
	let listeners = $state(0);
	let ended = $state(false);
	let joined = $state(false);
	let listenerId: string | null = null;
	/** What the party is shown as the sender of this page's reactions; the id is kept to this page. */
	let listenerTag: string | null = null;
	let skew = 0;
	let audio = $state<HTMLAudioElement | null>(null);
	let position = $state(0);
	/* The guest's level, kept in this browser and shared with shared links (#297). */
	let volume = $state(1);
	let canSetVolume = $state(true);
	let reactions = $state<FloatingReaction[]>([]);
	let reactionKey = 0;
	let problem = $state<string | null>(null);

	// What is up next, as the host's queue has it; the event stream keeps it current.
	let queue = $state<QueueRow[]>(untrack(() => data.queue));
	let queueTotal = $state(untrack(() => data.queueTotal));
	/** Whether this visitor's account may join as a member, and the member it is once it has. */
	const mayAdd = $derived(data.viewer?.standing === 'member');
	/** Whether this visitor, without an account here, joins as a guest under a name; else it only listens. */
	const asGuest = $derived(!mayAdd && data.guests);
	let member = $state<MemberView | null>(null);
	let removed = $state(false);
	let query = $state('');
	let results = $state<Song[]>([]);
	let searched = $state(false);
	let searching = $state(false);
	let note = $state<{ text: string; failed: boolean } | null>(null);
	/** What the host lets the party do; the event stream keeps it current. */
	let access = $state<PartyAccessMode>(untrack(() => data.access));
	/** The name a guest joins under, remembered in this browser for the next party. */
	const NAME_KEY = 'heddohon.together.name';
	let guestName = $state(untrack(() => data.viewer?.name ?? ''));

	const base = $derived(`/together/${data.token}`);
	const queueUrl = $derived(mayAdd ? `${base}/queue` : `${base}/guest/queue`);
	/** The guest's library, for the links on the artist and the album of what plays now. */
	let library = $state<ReturnType<typeof TogetherLibrary> | null>(null);
	let libraryAt = $state<HTMLElement | null>(null);
	const browsable = $derived(!!member && access === 'add' && !mayAdd);
	async function showInLibrary(kind: 'artist' | 'album') {
		if (!current || !library) return;
		const target = kind === 'artist' ? { id: current.artistId ?? null, name: current.artist } : { id: current.albumId ?? null, name: current.album };
		await library.show(kind, target);
		libraryAt?.scrollIntoView({ behavior: 'smooth', block: 'start' });
	}
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
		} else if (element.error && element.networkState === HTMLMediaElement.NETWORK_NO_SOURCE) {
			/*
			 * The track's load failed: the connection dropped as the host moved
			 * on, and the page was told of the new track and could not fetch it.
			 * The element stays in that error and refuses every play() until it
			 * is loaded again, and Join pressed again went through here to the
			 * same refusal. Measured on Chromium and Firefox after 8 seconds
			 * offline: silent until the page was reloaded.
			 */
			if (Date.now() - lastReload < RELOAD_GAP_MS) return;
			lastReload = Date.now();
			element.load();
			element.currentTime = expected();
		} else if (Math.abs(element.currentTime - expected()) > DRIFT_S) {
			element.currentTime = expected();
		}
		if (current.playing && element.paused) {
			await element
				.play()
				.then(() => (problem = null))
				.catch((err) => {
					// A failed load is loaded again on the next second; only a refusal of the browser's own is the visitor's to fix.
					if (err instanceof DOMException && err.name === 'NotAllowedError') problem = 'This browser would not start the sound. Press Join again.';
				});
		} else if (!current.playing && !element.paused) {
			element.pause();
		}
	}

	async function join(event?: SubmitEvent) {
		event?.preventDefault();
		if (asGuest && !guestName.trim()) {
			problem = 'Type a name to join.';
			return;
		}
		if (asGuest) {
			try {
				localStorage.setItem(NAME_KEY, guestName.trim());
			} catch {
				// Not kept; asked again next time.
			}
		}
		joined = true;
		problem = null;
		// Started before anything is awaited: the press is what lets the sound start.
		const following = follow();
		await enrol();
		await following;
	}

	/**
	 * Makes this page's stream a member's, once the visitor has pressed Join.
	 * Asked again when the stream reopens: the server knows a member's page by
	 * its stream.
	 */
	async function enrol() {
		if (!joined || !listenerId) return;
		if (!mayAdd) return asGuest ? enrolGuest() : undefined;
		const response = await fetch(`${base}/join`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ listener: listenerId })
		}).catch(() => null);
		if (response?.ok) member = (await response.json()).member as MemberView;
	}

	/** As `enrol`, for a guest: the name goes to the host, and the server keeps the guest's key in a cookie. */
	async function enrolGuest() {
		const response = await fetch(`${base}/guest`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ listener: listenerId, name: guestName })
		}).catch(() => null);
		if (response?.ok) member = (await response.json()).member as MemberView;
		else if (response) problem = (await response.json().catch(() => null))?.message ?? 'You could not join under that name.';
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

	async function add(song: Pick<Song, 'id' | 'title'>) {
		const response = await fetch(queueUrl, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ songId: song.id })
		}).catch(() => null);
		note = response?.ok
			? { text: `${song.title} was added.`, failed: false }
			: { text: (await response?.json().catch(() => null))?.message ?? 'The track could not be added.', failed: true };
	}

	async function takeBack(row: QueueRow) {
		await fetch(queueUrl, {
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
		if (asGuest && !guestName) {
			try {
				guestName = localStorage.getItem(NAME_KEY) ?? '';
			} catch {
				// Typed again.
			}
		}
		volume = guestVolume();
		canSetVolume = volumeSettable();
		const source = new EventSource(`${base}/events`);
		source.addEventListener('hello', (event) => {
			({ id: listenerId, tag: listenerTag } = JSON.parse((event as MessageEvent).data));
			void enrol();
		});
		source.addEventListener('queue', (event) => {
			const message = JSON.parse((event as MessageEvent).data) as { queue: QueueRow[]; total: number };
			queue = message.queue;
			queueTotal = message.total;
		});
		// The host removed this account: the stream is closed from the other end
		// and is not opened again.
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
		source.addEventListener('access', (event) => (access = JSON.parse((event as MessageEvent).data).access as PartyAccessMode));
		source.addEventListener('listeners', (event) => (listeners = JSON.parse((event as MessageEvent).data).count));
		source.addEventListener('reaction', (event) => {
			const message = JSON.parse((event as MessageEvent).data) as { emoji: string; from: string };
			// This browser's own shows when it is pressed.
			if (message.from !== listenerTag) float(message.emoji);
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
		if (audio) audio.volume = volume * data.volumeLimit;
	});

	/*
	 * The room takes its colour from the cover. The first cover is in the
	 * server's HTML and has usually loaded before this script runs, so a load
	 * handler alone missed it.
	 */
	let cover = $state<HTMLImageElement | null>(null);
	$effect(() => {
		const image = cover;
		if (!image || !coverUrl) return;
		// Held, as on the shared-link page: the layout's tint resolves an empty
		// cover a moment later and would put the room back to neutral.
		const tint = () => holdArtworkColor(document.documentElement, colorOfImage(image) ?? DEFAULT_ARTWORK_COLOR);
		// A frame late, as on the shared-link page: the layout's tint runs after
		// this page mounts, and a colour held sooner was taken back.
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
		{:else if ended}
			<h1 class="hh-display">It has ended</h1>
		{:else if current}
			<h1 class="hh-display hh-clamp-2">{current.title}</h1>
			{#if browsable && current.artistId}
				<button class="artist hh-truncate jump" onclick={() => showInLibrary('artist')}>{current.artist ?? 'Unknown artist'}</button>
			{:else}
				<p class="artist hh-truncate">{current.artist ?? 'Unknown artist'}</p>
			{/if}
			{#if current.album && browsable && current.albumId}
				<button class="album hh-muted hh-truncate jump" onclick={() => showInLibrary('album')}>{current.album}</button>
			{:else if current.album}<p class="hh-muted hh-truncate">{current.album}</p>{/if}
			<p class="time hh-numeric hh-muted">
				{current.playing ? '' : 'Paused · '}{formatDuration(position)} / {formatDuration(current.duration)}
			</p>
		{:else}
			<h1 class="hh-display">Waiting for the host</h1>
		{/if}

		{#if !ended && !removed}
			<div class="controls">
				{#if !joined && mayAdd}
					<button class="hh-button hh-button--primary join" onclick={() => join()}>Join as {data.viewer?.name}</button>
				{:else if !joined && asGuest}
					<form class="guest" onsubmit={join}>
						<input
							class="hh-input"
							bind:value={guestName}
							maxlength="32"
							autocomplete="nickname"
							placeholder="Your name"
							aria-label="Your name, shown to the others"
						/>
						<button class="hh-button hh-button--primary join">Join</button>
					</form>
				{:else if !joined}
					<button class="hh-button hh-button--primary join" onclick={() => join()}>Join</button>
				{:else}
					{#if canSetVolume}
						<span class="volume">
							<ElasticSlider
								swell={false}
								bind:value={volume}
								startingValue={0}
								maxValue={1}
								isStepped
								stepSize={0.05}
								label="Volume"
								onchange={keepGuestVolume}
							/>
						</span>
					{/if}
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
			{#if member && access === 'add' && !mayAdd}
				{#if note}<p class="note" class:failed={note.failed} role="status">{note.text}</p>{/if}
				<div class="library-at" bind:this={libraryAt}>
					<TogetherLibrary bind:this={library} {base} onadd={add} />
				</div>
			{:else if member && access === 'add'}
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

	.guest {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
	}

	.guest .hh-input {
		flex: 1 1 10rem;
		min-width: 0;
		max-width: 16rem;
		border-radius: var(--r-pill);
		padding-inline: 1rem;
	}

	/* The artist and the album of what plays now open in the library below, for a guest who may look through it. */
	.jump {
		display: block;
		max-width: 100%;
		padding: 0;
		text-align: left;
		cursor: pointer;
	}

	.jump.artist {
		font-size: 1.25rem;
		font-weight: 600;
		color: var(--text-strong);
	}

	.jump:hover,
	.jump:focus-visible {
		color: var(--glow-color);
		text-decoration: underline;
		text-underline-offset: 3px;
	}

	.library-at {
		scroll-margin-top: var(--space-5);
		min-width: 0;
	}

	.volume {
		display: block;
		width: min(100%, 14rem);
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
