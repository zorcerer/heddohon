<script lang="ts">
	/**
	 * The living-room screen: what this browser plays, full screen, to be read
	 * from across a room on a TV or a tablet by the speakers. It plays here; a
	 * phone controls it through the Devices button.
	 *
	 * The layout draws this without the rail and the player panel
	 * (`isScreenPage`), and leaves the keys to this page.
	 */
	import { goto } from '$app/navigation';
	import Cover from '$lib/components/Cover.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import { player } from '$lib/client/player.svelte';
	import { activeLineIndex, lyricsWindow } from '$lib/client/lyrics.svelte';
	import { formatDuration } from '$lib/client/format';

	/** How long the pointer may rest before it and the way out are hidden. */
	const IDLE_MS = 3000;
	/** One press of up or down on a remote. */
	const VOLUME_STEP = 0.05;

	const song = $derived(player.current);
	const next = $derived(player.upNext);
	const progress = $derived(player.duration > 0 ? Math.min(1, player.currentTime / player.duration) : 0);

	// The lyrics of the track, loaded without opening the lyrics panel. Only
	// synced lyrics are shown: an unsynced sheet has no line to put on screen.
	$effect(() => {
		void lyricsWindow.load(song);
	});
	const lyrics = $derived(lyricsWindow.songId === song?.id ? lyricsWindow.lyrics : null);
	const line = $derived(activeLineIndex(lyrics, player.currentTime));
	const nowLine = $derived(lyrics?.synced && line >= 0 ? lyrics.lines[line].text : null);
	const nextLine = $derived(lyrics?.synced ? (lyrics.lines[line + 1]?.text ?? null) : null);

	let idle = $state(false);
	let idleTimer: ReturnType<typeof setTimeout> | null = null;
	function wake() {
		idle = false;
		if (idleTimer) clearTimeout(idleTimer);
		idleTimer = setTimeout(() => (idle = true), IDLE_MS);
	}
	$effect(() => {
		wake();
		return () => {
			if (idleTimer) clearTimeout(idleTimer);
		};
	});

	function onKeydown(event: KeyboardEvent) {
		if (event.altKey || event.ctrlKey || event.metaKey) return;
		const actions: Record<string, () => void> = {
			' ': () => void player.toggle(),
			Enter: () => void player.toggle(),
			ArrowLeft: () => void player.previous(),
			ArrowRight: () => void player.next(),
			ArrowUp: () => player.setVolume(player.volume + VOLUME_STEP),
			ArrowDown: () => player.setVolume(player.volume - VOLUME_STEP),
			Escape: () => void goto('/'),
			f: () => void fullscreen()
		};
		const action = actions[event.key];
		if (!action) return;
		// A focused link (the way out) keeps Enter for itself.
		if (event.key === 'Enter' && (event.target as HTMLElement | null)?.closest('a, button')) return;
		event.preventDefault();
		wake();
		action();
	}

	async function fullscreen() {
		if (document.fullscreenElement) await document.exitFullscreen().catch(() => undefined);
		else await document.documentElement.requestFullscreen?.().catch(() => undefined);
	}

	/*
	 * The screen stays on while something plays, where the browser can hold a
	 * wake lock (Chrome 84, Safari 16.4, Firefox 126). The browser drops the
	 * lock when the page is hidden, so it is asked for again on return.
	 */
	$effect(() => {
		if (!player.engaged || !('wakeLock' in navigator)) return;
		let lock: WakeLockSentinel | null = null;
		let gone = false;
		const hold = async () => {
			if (gone || document.visibilityState !== 'visible') return;
			lock = await navigator.wakeLock.request('screen').catch(() => null);
		};
		void hold();
		document.addEventListener('visibilitychange', hold);
		return () => {
			gone = true;
			document.removeEventListener('visibilitychange', hold);
			void lock?.release().catch(() => undefined);
		};
	});
</script>

<svelte:head>
	<title>{song ? `${song.title} · ${song.artist ?? ''}` : 'Now playing'} · Heddohon</title>
</svelte:head>

<svelte:window onkeydown={onKeydown} onpointermove={wake} onpointerdown={wake} />

