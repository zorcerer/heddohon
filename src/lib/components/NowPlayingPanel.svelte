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
	import { untrack } from 'svelte';
	import { SLEEP_MINUTES, player } from '$lib/client/player.svelte';
	import { handOff } from '$lib/client/handoff';
	import { formatBytes, formatDuration } from '$lib/client/format';
	import { lyricsWindow } from '$lib/client/lyrics.svelte';
	import { playlistPicker } from '$lib/client/playlists.svelte';
	import { prefersReducedMotion } from '$lib/client/sleeve-transition.svelte';
	import { shareComposer } from '$lib/client/share.svelte';
	import { page } from '$app/state';
	import { DUR, EASE_OUT_CSS, easeExit, easeOut, motion } from '$lib/client/motion';
	import { flip } from 'svelte/animate';
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
	function lift(
		node: Element,
		{ duration = DUR.state, distance = 14, leaving = false }: { duration?: number; distance?: number; leaving?: boolean } = {}
	) {
		if (prefersReducedMotion()) return { duration: 0 };
		return {
			duration,
			easing: leaving ? easeExit : easeOut,
			css: (t: number, u: number) => `opacity: ${t}; transform: translate3d(0, ${u * distance}px, 0)`
		};
	}

	const song = $derived(player.current);

	/*
	 * The title, artist and album slide in from the side the queue moved to
	 * when the track changes, as the artwork above them crossfades: from the
	 * right for the next track (and the one after a track ends), from the left
	 * for the previous one (`player.direction`),
	 * with a slight blur clearing as they land. The same elements are animated
	 * rather than a keyed block crossfading two copies: two headings with two
	 * titles would be on the page at once for the length of it, to a screen
	 * reader and to anything that reads the title. Opacity and filter on the
	 * text block, which holds no glass; the round buttons beside it are its
	 * siblings.
	 *
	 * Not on the first render, so a page that arrives with a track loaded does
	 * not animate one in.
	 */
	let arrivedFor: string | null | undefined = undefined;
	function arrive(key: string | null) {
		return (node: HTMLElement) => {
			const first = arrivedFor === undefined;
			const changed = arrivedFor !== key;
			const direction = untrack(() => player.direction);
			arrivedFor = key;
			if (first || !changed || prefersReducedMotion()) return;
			const animation = node.animate(
				[
					{ opacity: 0, translate: `${direction * 1.25}rem 0`, filter: 'blur(3px)' },
					{ opacity: 1, translate: '0 0', filter: 'blur(0px)' }
				],
				{ duration: DUR.travel, easing: EASE_OUT_CSS }
			);
			return () => animation.cancel();
		};
	}

	let details = $state(false);
	/*
	 * Open by default. The panel is wide enough to hold the slider without
	 * taking the artwork's room, and a volume control you have to go and find
	 * is the one piece of transport that is worse for being tidied away.
	 */
	let volumeOpen = $state(true);
	let sleepOpen = $state(false);

	/*
	 * The clock the sleep timer's countdown is read against. It ticks only
	 * while a timed sleep is set, and each tick is one re-render of the badge.
	 */
	let now = $state(Date.now());
	$effect(() => {
		if (player.sleep?.kind !== 'at') return;
		now = Date.now();
		const tick = setInterval(() => (now = Date.now()), 1000);
		return () => clearInterval(tick);
	});
	const sleepMinutesLeft = $derived(
		player.sleep?.kind === 'at' ? Math.max(0, Math.ceil((player.sleep.at - now) / 60_000)) : null
	);

	function chooseSleep(choice: number | 'track' | null) {
		player.setSleep(choice);
		sleepOpen = false;
	}

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

	// From the whole second played, so it ticks in the same frame as the elapsed
	// time and the seek bar. From the exact time it ticked at the fraction of a
	// second the duration carries, which is a second repaint of the panel
	// (and of its blur) every second.
	const remaining = $derived(Math.max(0, player.duration - Math.floor(player.currentTime)));
	const volumeIcon = $derived(
		player.muted || player.volume === 0 ? 'mute' : player.volume < 0.5 ? 'volume-low' : 'volume'
	);
	const queueTotal = $derived(player.queue.reduce((sum, track) => sum + track.duration, 0));

	/*
	 * Reordering the queue.
	 *
	 * Rows are keyed by song id and how many times that id has come before, not
	 * by position. A position key gave every row a new identity whenever
	 * anything moved, so nothing could animate to its new place and the
	 * keyboard lost the row it was moving.
	 */
	const queueKeys = $derived.by(() => {
		const seen = new Map<string, number>();
		return player.queue.map((track) => {
			const count = seen.get(track.id) ?? 0;
			seen.set(track.id, count + 1);
			return `${track.id}#${count}`;
		});
	});

	let queueList = $state<HTMLOListElement | null>(null);

	/*
	 * A drag is followed with transforms and applied once, on release. The row
	 * under the pointer moves with it and the rows it passes step out of the
	 * way by one row height; the queue itself is not touched until the drop, so
	 * the player never sees a half-made order. `animate:flip` then settles the
	 * dropped row from where it was let go.
	 */
	let drag = $state<{ from: number; to: number; offset: number; startY: number; rowHeight: number } | null>(
		null
	);

	function rowShift(index: number): string | undefined {
		if (!drag) return undefined;
		if (index === drag.from) return `0 ${drag.offset}px`;
		if (drag.from < index && index <= drag.to) return `0 ${-drag.rowHeight}px`;
		if (drag.to <= index && index < drag.from) return `0 ${drag.rowHeight}px`;
		return undefined;
	}

	function startDrag(event: PointerEvent, index: number) {
		if (event.button !== 0) return;
		const row = (event.currentTarget as HTMLElement).closest('li');
		if (!row) return;
		event.preventDefault();
		(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
		drag = { from: index, to: index, offset: 0, startY: event.clientY, rowHeight: row.offsetHeight };
	}

	function moveDrag(event: PointerEvent) {
		if (!drag) return;
		const offset = event.clientY - drag.startY;
		const steps = Math.round(offset / drag.rowHeight);
		const to = Math.min(player.queue.length - 1, Math.max(0, drag.from + steps));
		drag = { ...drag, offset, to };

		// Near either end of the list, scroll it, so a row can be carried past
		// what is on screen.
		if (queueList) {
			const box = queueList.getBoundingClientRect();
			if (event.clientY < box.top + 36) queueList.scrollTop -= 8;
			else if (event.clientY > box.bottom - 36) queueList.scrollTop += 8;
		}
	}

	function endDrag() {
		if (!drag) return;
		const { from, to } = drag;
		drag = null;
		player.move(from, to);
	}

	function cancelDrag() {
		drag = null;
	}

	/** One place up or down from the keyboard, keeping focus on the moved row. */
	function nudge(event: KeyboardEvent, index: number) {
		const to = event.key === 'ArrowUp' ? index - 1 : event.key === 'ArrowDown' ? index + 1 : null;
		if (to === null) return;
		event.preventDefault();
		if (to < 0 || to >= player.queue.length) return;
		player.move(index, to);
		requestAnimationFrame(() => {
			queueList?.querySelectorAll<HTMLButtonElement>('.row-grip')[to]?.focus();
		});
	}

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
				in:lift={{ duration: DUR.state, distance: 14 }}
				out:lift={{ duration: DUR.hover, distance: 10, leaving: true }}
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
				<ol class="queue-list" tabindex="0" bind:this={queueList}>
					{#each player.queue as track, index (queueKeys[index])}
						<li
							animate:flip={{ duration: motion(DUR.state), easing: easeOut }}
							class:dragged={drag?.from === index}
							style:translate={rowShift(index)}
						>
							<div class="row" class:current={index === player.index} class:past={index < player.index}>
								<!--
									Dragged by pointer or finger, or moved one place at a time with
									the arrow keys while it has focus.
								-->
								<button
									class="row-grip"
									type="button"
									aria-label="Move {track.title}. Use the up and down arrow keys."
									title="Drag to reorder"
									onpointerdown={(event) => startDrag(event, index)}
									onpointermove={moveDrag}
									onpointerup={endDrag}
									onpointercancel={cancelDrag}
									onkeydown={(event) => nudge(event, index)}
								>
									<Icon name="grip" size={14} />
								</button>
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
				in:lift={{ duration: DUR.state, distance: 0 }}
				out:lift={{ duration: DUR.hover, distance: 0, leaving: true }}
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
			<div class="text" {@attach arrive(song?.id ?? null)}>
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
					{#if page.data.downloads}
						<!-- With the rest of the file's facts, where its format and size
						     are already written, rather than as a seventh tool. -->
						<a class="download" href="/api/download/{encodeURIComponent(song.id)}" download>
							<Icon name="download" size={14} />
							Download original{song.quality.format ? ` ${song.quality.format.toUpperCase()}` : ''}{song
								.quality.sizeBytes
								? ` · ${formatBytes(song.quality.sizeBytes)}`
								: ''}
						</a>
					{/if}
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
				unit={1}
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
					<!-- Both glyphs are drawn, one over the other, and the one not wanted
					     shrinks away as the other grows in: a press turns the button over
					     rather than swapping a picture. Heavier than the set's default: at
					     34px the standard 2px stroke reads as a hairline beside the artwork
					     above it. -->
					<span class="glyph" class:on={!player.playing}><Icon name="play" size={34} strokeWidth={3.4} /></span>
					<span class="glyph" class:on={player.playing}><Icon name="pause" size={34} strokeWidth={3.4} /></span>
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

		<div class="fold" class:open={sleepOpen} inert={!sleepOpen}>
			<div>
				<div class="sleep" role="group" aria-label="Sleep timer">
					{#each SLEEP_MINUTES as minutes (minutes)}
						<button
							class="chip"
							class:active={player.sleep?.kind === 'at' && player.sleep.minutes === minutes}
							onclick={() => chooseSleep(minutes)}
						>
							{minutes} min
						</button>
					{/each}
					<button
						class="chip"
						class:active={player.sleep?.kind === 'track'}
						onclick={() => chooseSleep('track')}
					>
						End of track
					</button>
					{#if player.sleep}
						<button class="chip" onclick={() => chooseSleep(null)}>Off</button>
					{/if}
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

			<!-- Here rather than beside the favourite and playlist buttons: a third
			     44px round there leaves the title about 160px on a docked panel. -->
			{#if page.data.sharing}
				<button
					class="tool"
					onclick={() => song && shareComposer.open(song)}
					disabled={!song}
					aria-label="Share a link to this song"
					title="Share"
				>
					<Icon name="share" size={18} />
				</button>
			{/if}

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
				class:on={sleepOpen || player.sleep !== null}
				onclick={() => (sleepOpen = !sleepOpen)}
				aria-expanded={sleepOpen}
				aria-label={sleepMinutesLeft !== null
					? `Sleep timer, pausing in ${sleepMinutesLeft} minutes`
					: player.sleep
						? 'Sleep timer, pausing at the end of this track'
						: 'Sleep timer'}
				title="Sleep timer"
			>
				<Icon name="moon" size={18} />
				{#if sleepMinutesLeft !== null}
					<span class="count hh-numeric">{sleepMinutesLeft}</span>
				{/if}
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
		--fold: var(--dur-state) var(--ease-out);
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
		animation: stage-in var(--dur-state) var(--ease-out) both;
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

	/* Dither over the artwork, so its fade into the controls does not step.
	   See `--grain` in app.css. Inside the mask, so it fades out with it. */
	.art {
		position: relative;
	}

	.art::after {
		content: '';
		position: absolute;
		inset: 0;
		background: var(--grain) 0 0 / var(--grain-size) var(--grain-size) repeat;
		border-radius: inherit;
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

	/* Rows the dragged one passes step aside smoothly; the dragged row itself
	   follows the pointer with no lag. */
	.queue-list > li {
		position: relative;
		transition: translate var(--dur-hover) var(--ease-out);
	}

	.queue-list > li.dragged {
		z-index: 2;
		transition: none;
		background: var(--bg-raised);
		border-radius: var(--r-sm);
		box-shadow: var(--shadow-mid);
	}

	.row-grip {
		display: grid;
		place-items: center;
		width: 1.25rem;
		height: 2.25rem;
		color: var(--text-faint);
		cursor: grab;
		/* The handle takes the gesture; without this a finger scrolls the list. */
		touch-action: none;
		border-radius: var(--r-sm);
		transition: color var(--transition);
	}

	.row-grip:hover,
	.row-grip:focus-visible,
	.dragged .row-grip {
		color: var(--glow-color);
	}

	.dragged .row-grip {
		cursor: grabbing;
	}

	.row {
		display: grid;
		grid-template-columns: 1.25rem 2.25rem minmax(0, 1fr) auto;
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

	.download {
		display: inline-flex;
		align-items: center;
		gap: var(--space-2);
		margin-top: var(--space-2);
		font-size: 0.75rem;
		color: var(--text-muted);
		text-decoration: none;
		transition:
			color var(--transition),
			text-shadow var(--transition);
	}

	.download:hover {
		color: var(--glow-color);
		text-shadow: var(--glow-text);
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
			opacity var(--transition),
			scale var(--dur-state) var(--ease-spring);
	}

	/*
	 * Pressed, the transport gives under the pointer and springs back on
	 * release. `scale` on the buttons themselves, which carry no glass. Touch
	 * screens get the opacity cue in `app.css` instead.
	 */
	@media (hover: hover) {
		.edge:active:not(:disabled),
		.step:active:not(:disabled),
		.play:active:not(:disabled),
		.tool:active:not(:disabled) {
			scale: 0.88;
			transition-duration: var(--dur-press);
		}
	}

	.play {
		position: relative;
	}

	/* Play and pause, one over the other. The one not wanted shrinks to
	   60 percent and fades; the wanted one springs back to full size. */
	.glyph {
		grid-area: 1 / 1;
		display: grid;
		opacity: 0;
		scale: 0.6;
		transition:
			opacity var(--dur-hover) var(--ease-out),
			scale var(--dur-state) var(--ease-spring);
	}

	.glyph.on {
		opacity: 1;
		scale: 1;
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

	/* The chip look of `SortChips`, as buttons: a timer is not a URL. */
	.sleep {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-1);
	}

	.chip {
		padding: 0.3rem 0.75rem;
		border-radius: var(--r-pill);
		border: 1px solid var(--border-hairline);
		background: var(--control-face);
		color: var(--text-muted-through);
		font-size: 0.8125rem;
		font-weight: 500;
		white-space: nowrap;
		transition:
			text-shadow var(--transition),
			color var(--transition),
			border-color var(--transition);
	}

	.chip:hover {
		color: var(--glow-color);
		text-shadow: var(--glow-text);
		border-color: var(--border-strong);
	}

	.chip.active {
		background: var(--accent);
		border-color: var(--accent);
		color: var(--accent-contrast);
		text-shadow: none;
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
			filter var(--transition),
			scale var(--dur-state) var(--ease-spring);
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
