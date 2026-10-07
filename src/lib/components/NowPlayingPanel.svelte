<script lang="ts">
	/**
	 * The player, as a panel down the right-hand side.
	 *
	 * It replaced a bottom bar, where the artwork was a 48px thumbnail and the
	 * title had a third of the screen's width. A tall panel gives the cover its
	 * whole width and stacks the metadata under it.
	 *
	 * It is open by default: the bar was always visible, and a player that
	 * hides would leave no play/pause on screen while browsing. The rail
	 * carries a toggle to close it.
	 *
	 * The queue is inside it, swapped in where the artwork is, and not a pane
	 * of its own: both wanted the right edge. The footer row switches them.
	 */
	import { untrack } from 'svelte';
	import { SLEEP_MINUTES, player } from '$lib/client/player.svelte';
	import { audioOutputs } from '$lib/client/output.svelte';
	import { handOff } from '$lib/client/handoff';
	import { formatBytes, formatDuration } from '$lib/client/format';
	import { lyricsWindow } from '$lib/client/lyrics.svelte';
	import { playlistPicker } from '$lib/client/playlists.svelte';
	import { prefersReducedMotion } from '$lib/client/sleeve-transition.svelte';
	import { shareComposer } from '$lib/client/share.svelte';
	import { pullHandlers } from '$lib/client/sheet.svelte';
	import { page } from '$app/state';
	import {
		DUR,
		EASE_OUT_CSS,
		easeExit,
		easeOut,
		flipGlyph,
		motion,
		popGlyph,
		skipGlyph,
		turnGlyph
	} from '$lib/client/motion';
	import { flip } from 'svelte/animate';
	import Cover from './Cover.svelte';
	import FavouriteButton from './FavouriteButton.svelte';
	import Icon from './Icon.svelte';
	import LyricsView from './LyricsView.svelte';
	import MixButton from './MixButton.svelte';
	import QualityBadge from './QualityBadge.svelte';
	import RatingStars from './RatingStars.svelte';
	import { remote } from '$lib/client/remote.svelte';
	import { together } from '$lib/client/together.svelte';
	import Seekbar from './Seekbar.svelte';

	let { showQualityBadge = true }: { showQualityBadge?: boolean } = $props();

	/**
	 * The lyrics arriving in the stage, and the artwork leaving under them.
	 *
	 * Opacity and a small vertical travel only. A blur or a scale costs a
	 * repaint of the whole stage per frame on a tablet, and compositing layers
	 * around this panel's `backdrop-filter` have caused artefacts on iOS.
	 *
	 * `distance` is in pixels and signed: the words come up from below and go
	 * back down.
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
	 * right for the next track, from the left for the previous one
	 * (`player.direction`), with a slight blur clearing as they land. The same
	 * elements are animated, not a keyed block crossfading two copies, which
	 * would put two headings with two titles on the page at once for a screen
	 * reader. Opacity and filter go on the text block, which holds no glass.
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
	// Open by default: the panel is wide enough for the slider beside the
	// artwork.
	let volumeOpen = $state(true);
	/*
	 * Folded on a phone, where the sheet is the whole screen and the side
	 * buttons set the level. iOS does not let a page set the volume, so there
	 * the slider moved and the sound did not.
	 */
	$effect(() => {
		if (player.sheetLayout) untrack(() => (volumeOpen = false));
	});
	let sleepOpen = $state(false);
	/** The list of outputs under the volume row, where the browser has no picker of its own. */
	let outputOpen = $state(false);

	// The clock the sleep timer's countdown is read against. It ticks only while
	// a timed sleep is set, and each tick re-renders the badge.
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
	 * artwork's place exclude each other. Without this the tool row could light
	 * both buttons while only one view was on screen.
	 */
	function showQueue() {
		if (lyricsWindow.open) lyricsWindow.close();
		player.toggleQueuePanel();
	}

	function hidePanel() {
		player.togglePanel();
		// The sliver left on the right-hand edge reopens it, so the keyboard goes
		// there once this button is inert.
		void handOff('player-grip');
		// On a phone there is no sliver: the dock at the foot of the screen reopens it.
		void handOff('dock-open');
	}

	function showLyrics() {
		if (player.queueOpen) player.toggleQueuePanel();
		lyricsWindow.toggle(player.current);
	}

	// From the whole second played, so it ticks in the same frame as the elapsed
	// time and the seek bar. From the exact time it ticked at the fraction of a
	// second the duration carries: a second repaint of the panel, and of its
	// blur, every second.
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
	 * under the pointer moves with it and the rows it passes step aside by one
	 * row height. The queue is not touched until the drop, so the player never
	 * sees a half-made order. `animate:flip` then settles the dropped row from
	 * where it was let go.
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
	<!--
		The handle a phone pulls the sheet down by, over the top of the artwork. A
		tap on it closes the sheet too. It doubles the chevron in the tool row for
		a finger, so it stays out of the tab order and the accessibility tree.
	-->
	<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
	<div class="grabber" aria-hidden="true" onclick={hidePanel} {...pullHandlers}><span></span></div>

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
				<!-- Focusable, as the library and the lyrics are: with no scrollbar,
				     the keyboard scrolls a long queue. -->
				<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
				<ol class="queue-list" tabindex="0" bind:this={queueList}>
					{#each player.queue as track, index (queueKeys[index])}
						<li
							animate:flip={{ duration: motion(DUR.state), easing: easeOut }}
							class:dragged={drag?.from === index}
							style:translate={rowShift(index)}
						>
							<div class="row" class:current={index === player.index} class:past={index < player.index}>
								<!-- Dragged by pointer or finger, or moved one place at a time
								     with the arrow keys while it has focus. -->
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
									<span class="row-sub hh-truncate hh-muted">
										{track.artist ?? 'Unknown artist'}{#if track.addedBy}<span class="row-by">{` · Added by ${track.addedBy.name}`}</span>{/if}
									</span>
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
				{...pullHandlers}
				draggable="false"
				ondragstart={(event) => event.preventDefault()}
				in:lift={{ duration: DUR.state, distance: 0 }}
				out:lift={{ duration: DUR.hover, distance: 0, leaving: true }}
				href={song?.albumId ? `/albums/${song.albumId}` : '#'}
				aria-label={song ? 'Open album' : 'Nothing playing'}
				aria-disabled={song?.albumId ? undefined : 'true'}
			>
				<!--
					The artwork runs into the panel's own top corners, so it carries
					their radius itself. See the note on `img` in Cover.
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
				<!-- While this browser hosts listening together: who is with it, and
				     the way back to the link. -->
				{#if together.party}
					<button class="live" onclick={() => (together.open = true)} title="Listening together">
						<span class="dot" aria-hidden="true"></span>
						Live · {together.listeners === 0 ? 'nobody yet' : `${together.listeners} listening`}
					</button>
				{/if}
			</div>

			<!-- A station is not a track of the library: nothing to favour, list, rate, read or share. -->
			{#if song && !song.live}
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

		{#if song && !song.live}
			<div class="fold" class:open={details} inert={!details}>
				<div>
					<dl class="facts">
						{#each facts as [term, value] (term)}
							<div>
								<dt class="hh-muted">{term}</dt>
								<dd class="hh-numeric hh-truncate">{value}</dd>
							</div>
						{/each}
						{#if page.data.ratings}
							<div class="rating">
								<dt class="hh-muted">Rating</dt>
								<dd><RatingStars id={song.id} kind="song" rating={song.rating} size={14} /></dd>
							</div>
						{/if}
					</dl>
					{#if page.data.downloads}
						<!-- With the file's other facts, where its format and size are
						     written, and not as a seventh tool. -->
						<a class="download" href="/api/download/{encodeURIComponent(song.id)}" download>
							<Icon name="download" size={14} />
							Download original{song.quality.format ? ` ${song.quality.format.toUpperCase()}` : ''}{song
								.quality.sizeBytes
								? ` · ${formatBytes(song.quality.sizeBytes)}`
								: ''}
						</a>
					{/if}
					<!-- A mix made from this track, among the things about this track. -->
					<div class="more-like">
						<MixButton of="song" id={song.id} label="Instant mix from this track" variant="inline" />
					</div>
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
				{#if song && !song.live && showQualityBadge}
					<!--
						The badge is also the switch. Pressing it asks the music server
						to convert instead of sending the file, and pressing it again
						goes back, without interrupting playback. The codec and the
						bitrate are in Settings.
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
				<span class="hh-numeric right">{song?.live ? 'Live' : `−${formatDuration(remaining)}`}</span>
			</div>
		</div>

		<!-- Transport. Plain glyphs at poster size, the way the reference has them. -->
		<div class="transport">
			<button
				class="edge"
				class:on={player.shuffle}
				onclick={(event) => {
					flipGlyph(event.currentTarget);
					player.toggleShuffle();
				}}
				aria-pressed={player.shuffle}
				aria-label="Shuffle"
				title="Shuffle"
			>
				<Icon name="shuffle" size={19} />
			</button>

			<button
				class="step"
				onclick={(event) => {
					skipGlyph(event.currentTarget, -1);
					void player.previous();
				}}
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
					     shrinks away as the other grows in. Heavier than the set's
					     default: at 34px the standard 2px stroke reads as a hairline
					     beside the artwork. -->
					<span class="glyph" class:on={!player.playing}><Icon name="play" size={34} strokeWidth={3.4} /></span>
					<span class="glyph" class:on={player.playing}><Icon name="pause" size={34} strokeWidth={3.4} /></span>
				{/if}
			</button>

			<button
				class="step"
				onclick={(event) => {
					skipGlyph(event.currentTarget, 1);
					void player.next();
				}}
				disabled={!player.hasQueue}
				aria-label="Next track"
				title="Next"
			>
				<Icon name="next" size={30} />
			</button>

			<button
				class="edge"
				class:on={player.repeat !== 'off'}
				onclick={(event) => {
					turnGlyph(event.currentTarget);
					player.cycleRepeat();
				}}
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
						onclick={(event) => {
							popGlyph(event.currentTarget);
							player.toggleMute();
						}}
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
					{#if audioOutputs.supported}
						<!-- Firefox opens its own picker; elsewhere the choices fold out below. -->
						<button
							class="tool"
							class:on={outputOpen || audioOutputs.current.id !== ''}
							onclick={() => (audioOutputs.picker ? void audioOutputs.pick() : (outputOpen = !outputOpen))}
							aria-expanded={audioOutputs.picker ? undefined : outputOpen}
							aria-label="Audio output: {audioOutputs.current.label}"
							title="Output: {audioOutputs.current.label}"
						>
							<Icon name="output" size={17} />
						</button>
					{/if}
					<!-- A speaker or a TV on the network. Where the browser lists its
					     outputs it is the last of them ("Cast…" below), so this button
					     is for Safari and iOS, which list none. -->
					{#if (player.castAvailable || player.casting) && (!audioOutputs.supported || audioOutputs.picker)}
						<button
							class="tool"
							class:on={player.casting}
							onclick={() => void player.cast()}
							disabled={!song}
							aria-pressed={player.casting}
							aria-label={player.casting ? 'Casting; choose where to play' : 'Cast to a speaker or a TV'}
							title={player.casting ? 'Casting' : 'Cast'}
						>
							<Icon name="cast" size={17} />
						</button>
					{/if}
				</div>
				{#if audioOutputs.problem && (audioOutputs.picker || !outputOpen)}
					<p class="output-note hh-muted" role="status">{audioOutputs.problem}</p>
				{/if}
			</div>
		</div>

		<div class="fold" class:open={volumeOpen && outputOpen} inert={!(volumeOpen && outputOpen)}>
			<div>
				<div class="outputs" role="group" aria-label="Audio output">
					<div class="sleep">
						<button
							class="chip"
							class:active={audioOutputs.current.id === ''}
							onclick={() => void audioOutputs.choose({ id: '', label: 'System default' })}
						>
							System default
						</button>
						{#each audioOutputs.outputs as output (output.id)}
							<button
								class="chip"
								class:active={audioOutputs.current.id === output.id}
								onclick={() => void audioOutputs.choose(output)}
							>
								{output.label}
							</button>
						{/each}
						<!-- A speaker or a TV on the network: the same picker as the cast
						     button beside the volume. -->
						{#if player.castAvailable || player.casting}
							<button
								class="chip cast"
								class:active={player.casting}
								onclick={() => void player.cast()}
								disabled={!song}
								aria-pressed={player.casting}
							>
								<Icon name="cast" size={13} />
								{player.casting ? 'Casting' : 'Cast…'}
							</button>
						{/if}
					</div>
					{#if !audioOutputs.named}
						<p class="output-note hh-muted">
							This browser names your outputs once Heddohon may use the microphone. Nothing is
							recorded: the microphone is closed as soon as the list is read.
						</p>
						<div>
							<button
								class="chip"
								disabled={audioOutputs.listing}
								onclick={() => void audioOutputs.nameOutputs()}
							>
								{audioOutputs.listing ? 'Listing…' : 'List outputs'}
							</button>
						</div>
					{/if}
					{#if audioOutputs.problem}
						<p class="output-note hh-muted" role="status">{audioOutputs.problem}</p>
					{/if}
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
				disabled={!song || song.live}
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
				disabled={!song || song.live}
				aria-pressed={lyricsWindow.open}
				aria-label="Lyrics"
				title="Lyrics"
			>
				<Icon name="lyrics" size={18} />
			</button>

			<!-- Here and not beside the favourite and playlist buttons: a third 44px
			     round there leaves the title about 160px on a docked panel. -->
			{#if page.data.sharing}
				<button
					class="tool"
					onclick={() => song && shareComposer.open(song)}
					disabled={!song || song.live}
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

			<!-- Only while another browser of the account has the player open, or
			     another app of it is playing, so the row is otherwise its usual
			     seven. -->
			{#if remote.peers.length + remote.apps.length > 0}
				<button
					class="tool"
					class:on={remote.open}
					onclick={() => (remote.open = true)}
					aria-label="Devices ({remote.peers.length + remote.apps.length} other)"
					title="Devices"
				>
					<Icon name="devices" size={18} />
					<span class="count hh-numeric">{remote.peers.length + remote.apps.length}</span>
				</button>
			{/if}

			<button
				class="tool"
				class:on={player.queueOpen}
				onclick={showQueue}
				aria-pressed={player.queueOpen}
				aria-label="Queue"
				title="Queue ({player.queue.length})"
			>
				<Icon name="queue" size={18} />
				<!-- Keyed, so a track added from anywhere pops the count as it changes. -->
				{#key player.queue.length}
					{#if player.queue.length > 0}
						<span class="count hh-numeric">{player.queue.length}</span>
					{/if}
				{/key}
			</button>

			<button
				id="player-hide"
				class="tool"
				onclick={hidePanel}
				aria-label="Hide the player"
				title="Hide the player"
			>
				<!-- Down on a phone, where the sheet goes down; right beside the page,
				     where the panel goes off the right-hand edge. -->
				<span class="beside"><Icon name="chevron-right" size={18} /></span>
				<span class="below"><Icon name="chevron-down" size={18} /></span>
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
		/* The artwork's height is capped against the panel's width (see `.art`),
		   which needs a container to measure. */
		container-type: inline-size;
		/*
		 * No padding: the artwork runs to the panel's edges and carries the top
		 * corners' radius itself, with this clip as the backstop. The controls
		 * carry their own padding.
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
	 * Anything in the chrome that opens and closes folds.
	 *
	 * The row goes from `0fr` to `1fr`, which interpolates to the content's
	 * height without measuring it. The artwork takes up the difference on the
	 * same frames: the chrome is fixed-size and the stage gives height away, so
	 * opening this shrinks the cover and its crop closes in.
	 *
	 * The negative margin is the gap. A flex gap is paid for a child that is
	 * present whatever its height, so a closed fold would hold an empty gap
	 * between the title and the scrubber. This cancels that one, and animates
	 * with the rest.
	 *
	 * Longer than `--transition`: this moves the artwork too, and at 160ms a
	 * 60px fold reads as a jump.
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

	/* The clipped row. `min-height: 0` lets a grid item be shorter than its
	   content, so the row can reach zero. */
	.fold > * {
		overflow: hidden;
		min-height: 0;
	}

	/* ── Stage ────────────────────────────────────────────────────────── */

	/*
	 * The one part of the panel that gives up its height. Everything below is
	 * fixed-size chrome that must stay reachable, so a short panel shrinks the
	 * artwork and keeps the transport in view.
	 */
	.stage {
		/*
		 * Takes the room the controls do not. The artwork caps its own height,
		 * so any slack ends up below the artwork's fade, where it reads as the
		 * tail of the fade.
		 */
		flex: 1 1 auto;
		/* Both text views fill the stage and scroll inside themselves. */
		overflow: hidden;
		min-height: 0;
		/*
		 * One cell, and every view placed in it. A flex column put the outgoing
		 * view above the incoming one and gave each half the height during a
		 * swap, so the artwork jumped as the lyrics arrived. In one grid cell
		 * they cross over each other in place.
		 */
		display: grid;
		grid-template: 'stage' 1fr / 1fr;
	}

	/* Every view in the one cell, animating or not: auto-placement would give a
	   second, outgoing view a row of its own. */
	.stage > :global(*) {
		grid-area: stage;
		min-height: 0;
	}

	/* The words move and the artwork under them only fades. A ground painted
	   under the lyrics would have to match the panel's translucent surface,
	   which changes with the cover behind it. */
	.lyrics-layer {
		display: flex;
		flex-direction: column;
		min-height: 0;
		overflow: hidden;
	}

	/*
	 * The arriving view fades up, so the stage does not cut between a cover and
	 * a page of lyrics.
	 *
	 * The queue arrives this way and leaves at once: holding it for a fade
	 * means holding a list that can be a thousand rows. The lyrics and the
	 * artwork are bounded, so they transition both ways and cross over each
	 * other in the stage's cell.
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
	 * Full width, all the height the controls do not want, and cropped to fit:
	 * the cover is square, so a box half again as tall as it is wide shows its
	 * middle, larger.
	 *
	 * A cap at 125cqw once held the crop down, and left a band of bare panel
	 * between the end of the artwork's fade and the title. Filling the stage
	 * crops about eight percent more off each side of the cover.
	 */
	.art {
		display: block;
		width: 100%;
		height: 100%;
		/*
		 * It dissolves into the controls. The mask is on the artwork, not a
		 * gradient laid over it: an overlay would have to match the panel's
		 * translucent ground, which changes with the cover behind it, and would
		 * show as a band on some artwork.
		 */
		-webkit-mask-image: linear-gradient(to bottom, #000 0%, #000 68%, transparent 100%);
		mask-image: linear-gradient(to bottom, #000 0%, #000 68%, transparent 100%);
	}

	.art[aria-disabled='true'] {
		pointer-events: none;
	}

	/* Dither over the artwork, so its fade into the controls does not step. See
	   `--grain` in app.css. Inside the mask, so it fades out with it. */
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

	/* Rows the dragged one passes step aside smoothly. The dragged row follows
	   the pointer with no lag. */
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

	/* Who added a track, while listening together. */
	.row-by {
		color: var(--text-default);
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

	/* Underlined: this one links to the artist, and the line under it to the
	   album. */
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

	/* Circular, translucent, 44px: the size a finger needs, and a shape apart
	   from the transport row's. */
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

	/* FavouriteButton draws its own button, so the wrapper adds no second face
	   behind it. */
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

	/* ── Listening together ──────────────────────────────────────────── */

	.live {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		margin-top: var(--space-2);
		padding: 0.2rem 0.6rem;
		border-radius: var(--r-pill);
		border: 1px solid var(--border-strong);
		font-size: 0.75rem;
		font-weight: 600;
		color: var(--text-strong);
	}

	.live:hover {
		color: var(--glow-color);
	}

	.live .dot {
		width: 0.45rem;
		height: 0.45rem;
		border-radius: 50%;
		background: var(--danger);
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

	/* The stars' own padding would push the row taller than the text rows. */
	.facts .rating {
		align-items: center;
	}

	.facts .rating dd {
		margin-left: -0.15rem;
	}

	.more-like {
		margin-top: var(--space-2);
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
	 * screens get the opacity cue in `app.css`.
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

	/* Play and pause, one over the other. The one not wanted shrinks to 60
	   percent and fades, and the wanted one springs back to full size. */
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

		/* Both states are correct without the movement. */
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
	 * The slider takes the rest of the row. Seekbar's rail is `width: 100%`,
	 * which as a bare flex child resolved against a zero-width box: a volume
	 * control with no length to drag along.
	 */
	.volume-slider {
		flex: 1;
		min-width: 0;
	}

	.chip.cast {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
	}

	.outputs {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
	}

	.output-note {
		margin: 0;
		font-size: 0.75rem;
		line-height: 1.4;
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
			border-color var(--transition),
			background var(--transition);
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

	/* A change of count, from here or from an "Add to queue" anywhere else. */
	@keyframes count-pop {
		from {
			scale: 0.4;
		}
	}

	.count {
		animation: count-pop var(--dur-state) var(--ease-spring);
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

	/* The phone's handle and its downward chevron; see the narrow rules below. */
	.grabber,
	.below {
		display: none;
	}

	.beside {
		display: grid;
	}

	/* ── Narrow ──────────────────────────────────────────────────────── */

	/*
	 * As a sheet the panel is as wide as the screen, so the artwork would fill
	 * the viewport. Capped, the transport stays above the fold.
	 */
	@media (max-width: 60rem) {
		/*
		 * A sheet covers the page, so it is much less see-through than a column:
		 * at the docked opacity the album behind it read through the metadata.
		 * The blur stays, so the cover's colour still comes through as a wash.
		 */
		.panel {
			--glass-base: 92%;
		}

		/*
		 * The handle, a short bar across the top of the artwork. The strip it
		 * sits in is the whole width and 28px tall, so the thumb does not have
		 * to find the bar itself.
		 */
		.grabber {
			display: block;
			position: absolute;
			inset: 0 0 auto;
			height: 1.75rem;
			z-index: 3;
			touch-action: none;
		}

		.grabber span {
			position: absolute;
			top: 0.5rem;
			left: 50%;
			width: 2.5rem;
			height: 5px;
			margin-left: -1.25rem;
			border-radius: var(--r-pill);
			background: rgb(255 255 255 / 0.62);
			box-shadow: 0 1px 3px rgb(0 0 0 / 0.35);
		}

		/* Pulled down by, as well as the handle: it is most of the top of the
		   sheet. It is a link, so the press that starts a pull must not drag the
		   link or its picture (which cancels the pull) or bring up iOS's link
		   preview. */
		.art {
			touch-action: none;
			-webkit-touch-callout: none;
			-webkit-user-drag: none;
		}

		.art :global(img) {
			-webkit-user-drag: none;
		}

		.beside {
			display: none;
		}

		.below {
			display: grid;
		}
	}
</style>