<div class="screen" class:idle>
	<div class="hh-ambience" aria-hidden="true"></div>

	<a class="leave" href="/" title="Leave the screen (Esc)">
		<Icon name="chevron-left" size={18} />
		<span>Library</span>
	</a>

	{#if song}
		<main class="stage">
			<div class="art">
				<Cover coverArt={song.coverArt} size={1024} alt="Cover of {song.album ?? song.title}" radius="var(--r-xl)" layered fill />
			</div>

			<div class="info">
				<span class="hh-eyebrow">{player.engaged ? 'Now playing' : 'Paused'}</span>
				<h1 class="title hh-display hh-clamp-2">{song.title}</h1>
				<p class="artist hh-truncate">{song.artist ?? 'Unknown artist'}</p>
				{#if song.album}
					<p class="album hh-truncate hh-muted">{song.album}{song.year ? ` · ${song.year}` : ''}</p>
				{/if}

				<div class="position" role="progressbar" aria-label="Position in the track" aria-valuemin={0} aria-valuemax={Math.round(player.duration)} aria-valuenow={Math.round(player.currentTime)}>
					<div class="bar"><span style="width: {progress * 100}%"></span></div>
					<div class="times hh-numeric">
						<span>{formatDuration(player.currentTime)}</span>
						<span>−{formatDuration(Math.max(0, player.duration - player.currentTime))}</span>
					</div>
				</div>

				{#if nowLine !== null || nextLine !== null}
					<div class="lyrics" aria-live="off">
						<p class="now">{nowLine ?? '♪'}</p>
						{#if nextLine}<p class="next">{nextLine}</p>{/if}
					</div>
				{/if}

				{#if next}
					<p class="up-next">
						<span class="hh-eyebrow">Up next</span>
						<span class="hh-truncate">{next.title}{next.artist ? ` · ${next.artist}` : ''}</span>
					</p>
				{/if}
			</div>
		</main>
	{:else}
		<main class="stage empty">
			<h1 class="hh-display">Nothing playing</h1>
			<p class="hh-muted">
				Start something from another browser with Devices, or leave the screen to pick from the library.
			</p>
		</main>
	{/if}

	<p class="keys hh-muted">Enter plays and pauses · ← → skip · ↑ ↓ volume · F full screen · Esc leaves</p>
</div>

<style>
	.screen {
		position: fixed;
		inset: 0;
		display: grid;
		grid-template-rows: auto minmax(0, 1fr) auto;
		padding: clamp(1rem, 3vw, 3rem);
		color: var(--text-strong);
		overflow: hidden;
	}

	.screen.idle {
		cursor: none;
	}

	.hh-ambience {
		position: absolute;
		inset: 0;
		z-index: -1;
	}

	.leave {
		justify-self: start;
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
		padding: 0.4rem 0.8rem 0.4rem 0.5rem;
		border-radius: var(--r-pill);
		color: var(--text-muted);
		text-decoration: none;
		transition: opacity var(--dur-state) var(--ease-out);
	}

	.leave:hover,
	.leave:focus-visible {
		color: var(--glow-color);
	}

	.keys {
		justify-self: center;
		margin: 0;
		font-size: 0.8125rem;
		transition: opacity var(--dur-state) var(--ease-out);
	}

	.idle .leave,
	.idle .keys {
		opacity: 0;
	}

	.stage {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(0, 1.1fr);
		align-items: center;
		gap: clamp(1.5rem, 5vw, 5rem);
		min-height: 0;
	}

	.art {
		justify-self: end;
		width: min(100%, 72vh);
		aspect-ratio: 1;
		box-shadow: var(--shadow-high);
		border-radius: var(--r-xl);
	}

	.info {
		display: grid;
		gap: 0.6rem;
		min-width: 0;
		max-width: 44rem;
	}

	.title {
		margin: 0;
		font-size: clamp(2.25rem, 1rem + 4vw, 5.5rem);
		/* The two-line clamp cuts at the line box; at 1 it took the descenders. */
		line-height: 1.1;
		text-shadow: var(--text-shade);
	}

	.artist {
		margin: 0;
		font-size: clamp(1.25rem, 0.8rem + 1.6vw, 2.5rem);
		font-weight: 600;
	}

	.album {
		margin: 0;
		font-size: clamp(1rem, 0.7rem + 0.9vw, 1.6rem);
	}

	.position {
		margin-top: var(--space-4);
		display: grid;
		gap: var(--space-2);
	}

	.bar {
		height: 0.4rem;
		border-radius: var(--r-pill);
		background: color-mix(in srgb, var(--text-strong) 18%, transparent);
		overflow: hidden;
	}

	.bar span {
		display: block;
		height: 100%;
		background: var(--glow-color);
		transition: width 250ms linear;
	}

	.times {
		display: flex;
		justify-content: space-between;
		font-size: clamp(0.875rem, 0.6rem + 0.6vw, 1.25rem);
		color: var(--text-muted);
	}

	.lyrics {
		margin-top: var(--space-5);
		display: grid;
		gap: 0.4rem;
	}

	.lyrics p {
		margin: 0;
	}

	.lyrics .now {
		font-size: clamp(1.5rem, 0.8rem + 2vw, 3rem);
		font-weight: 700;
		line-height: 1.15;
	}

	.lyrics .next {
		font-size: clamp(1.1rem, 0.6rem + 1.2vw, 2rem);
		color: var(--text-muted);
	}

	.up-next {
		margin: var(--space-5) 0 0;
		display: grid;
		gap: 0.2rem;
		font-size: clamp(1rem, 0.7rem + 0.8vw, 1.5rem);
		color: var(--text-muted);
	}

	.stage.empty {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		place-content: center;
		text-align: center;
		gap: var(--space-3);
	}

	.stage.empty h1 {
		margin: 0;
		font-size: clamp(2rem, 1rem + 3vw, 4rem);
	}

	/* Upright, a tablet or a phone on a stand: the cover over the words. */
	@media (orientation: portrait) {
		.stage {
			grid-template-columns: minmax(0, 1fr);
			align-content: center;
		}

		.art {
			justify-self: center;
			width: min(100%, 48vh);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.bar span,
		.leave,
		.keys {
			transition: none;
		}
	}
</style>
