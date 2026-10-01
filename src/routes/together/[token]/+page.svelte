<script lang="ts">
	/**
	 * A listen-together link: what the host plays, at the same moment, for a
	 * visitor with no account. `server/together.ts` has how it works.
	 *
	 * The page follows the host from the moment it opens; the sound starts on
	 * "Join", since a browser plays nothing a visitor has not pressed for.
	 * From then the audio follows each report: the track, playing or paused,
	 * and the position, corrected when it has drifted more than 0.75 seconds.
	 */
	import { onMount, untrack } from 'svelte';
	import { colorOfImage, DEFAULT_ARTWORK_COLOR, holdArtworkColor } from '$lib/client/artwork';
	import { formatDuration } from '$lib/client/format';
	import Reactions from '$lib/components/Reactions.svelte';
	import type { FloatingReaction } from '$lib/client/together.svelte';
	import type { PartyState } from '$lib/server/together';
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
		if (!current || ended) {
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
		await follow();
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
		source.addEventListener('hello', (event) => (listenerId = JSON.parse((event as MessageEvent).data).id));
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

		{#if ended}
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

		{#if !ended}
			<div class="controls">
				{#if !joined}
					<button class="hh-button hh-button--primary join" onclick={join}>Join</button>
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

	@media (max-width: 44rem) {
		.stage {
			grid-template-columns: minmax(0, 20rem);
			gap: var(--space-5);
		}
	}
</style>
