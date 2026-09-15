<script lang="ts">
	/**
	 * The player, as a panel down the right-hand side.
	 *
	 * This replaces the bottom bar. The bar laid the same controls out in one
	 * horizontal strip, which meant the artwork was a 48px thumbnail and the
	 * title had a third of a screen width to live in; a tall panel can give the
	 * cover the whole width and stack the metadata under it, which is what the
	 * reference for this design does.
	 *
	 * Two consequences of moving the player here are worth stating, because they
	 * are not cosmetic.
	 *
	 * It is open by default. A bottom bar is always visible, so scrapping it for
	 * something that hides would mean no play/pause on screen while you browse —
	 * every pause becoming find-the-button, then click. The panel is therefore
	 * docked, and the rail carries a toggle so closing it is deliberate.
	 *
	 * The queue lives inside it, swapped in where the artwork is, rather than as
	 * its own floating pane. Both wanted the right edge, and two slabs of glass
	 * fighting over it looked like a bug. The footer row is what switches them,
	 * which is also how the reference gets to its queue.
	 */
	import { player } from '$lib/client/player.svelte';
	import { handOff } from '$lib/client/handoff';
	import { formatDuration } from '$lib/client/format';
	import { lyricsWindow } from '$lib/client/lyrics.svelte';
	import { playlistPicker } from '$lib/client/playlists.svelte';
	import { prefersReducedMotion } from '$lib/client/sleeve-transition.svelte';
	import { cubicOut } from 'svelte/easing';
	import Cover from './Cover.svelte';
	import FavouriteButton from './FavouriteButton.svelte';
	import Icon from './Icon.svelte';
	import LyricsView from './LyricsView.svelte';
	import QualityBadge from './QualityBadge.svelte';
	import Seekbar from './Seekbar.svelte';

	let { showQualityBadge = true }: { showQualityBadge?: boolean } = $props();

	/**
	 * The lyrics arriving in the stage, and the artwork leaving under them.
	 *
	 * Opacity and a small vertical travel, and nothing else. A blur or a scale
	 * reads well on a laptop and costs a repaint of the whole stage per frame on
	 * a tablet, and every compositing layer built around this panel's
	 * `backdrop-filter` has been a source of artefacts on iOS.
	 *
	 * `distance` is in pixels and signed: the words come up from below, and go
	 * back down the way they came.
	 */
	function lift(node: Element, { duration = 260, distance = 14 } = {}) {
		if (prefersReducedMotion()) return { duration: 0 };
		return {
			duration,
			easing: cubicOut,
			css: (t: number, u: number) => `opacity: ${t}; transform: translate3d(0, ${u * distance}px, 0)`
		};
	}

	const song = $derived(player.current);

	let details = $state(false);
	/*
	 * Open by default. The panel is wide enough to hold the slider without
	 * taking the artwork's room, and a volume control you have to go and find
	 * is the one piece of transport that is worse for being tidied away.
	 */
	let volumeOpen = $state(true);

	/*
	 * The stage shows one thing at a time, so the two views that can take the
	 * artwork's place are mutually exclusive. Without this the tool row could
	 * light both buttons while only the first branch below was on screen — a
	 * control claiming to be on while showing nothing.
	 */
	function showQueue() {
		if (lyricsWindow.open) lyricsWindow.close();
		player.toggleQueuePanel();
	}

	function hidePanel() {
		player.togglePanel();
		// The sliver left behind on the right-hand edge is what reopens it, so
		// that is where the keyboard goes once this button is inert.
		void handOff('player-grip');
	}

	function showLyrics() {
		if (player.queueOpen) player.toggleQueuePanel();
		lyricsWindow.toggle(player.current);
	}

	const remaining = $derived(Math.max(0, player.duration - player.currentTime));
	const volumeIcon = $derived(
		player.muted || player.volume === 0 ? 'mute' : player.volume < 0.5 ? 'volume-low' : 'volume'
	);
	const queueTotal = $derived(player.queue.reduce((sum, track) => sum + track.duration, 0));

	const facts = $derived(
		song
			? [
					['Format', song.quality.format?.toUpperCase() ?? '—'],
					[
						'Depth and rate',
						song.quality.bitDepth && song.quality.sampleRateHz
							? `${song.quality.bitDepth}-bit · ${(song.quality.sampleRateHz / 1000).toFixed(1)} kHz`
							: '—'
					],
					['Bitrate', song.quality.bitrateKbps ? `${song.quality.bitrateKbps} kbps` : '—'],
					['Album', song.album ?? '—'],
					['Track', song.track ? String(song.track) : '—']
				]
			: []
	);
