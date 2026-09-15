<script lang="ts">
	/**
	 * Lyrics, in the player panel's stage.
	 *
	 * This was a floating sheet of its own. In the panel it takes the artwork's
	 * place the way the queue does, which is worth the change for a reason
	 * beyond tidiness: as a sheet it had to be positioned clear of the player's
	 * controls at every width, and on a narrow screen — where the player is
	 * itself a sheet over the page — it covered the transport of the track it
	 * was showing the words to.
	 *
	 * Three things went with the dialog and none is missed. Escape (the tool row
	 * closes it), a close button (likewise), and the expand/shrink toggle: the
	 * stage is a fixed area, so there is no longer a small size and a large one
	 * to choose between.
	 *
	 * Synced lyrics still follow playback, and clicking a timed line still seeks
	 * to it — which is what makes this a way of navigating a song rather than
	 * only of reading it.
	 */
	import { activeLineIndex, lyricsWindow } from '$lib/client/lyrics.svelte';
	import { player } from '$lib/client/player.svelte';
	import { formatDuration } from '$lib/client/format';
	import { prefersReducedMotion } from '$lib/client/sleeve-transition.svelte';

	let scroller = $state<HTMLElement | null>(null);
	/** Cleared a few seconds after the reader stops touching the lyrics. */
	let resumeTimer: ReturnType<typeof setTimeout> | null = null;

	const song = $derived(player.current);
	const active = $derived(activeLineIndex(lyricsWindow.lyrics, player.currentTime));

	// Follow the track: a new song while this is open loads its lyrics.
	$effect(() => {
		const current = player.current;
		if (lyricsWindow.open) void lyricsWindow.load(current);
	});

	/**
	 * Follow the playhead, centring the line being sung.
	 *
	 * `scrollIntoView` is the obvious call and the wrong one: it scrolls every
	 * scrollable ancestor, so following a lyric would also drag the library page
	 * behind the panel. This sets `scrollTop` on this container and nothing else.
	 */
	$effect(() => {
		if (active < 0 || !scroller || !lyricsWindow.following) return;
		const line = scroller.querySelector<HTMLElement>(`[data-line="${active}"]`);
		if (!line) return;
		const top = line.offsetTop - (scroller.clientHeight - line.offsetHeight) / 2;
		scroller.scrollTo({
			top: Math.max(0, top),
			behavior: prefersReducedMotion() ? 'auto' : 'smooth'
		});
	});

	/**
	 * Any deliberate scroll hands control to the reader. Following resumes on its
	 * own shortly after they stop, so looking back at a verse does not mean
	 * re-enabling anything by hand.
	 */
	function onUserScroll() {
		lyricsWindow.following = false;
		if (resumeTimer) clearTimeout(resumeTimer);
		resumeTimer = setTimeout(() => {
			lyricsWindow.following = true;
			resumeTimer = null;
		}, 6000);
	}

	$effect(() => () => {
		if (resumeTimer) clearTimeout(resumeTimer);
	});

	/**
	 * Jumping to a line is the opposite of reading ahead: the reader has just
	 * said where they want to be, so resume following immediately rather than
	 * letting the pointerdown that preceded the click suspend it for six seconds.
	 */
	function seekToLine(timeMs: number | null) {
		player.seek((timeMs ?? 0) / 1000);
		if (resumeTimer) clearTimeout(resumeTimer);
		resumeTimer = null;
		lyricsWindow.following = true;
	}
</script>

<div class="lyrics">
	<div class="head">
		<span class="hh-eyebrow">
			Lyrics{#if lyricsWindow.lyrics?.synced}&nbsp;· synced{/if}
		</span>
		{#if !lyricsWindow.following}
			<span class="hh-numeric hh-muted paused">following paused</span>
		{/if}
	</div>

	<!--
		Focusable on purpose. A plain (unsynced) sheet has no focusable children,
		so without a tab stop the scroll container is unreachable from the
		keyboard — which WCAG 2.1.1 does not allow for scrollable regions. The
		two rules below do not model scrollable regions, so they are wrong here.
	-->
	<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
	<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
	<div
		class="body"
		bind:this={scroller}
		role="region"
		aria-label="Lyrics"
		tabindex="0"
		onwheel={onUserScroll}
		ontouchmove={onUserScroll}
		onkeydown={onUserScroll}
		onpointerdown={onUserScroll}
	>
		{#if lyricsWindow.loading}
			<p class="notice hh-muted">Looking for lyrics…</p>
		{:else if lyricsWindow.error}
			<p class="notice" role="alert">{lyricsWindow.error}</p>
		{:else if !song}
			<p class="notice hh-muted">Play something to see its lyrics.</p>
		{:else if !lyricsWindow.lyrics || lyricsWindow.lyrics.lines.length === 0}
			<p class="notice hh-muted">
				Your music server has no lyrics for this track. Navidrome and Jellyfin both read them from
				the file's tags or a matching <code>.lrc</code>.
			</p>
		{:else}
			{@const lyrics = lyricsWindow.lyrics}
			<ol class="lines" class:synced={lyrics.synced}>
				{#each lyrics.lines as line, index (index)}
					<li data-line={index}>
						{#if lyrics.synced && line.timeMs !== null}
							<button
								class="line"
								class:active={index === active}
								class:past={index < active}
								onclick={() => seekToLine(line.timeMs)}
								title="Jump to {formatDuration((line.timeMs ?? 0) / 1000)}"
							>
								{line.text || '♪'}
							</button>
						{:else}
							<p class="line static">{line.text || ' '}</p>
						{/if}
					</li>
				{/each}
			</ol>
		{/if}
	</div>
</div>

<style>
	.lyrics {
		display: flex;
		flex-direction: column;
		min-height: 0;
		gap: var(--space-2);
		/* The artwork bleeds to the panel's edges; text must not. */
		padding: var(--space-4) var(--space-4) 0;
	}

	.head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: var(--space-3);
		padding-bottom: var(--space-2);
		border-bottom: 1px solid var(--border-hairline);
	}

	.paused {
		font-size: 0.6875rem;
	}

	.body {
		overflow-y: auto;
		min-height: 0;
		flex: 1;
	}

	.notice {
		margin: 0;
		padding: var(--space-5) 0;
		text-align: center;
		font-size: 0.875rem;
	}

	.lines {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 0.1rem;
	}

	.line {
		display: block;
		width: 100%;
		text-align: left;
		padding: 0.25rem 0.4rem;
		border-radius: var(--r-sm);
		/* A column this narrow wants shorter lines than the old sheet's did. */
		font-size: 0.9375rem;
		line-height: 1.5;
		color: var(--text-muted);
		transition:
			color var(--transition),
			background var(--transition);
	}

	.line.static {
		margin: 0;
		color: var(--text-default);
	}

	/* Synced lyrics dim what has gone by and lift what is being sung, so the eye
	   finds its place without hunting. */
	.synced .line.past {
		color: var(--text-faint);
	}

	.synced .line.active {
		color: var(--text-strong);
		font-weight: 600;
		background: color-mix(in srgb, hsl(var(--art-h) var(--art-s) var(--art-l)) 16%, transparent);
	}

	.synced button.line:hover {
		color: var(--glow-color);
		text-shadow: var(--glow-text);
	}

	@media (prefers-reduced-motion: reduce) {
		.body {
			scroll-behavior: auto;
		}
	}
</style>
