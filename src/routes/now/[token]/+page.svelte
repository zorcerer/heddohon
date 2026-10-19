<script lang="ts">
	/**
	 * What one account is playing, for an OBS browser source: the cover, the
	 * title, the artist and how far it has got, on a transparent page. It asks
	 * every 5 seconds and moves the bar on its own between. Nothing is drawn
	 * while nothing plays. See `nowplaying.ts`.
	 */
	import { onMount, untrack } from 'svelte';
	import type { NowPlaying } from '$lib/server/nowplaying';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const POLL_MS = 5000;

	// The first answer comes with the page; the polling below replaces it.
	let track = $state<NowPlaying>(untrack(() => data.first));
	/** When `track` was read, for the bar to move on from. */
	let readAt = $state(Date.now());
	let now = $state(Date.now());
	let coverFailed = $state(false);

	onMount(() => {
		const poll = setInterval(async () => {
			const response = await fetch(`/api/now-playing/${encodeURIComponent(data.token)}`, { cache: 'no-store' }).catch(() => null);
			if (!response?.ok) return;
			const next = (await response.json()) as NowPlaying;
			if (next.playing && (!track.playing || next.title !== track.title)) coverFailed = false;
			track = next;
			readAt = Date.now();
		}, POLL_MS);
		const tick = setInterval(() => (now = Date.now()), 500);
		return () => {
			clearInterval(poll);
			clearInterval(tick);
		};
	});

	const position = $derived(
		track.playing ? Math.min(track.duration || Infinity, track.position + (now - readAt) / 1000) : 0
	);
	const time = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
	/** The cover's address carries the track, so the picture changes with it. */
	const cover = $derived(
		track.playing && track.cover
			? `/api/now-playing/${encodeURIComponent(data.token)}/cover?size=384&for=${encodeURIComponent(track.title)}`
			: null
	);
</script>

<svelte:head>
	<title>{track.playing ? `${track.title}${track.artist ? ` · ${track.artist}` : ''}` : 'Nothing playing'}</title>
	<meta name="robots" content="noindex" />
</svelte:head>

{#if track.playing}
	<div class="now">
		{#if cover && !coverFailed}
			<img class="cover" src={cover} alt="" onerror={() => (coverFailed = true)} />
		{/if}
		<div class="text">
			<span class="title">{track.title}</span>
			{#if track.artist}<span class="artist">{track.artist}</span>{/if}
			{#if track.duration > 0}
				<div class="progress" aria-hidden="true">
					<span class="bar" style:width="{(position / track.duration) * 100}%"></span>
				</div>
				<span class="time">{time(position)} / {time(track.duration)}</span>
			{/if}
		</div>
	</div>
{/if}

<style>
	/*
	 * The page itself is see-through, for the stream behind it. A dark colour
	 * scheme on the root has the browser paint its own dark ground behind a
	 * see-through page, so the scheme is the plain one here.
	 */
	:global(html),
	:global(body) {
		background: transparent !important;
	}

	:global(html) {
		color-scheme: normal;
	}

	.now {
		display: flex;
		align-items: center;
		gap: 1rem;
		width: fit-content;
		max-width: calc(100vw - 2rem);
		margin: 1rem;
		padding: 0.75rem 1.25rem 0.75rem 0.75rem;
		border-radius: var(--r-lg);
		background: color-mix(in srgb, var(--bg-base) 82%, transparent);
		color: var(--text-strong);
	}

	.cover {
		flex: none;
		width: 5.5rem;
		height: 5.5rem;
		border-radius: var(--r-md);
		object-fit: cover;
	}

	.text {
		display: grid;
		gap: 0.2rem;
		min-width: 12rem;
	}

	.title,
	.artist {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.title {
		font-size: 1.25rem;
		font-weight: 700;
	}

	.artist {
		color: var(--text-muted);
		font-size: 1rem;
	}

	.progress {
		height: 4px;
		margin-top: 0.35rem;
		border-radius: 2px;
		background: color-mix(in srgb, var(--text-strong) 20%, transparent);
		overflow: hidden;
	}

	.bar {
		display: block;
		height: 100%;
		background: var(--accent);
	}

	.time {
		color: var(--text-muted);
		font-size: 0.8125rem;
		font-variant-numeric: tabular-nums;
	}
</style>