</script>

<aside class="panel hh-glass hh-glass--deep hh-tint-morph hh-float" aria-label="Now playing">
	<!-- The stage: artwork, or the queue in its place. -->
	<div class="stage">
		{#if lyricsWindow.open}
			<div
				class="layer lyrics-layer"
				in:lift={{ duration: 280, distance: 14 }}
				out:lift={{ duration: 190, distance: 10 }}
			>
				<LyricsView />
			</div>
		{:else if player.queueOpen}
			<div class="queue" aria-label="Play queue">
				<div class="queue-head">
					<span class="hh-eyebrow">Queue</span>
					<span class="hh-numeric hh-muted">
						{player.queue.length} · {formatDuration(queueTotal)}
					</span>
				</div>
				<!-- Focusable for the same reason as the library and the lyrics:
				     with no scrollbar, the keyboard is the pointer-free way to
				     scroll a long queue. -->
				<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
				<ol class="queue-list" tabindex="0">
					{#each player.queue as track, index (track.id + ':' + index)}
						<li>
							<div class="row" class:current={index === player.index} class:past={index < player.index}>
								<button class="row-art" onclick={() => player.jumpTo(index)} aria-label="Play {track.title}">
									<Cover coverArt={track.coverArt} size={96} alt="" radius="var(--r-sm)" />
									<span class="row-play"><Icon name="play" size={12} /></span>
								</button>
								<span class="row-text">
									<span class="row-title hh-truncate">{track.title}</span>
									<span class="row-sub hh-truncate hh-muted">{track.artist ?? 'Unknown artist'}</span>
								</span>
								<button
									class="row-remove"
									onclick={() => player.removeAt(index)}
									aria-label="Remove {track.title} from the queue"
									title="Remove"
								>
									<Icon name="close" size={13} />
								</button>
							</div>
						</li>
					{/each}
				</ol>
				{#if player.queue.length === 0}
					<p class="queue-empty hh-muted">The queue is empty.</p>
				{:else}
					<button class="queue-clear" onclick={() => player.clearQueue()}>
						<Icon name="trash" size={14} />
						Clear queue
					</button>
				{/if}
			</div>
		{:else}
			<a
				class="art layer"
				in:lift={{ duration: 220, distance: 0 }}
				out:lift={{ duration: 190, distance: 0 }}
				href={song?.albumId ? `/albums/${song.albumId}` : '#'}
				aria-label={song ? 'Open album' : 'Nothing playing'}
				aria-disabled={song?.albumId ? undefined : 'true'}
			>
				<!--
					The artwork runs into the panel's own top corners, so it carries
					their radius rather than borrowing the panel's clip. See the note
					on `img` in Cover.
				-->
				<Cover
					coverArt={song?.coverArt ?? null}
					size={768}
					alt=""
					radius="var(--r-xl) var(--r-xl) 0 0"
					hidpi
					fill
				/>
			</a>
		{/if}
	</div>

	<div class="chrome">
		<!-- Title block: the text, and the two round actions beside it. -->
		<div class="head">
			<div class="text">
				{#if song}
					<h2 class="title hh-clamp-2">{song.title}</h2>
					<p class="artist hh-truncate">
						{#if song.artistId}
							<a href="/artists/{song.artistId}">{song.artist ?? 'Unknown artist'}</a>
						{:else}
							{song.artist ?? 'Unknown artist'}
						{/if}
					</p>
					<p class="album hh-clamp-2 hh-muted">
						{#if song.albumId}
							<a href="/albums/{song.albumId}">{song.album ?? ''}</a>
						{:else}
							{song.album ?? ''}
						{/if}
					</p>
				{:else}
					<h2 class="title">Nothing playing</h2>
					<p class="album hh-muted">Pick something from your library</p>
				{/if}
			</div>

			{#if song}
				<div class="rounds">
					<span class="round">
						<FavouriteButton id={song.id} kind="song" starred={song.starred} size={19} />
					</span>
					<button
						class="round"
						onclick={() => playlistPicker.open([song.id], song.title)}
						aria-label="Add to playlist"
						title="Add to playlist"
					>
						<Icon name="plus" size={19} />
					</button>
				</div>
			{/if}
		</div>

		{#if song}
			<div class="fold" class:open={details} inert={!details}>
				<div>
					<dl class="facts">
						{#each facts as [term, value] (term)}
							<div>
								<dt class="hh-muted">{term}</dt>
								<dd class="hh-numeric hh-truncate">{value}</dd>
							</div>
						{/each}
					</dl>
				</div>
			</div>
		{/if}

		<!-- Scrubber, with the times and the quality badge on the line below it. -->
		<div class="scrub">
			<Seekbar
				value={player.currentTime}
				max={player.duration}
				buffered={player.buffered}
				onseek={(seconds) => player.seek(seconds)}
				ariaLabel="Seek within track"
				formatValue={(value) => formatDuration(value)}
			/>
			<div class="times">
				<span class="hh-numeric">{formatDuration(player.currentTime)}</span>
				{#if song && showQualityBadge}
					<!--
						The badge is also the switch. Pressing it asks the music server
						to convert instead of sending the file, and pressing it again
						goes back, both without interrupting what is playing. The codec
						and the bitrate it uses are in Settings.
					-->
					<QualityBadge
						quality={song.quality}
						transcode={player.settings?.transcode
							? {
									codec: player.settings.transcodeCodec,
									bitrateKbps: player.settings.transcodeBitrateKbps
								}
							: null}
						ontoggle={(next) => void player.setTranscoding(next)}
					/>
				{:else}
					<span></span>
				{/if}
				<span class="hh-numeric right">−{formatDuration(remaining)}</span>
			</div>
		</div>

		<!-- Transport. Plain glyphs at poster size, the way the reference has them. -->
		<div class="transport">
			<button
				class="edge"
				class:on={player.shuffle}
				onclick={() => player.toggleShuffle()}
				aria-pressed={player.shuffle}
				aria-label="Shuffle"
				title="Shuffle"
			>
				<Icon name="shuffle" size={19} />
			</button>

			<button
				class="step"
				onclick={() => player.previous()}
				disabled={!player.hasQueue}
				aria-label="Previous track"
				title="Previous"
			>
				<Icon name="previous" size={30} />
			</button>

			<button
				class="play"
				onclick={() => player.toggle()}
				disabled={!song}
				aria-label={player.playing ? 'Pause' : 'Play'}
				title={player.playing ? 'Pause' : 'Play'}
			>
				{#if player.loading && player.playing}
					<span class="spinner" aria-hidden="true"></span>
				{:else}
					<!-- Heavier than the set's default: at 34px the standard 2px stroke
				     reads as a hairline beside the artwork above it. -->
				<Icon name={player.playing ? 'pause' : 'play'} size={34} strokeWidth={3.4} />
				{/if}
			</button>

			<button
				class="step"
				onclick={() => player.next()}
				disabled={!player.hasQueue}
				aria-label="Next track"
				title="Next"
			>
				<Icon name="next" size={30} />
			</button>

			<button
				class="edge"
				class:on={player.repeat !== 'off'}
				onclick={() => player.cycleRepeat()}
				aria-label="Repeat: {player.repeat}"
				title="Repeat: {player.repeat}"
			>
				<Icon name={player.repeat === 'one' ? 'repeat-one' : 'repeat'} size={19} />
			</button>
		</div>

		<div class="fold" class:open={volumeOpen} inert={!volumeOpen}>
			<div>
				<div class="volume">
					<button
						class="tool"
						onclick={() => player.toggleMute()}
						aria-label={player.muted ? 'Unmute' : 'Mute'}
						title={player.muted ? 'Unmute' : 'Mute'}
					>
						<Icon name={volumeIcon} size={17} />
					</button>
					<span class="volume-slider">
						<Seekbar
							value={player.muted ? 0 : player.volume}
							max={1}
							onseek={(value) => player.setVolume(value)}
							ariaLabel="Volume"
							formatValue={(value) => `${Math.round(value * 100)} percent`}
						/>
					</span>
				</div>
			</div>
		</div>

		<!-- The footer row, which is what switches the stage. -->
		<div class="tools">
			<button
				class="tool"
				class:on={details}
				onclick={() => (details = !details)}
				disabled={!song}
				aria-pressed={details}
				aria-label="Track details"
				title="Track details"
			>
				<Icon name="info" size={18} />
			</button>

			<button
				class="tool"
				class:on={lyricsWindow.open}
				onclick={showLyrics}
				disabled={!song}
				aria-pressed={lyricsWindow.open}
				aria-label="Lyrics"
				title="Lyrics"
			>
				<Icon name="lyrics" size={18} />
			</button>

			<button
				class="tool"
				class:on={volumeOpen}
				onclick={() => (volumeOpen = !volumeOpen)}
				aria-pressed={volumeOpen}
				aria-label="Volume"
				title="Volume"
			>
				<Icon name={volumeIcon} size={18} />
			</button>

			<button
				class="tool"
				class:on={player.queueOpen}
				onclick={showQueue}
				aria-pressed={player.queueOpen}
				aria-label="Queue"
				title="Queue ({player.queue.length})"
			>
				<Icon name="queue" size={18} />
				{#if player.queue.length > 0}
					<span class="count hh-numeric">{player.queue.length}</span>
				{/if}
			</button>

			<button
				id="player-hide"
				class="tool"
				onclick={hidePanel}
				aria-label="Hide the player"
				title="Hide the player"
			>
				<Icon name="chevron-right" size={18} />
			</button>
		</div>

		{#if player.error}
			<p class="error" role="alert">{player.error}</p>
		{/if}
	</div>
</aside>

<style>
	.panel {
		--fold: 220ms cubic-bezier(0.32, 0.72, 0.35, 1);
		height: 100%;
		display: flex;
		flex-direction: column;
		overflow: hidden;
		/*
		 * The artwork's height is capped against the panel's *width* — see `.art`
		 * — which needs a container to measure, not a viewport.
		 */
		container-type: inline-size;
		/*
		 * No padding here: the artwork runs to the panel's own edges. It carries
		 * the top corners' radius itself and this clip is the backstop, rather
		 * than the other way round. The controls carry their own padding.
		 */
	}

	/* Everything below the stage, as one block. */
	.chrome {
		flex: none;
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
		padding: var(--space-4);
	}

	/*
	 * Anything in the chrome that opens and closes folds rather than appearing.
	 *
	 * The row goes from `0fr` to `1fr`, which interpolates to the content's own
	 * height without anything having to measure it first. The artwork takes up
	 * the difference on the same frames: the chrome is fixed-size and the stage
	 * is what gives height away, so opening this shrinks the cover and its crop
	 * closes in rather than jumping.
	 *
	 * The negative margin is the gap. A flex gap is paid for a child that is
	 * present whatever its height, so a closed fold would hold an empty gap open
	 * between the title and the scrubber. This cancels exactly that one, and
	 * animates with the rest so nothing steps at either end.
	 *
	 * Longer than `--transition`: this moves the artwork as well as itself, and
	 * at 160ms a 60px fold reads as a jump with a blur on it.
	 */
	.fold {
		flex: none;
		display: grid;
		grid-template-rows: 0fr;
		opacity: 0;
		margin-block-start: calc(var(--space-4) * -1);
		transition:
			grid-template-rows var(--fold),
			opacity var(--fold),
			margin-block-start var(--fold);
	}

	.fold.open {
		grid-template-rows: 1fr;
		opacity: 1;
		margin-block-start: 0;
	}

	/* The clipped row. `min-height: 0` is what lets a grid item be shorter than
	   its own content; without it the row never reaches zero. */
	.fold > * {
		overflow: hidden;
		min-height: 0;
	}

	/* ── Stage ────────────────────────────────────────────────────────── */

	/*
	 * The one part of the panel that gives up its height. Everything below is
	 * fixed-size chrome that must stay reachable, so when the panel is short the
	 * artwork shrinks rather than the transport being pushed out of view.
	 */
	.stage {
		/*
		 * Takes the room the controls do not. The artwork caps its own height, so
		 * growing here no longer leaves a hole the way it did when the artwork was
		 * a square: any slack ends up below the artwork's fade, where it reads as
		 * the tail of the fade rather than as a gap.
		 */
		flex: 1 1 auto;
		/* Both text views fill the stage and scroll inside themselves. */
		overflow: hidden;
		min-height: 0;
		/*
		 * One cell, and every view placed in it. A flex column put the outgoing
		 * view above the incoming one and gave each half the height for the
		 * length of a swap, which made the artwork jump as the lyrics arrived.
		 * Stacked in a single grid cell they cross over each other in place, and
		 * with only one view mounted this behaves exactly as the column did.
		 */
		display: grid;
		grid-template: 'stage' 1fr / 1fr;
	}

	/* Every view in the one cell, whether or not it animates: auto-placement
	   would otherwise give a second, outgoing view a row of its own. */
	.stage > :global(*) {
		grid-area: stage;
		min-height: 0;
	}

	/* The words are what moves; the artwork under them only fades. Painting a
	   ground under the lyrics would have to match the panel's own translucent
	   surface, which changes with the cover behind it. */
	.lyrics-layer {
		display: flex;
		flex-direction: column;
		min-height: 0;
		overflow: hidden;
	}

	/*
	 * The stage swaps one view for another, and a cut between an album cover and
	 * a page of lyrics is the most abrupt change in the panel. The arriving view
	 * fades up.
	 *
	 * The queue arrives this way and leaves at once: holding it for a fade means
	 * holding a list that can be a thousand rows long. The lyrics and the
	 * artwork are bounded, so those two carry a transition in both directions
	 * instead, and cross over each other in the stage's single cell.
	 */
	.stage > :global(*:not(.layer)) {
		animation: stage-in 200ms cubic-bezier(0.32, 0.72, 0.35, 1) both;
	}

	@keyframes stage-in {
		from {
			opacity: 0;
		}
	}

	/*
	 * Full width, all the height the controls do not want, and cropped to fit —
	 * which is what "zoomed in" means here: the cover is square, so filling a
	 * box half again as tall as it is wide shows the middle of it, larger.
	 *
	 * There was a cap at 125cqw, the proportion of the design this follows, to
	 * hold the crop down. It bought a band of bare panel between where the
	 * artwork faded out and where the title began — the fade stopped short of
	 * the text instead of running into it, which is the whole point of the
	 * fade. Filling the stage costs about eight percent more off each side of
	 * the cover and is worth it.
	 */
	.art {
		display: block;
		width: 100%;
		height: 100%;
		/*
		 * And it dissolves into the controls rather than stopping at an edge. The
		 * mask is on the artwork, not a gradient laid over it: a painted overlay
		 * would have to match the panel's own translucent ground, which changes
		 * with the cover behind it, so it would show as a band on some artwork
		 * and not others. Taking the artwork away instead lets the panel's real
		 * ground come through.
		 */
		-webkit-mask-image: linear-gradient(to bottom, #000 0%, #000 68%, transparent 100%);
		mask-image: linear-gradient(to bottom, #000 0%, #000 68%, transparent 100%);
	}

	.art[aria-disabled='true'] {
		pointer-events: none;
	}

	/* ── Queue, in the stage's place ──────────────────────────────────── */

	.queue {
		display: flex;
		flex-direction: column;
		min-height: 0;
		gap: var(--space-2);
		/* The artwork bleeds to the panel's edges; a list must not. */
		padding: var(--space-4) var(--space-4) 0;
	}

	.queue-head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: var(--space-3);
		padding-bottom: var(--space-2);
		border-bottom: 1px solid var(--border-hairline);
	}

	.queue-list {
		list-style: none;
		margin: 0;
		padding: 0;
		overflow-y: auto;
		min-height: 0;
		flex: 1;
	}

	.row {
		display: grid;
		grid-template-columns: 2.25rem minmax(0, 1fr) auto;
		align-items: center;
		gap: var(--space-3);
		padding: 0.3rem 0;
	}

	.row.past {
		opacity: 0.55;
	}

	.row.current .row-title {
		color: var(--glow-color);
		text-shadow: var(--glow-text);
	}

	.row-art {
		position: relative;
		width: 2.25rem;
		border-radius: var(--r-sm);
		overflow: hidden;
	}

	.row-play {
		position: absolute;
		inset: 0;
		display: grid;
		place-items: center;
		background: rgb(0 0 0 / 0.5);
		color: #fff;
		opacity: 0;
		transition: opacity var(--transition);
	}

	.row-art:hover .row-play,
	.row-art:focus-visible .row-play {
		opacity: 1;
	}

	.row-text {
		display: grid;
		min-width: 0;
	}

	.row-title {
		font-size: 0.8125rem;
		color: var(--text-strong);
	}

	.row-sub {
		font-size: 0.75rem;
	}

	.row-remove {
		color: var(--text-faint);
		padding: 0.25rem;
		border-radius: var(--r-sm);
		opacity: 0;
		transition: opacity var(--transition);
	}

	.row:hover .row-remove,
	.row-remove:focus-visible {
		opacity: 1;
	}

	.row-remove:hover {
		color: var(--glow-color);
		filter: var(--glow-icon);
	}

	.queue-empty,
	.queue-clear {
		font-size: 0.8125rem;
		padding: var(--space-3) 0 0;
	}

	.queue-clear {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		color: var(--text-muted);
	}

	.queue-clear:hover {
		color: var(--glow-color);
		text-shadow: var(--glow-text);
	}

	/* ── Title block ──────────────────────────────────────────────────── */

	.head {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: var(--space-3);
		flex: none;
	}

	.text {
		min-width: 0;
	}

	.title {
		margin: 0;
		font-size: 1.375rem;
		line-height: 1.15;
		letter-spacing: -0.015em;
	}

	.artist,
	.album {
		margin: 0.15rem 0 0;
		font-size: 0.9375rem;
	}

	.artist {
		color: var(--text-default);
	}

	/* Underlined in the reference, and it earns it here: this one is a link to
	   the artist while the line under it goes to the album. */
	.artist a {
		text-decoration: underline;
		text-underline-offset: 3px;
		text-decoration-thickness: 1px;
		text-decoration-color: color-mix(in srgb, currentColor 45%, transparent);
	}

	.artist a:hover,
	.album a:hover {
		color: var(--glow-color);
		text-shadow: var(--glow-text);
	}

	.rounds {
		display: flex;
		gap: var(--space-2);
		flex: none;
	}

	/* Circular, translucent, 44px — the size a finger needs and the shape the
	   reference uses to separate these from the transport row. */
	.round,
	.round :global(button) {
		width: 2.75rem;
		height: 2.75rem;
		border-radius: 50%;
		display: grid;
		place-items: center;
		background: var(--control-face);
		-webkit-backdrop-filter: var(--control-blur);
		backdrop-filter: var(--control-blur);
		border: 1px solid var(--border-strong);
		color: var(--text-muted);
	}

	/* FavouriteButton draws its own button, so the wrapper must not add a second
	   face behind it. */
	.round:has(:global(button)) {
		background: none;
		border: none;
		-webkit-backdrop-filter: none;
		backdrop-filter: none;
	}

	.round:hover,
	.round :global(button:hover) {
		color: var(--glow-color);
		filter: var(--glow-icon);
	}

	/* ── Track details ───────────────────────────────────────────────── */

	.facts {
		flex: none;
		margin: 0;
		display: grid;
		gap: 0.15rem;
		font-size: 0.75rem;
	}

	.facts > div {
		display: grid;
		grid-template-columns: 7.5rem minmax(0, 1fr);
		gap: var(--space-3);
	}

	.facts dt,
	.facts dd {
		margin: 0;
	}

	.facts dd {
		color: var(--text-default);
	}

	/* ── Scrubber ────────────────────────────────────────────────────── */

	.scrub {
		flex: none;
		display: grid;
		gap: var(--space-2);
	}

	.times {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
		align-items: center;
		gap: var(--space-2);
		font-size: 0.75rem;
		color: var(--text-faint);
	}

	.times .right {
		text-align: right;
	}

	/* ── Transport ───────────────────────────────────────────────────── */

	.transport {
		flex: none;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-2);
		padding: var(--space-1) 0;
	}

	.edge,
	.step,
	.play {
		display: grid;
		place-items: center;
		border-radius: var(--r-md);
		color: var(--text-strong);
		transition:
			color var(--transition),
			filter var(--transition),
			opacity var(--transition);
	}

	.edge {
		color: var(--text-faint);
		padding: 0.4rem;
	}

	.step,
	.play {
		padding: 0.25rem 0.4rem;
	}

	.edge:hover,
	.step:hover,
	.play:hover {
		color: var(--glow-color);
		filter: var(--glow-icon);
	}

	.edge.on {
		color: var(--accent);
	}

	.edge:disabled,
	.step:disabled,
	.play:disabled {
		opacity: 0.35;
		cursor: not-allowed;
		filter: none;
	}

	.spinner {
		width: 1.6rem;
		height: 1.6rem;
		border-radius: 50%;
		border: 2px solid color-mix(in srgb, currentColor 30%, transparent);
		border-top-color: currentColor;
		animation: spin 0.7s linear infinite;
	}

	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.spinner {
			animation-duration: 2.4s;
		}

		/* Both states stay correct without the movement; they just arrive at
		   once. */
		.fold {
			transition: none;
		}

		.stage > :global(*:not(.layer)) {
			animation: none;
		}
	}

	/* ── Volume and tools ────────────────────────────────────────────── */

	.volume {
		flex: none;
		display: flex;
		align-items: center;
		gap: var(--space-3);
	}

	/*
	 * The slider needs to be told to take the rest of the row. Seekbar's rail is
	 * `width: 100%`, and as a bare flex child with nothing to grow into that
	 * resolved against a zero-width box — a volume control with no length to
	 * drag along.
	 */
	.volume-slider {
		flex: 1;
		min-width: 0;
	}

	.tools {
		flex: none;
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding-top: var(--space-2);
		border-top: 1px solid var(--border-hairline);
	}

	.tool {
		position: relative;
		display: grid;
		place-items: center;
		width: 2.75rem;
		height: 2.75rem;
		border-radius: var(--r-md);
		color: var(--text-faint);
		transition:
			color var(--transition),
			filter var(--transition);
	}

	.tool:hover,
	.tool.on {
		color: var(--glow-color);
		filter: var(--glow-icon);
	}

	.tool:disabled {
		opacity: 0.4;
		cursor: not-allowed;
		filter: none;
	}

	.count {
		position: absolute;
		top: 0.3rem;
		right: 0.25rem;
		min-width: 1.05rem;
		padding: 0 0.2rem;
		border-radius: 999px;
		background: var(--accent);
		color: var(--accent-contrast);
		font-size: 0.625rem;
		line-height: 1.05rem;
		text-align: center;
	}

	.error {
		flex: none;
		margin: 0;
		font-size: 0.75rem;
		color: var(--danger);
	}

	/* ── Narrow ──────────────────────────────────────────────────────── */

	/*
	 * As a sheet rather than a column, the panel is as wide as the screen, so the
	 * artwork would eat the whole viewport. Capping it keeps the transport above
	 * the fold, which is the one thing that must never scroll out of reach.
	 */
	@media (max-width: 60rem) {
		/*
		 * A sheet covers the page instead of sitting beside it, so it has to be
		 * much less see-through than a column: at the docked opacity the album
		 * behind it read straight through the metadata — two layers of text on
		 * top of each other, which is noise rather than depth. The blur stays,
		 * so the cover's colour still comes through as a wash.
		 */
		.panel {
			--glass-base: 92%;
		}
	}
</style>
