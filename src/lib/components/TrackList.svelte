<script lang="ts">
	import type { Song } from '$lib/types';
	import { player } from '$lib/client/player.svelte';
	import { formatDuration } from '$lib/client/format';
	import { contextMenu } from '$lib/client/context-menu.svelte';
	import { SelectableList } from '$lib/client/selection.svelte';
	import { addSongsToPlaylist } from '$lib/client/playlists.svelte';
	import { shareComposer } from '$lib/client/share.svelte';
	import { together } from '$lib/client/together.svelte';
	import { page } from '$app/state';
	import Cover from './Cover.svelte';
	import FavouriteButton from './FavouriteButton.svelte';
	import Icon from './Icon.svelte';
	import QualityBadge from './QualityBadge.svelte';

	let {
		songs,
		/** Album views number the tracks; playlists and search show artwork instead. */
		variant = 'numbered',
		showAlbum = false,
		showQuality = true,
		groupByDisc = false,
		/** The album's artist: a row names its artist only where it differs, as on a compilation. */
		albumArtist = null,
		/**
		 * Two columns, read down the first and then the second, once the list
		 * has 52rem to itself. For a short list of songs from different records,
		 * where one column at that width left most of each row empty.
		 */
		columns = false,
		/** Supplied by the playlist page so rows can be removed from it, one or the selection at a time. */
		onremove = null,
		onmove = null
	}: {
		songs: Song[];
		variant?: 'numbered' | 'artwork';
		showAlbum?: boolean;
		showQuality?: boolean;
		groupByDisc?: boolean;
		albumArtist?: string | null;
		columns?: boolean;
		onremove?: ((indexes: number[]) => void) | null;
		/**
		 * Makes the list reorderable: each row gets a handle, dragged with a
		 * pointer or a finger or moved one place at a time with the arrow keys,
		 * and a drop reports the move. The caller reorders and passes the new
		 * order back in `songs`.
		 */
		onmove?: ((from: number, to: number) => void) | null;
	} = $props();

	const currentId = $derived(player.current?.id ?? null);

	const credited = (song: Song) => Boolean(song.artist) && song.artist !== albumArtist;

	/*
	 * Several rows picked at once; see `selection.svelte.ts`. The selection is
	 * of positions, so it ends when the list is handed a new order or loses a
	 * row, and when the list goes.
	 */
	const selectable = new SelectableList(() => ({
		songs: () => songs,
		remove: onremove ? { label: 'Remove from this playlist', run: (indexes) => onremove?.(indexes) } : null
	}));

	$effect(() => {
		void songs;
		return () => selectable.drop();
	});

	function focusRow(index: number) {
		listEl?.querySelectorAll<HTMLElement>('.track')[index]?.focus();
	}

	/** Only worth showing disc headers when the release actually has more than one. */
	const discs = $derived.by(() => {
		if (!groupByDisc) return null;
		const unique = new Set(songs.map((song) => song.disc ?? 1));
		return unique.size > 1 ? unique : null;
	});

	/**
	 * Starts the row, or pauses it if it is the one playing. The control showed
	 * a pause glyph on the playing row and called `playNow` anyway, which
	 * restarted the track.
	 */
	function activate(index: number) {
		const song = songs[index];
		if (song.id === currentId) {
			if (player.playing) player.pause();
			else void player.play();
			return;
		}
		void player.playNow(songs, index);
	}

	/*
	 * Reordering, as the queue in the player does it: the dragged row follows
	 * the pointer, the rows it passes step aside by one row, and nothing is
	 * reported until the drop. The page scrolls under the pointer near either
	 * edge of the window, and the offset counts that scroll, so the row stays
	 * under the pointer.
	 */
	let listEl = $state<HTMLOListElement | null>(null);
	let drag = $state<{
		from: number;
		to: number;
		offset: number;
		startY: number;
		startScroll: number;
		rowHeight: number;
		lastY: number;
	} | null>(null);
	let autoscroll: ReturnType<typeof setInterval> | undefined;

	/** The page's scroll: the window on a phone, the content column wider. */
	function scroller(): HTMLElement {
		const column = listEl?.closest<HTMLElement>('main.content');
		return column && getComputedStyle(column).overflowY !== 'visible' ? column : document.documentElement;
	}

	function rowShift(index: number): string | undefined {
		if (!drag) return undefined;
		if (index === drag.from) return `0 ${drag.offset}px`;
		if (drag.from < index && index <= drag.to) return `0 ${-drag.rowHeight}px`;
		if (drag.to <= index && index < drag.from) return `0 ${drag.rowHeight}px`;
		return undefined;
	}

	function follow() {
		if (!drag) return;
		const offset = drag.lastY - drag.startY + (scroller().scrollTop - drag.startScroll);
		const steps = Math.round(offset / drag.rowHeight);
		drag = { ...drag, offset, to: Math.min(songs.length - 1, Math.max(0, drag.from + steps)) };
	}

	function startDrag(event: PointerEvent, index: number) {
		if (event.button !== 0 || !onmove) return;
		const row = (event.currentTarget as HTMLElement).closest('li');
		if (!row) return;
		event.preventDefault();
		(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
		drag = {
			from: index,
			to: index,
			offset: 0,
			startY: event.clientY,
			startScroll: scroller().scrollTop,
			rowHeight: row.offsetHeight,
			lastY: event.clientY
		};
		clearInterval(autoscroll);
		autoscroll = setInterval(() => {
			if (!drag) return;
			const edge = 64;
			const step = drag.lastY < edge ? -12 : drag.lastY > innerHeight - edge ? 12 : 0;
			if (step === 0) return;
			scroller().scrollTop += step;
			follow();
		}, 16);
	}

	function moveDrag(event: PointerEvent) {
		if (!drag) return;
		drag = { ...drag, lastY: event.clientY };
		follow();
	}

	function endDrag() {
		clearInterval(autoscroll);
		if (!drag) return;
		const { from, to } = drag;
		drag = null;
		if (from !== to) onmove?.(from, to);
	}

	function cancelDrag() {
		clearInterval(autoscroll);
		drag = null;
	}

	/** One place up or down from the keyboard, keeping focus on the handle of the moved row. */
	function nudge(event: KeyboardEvent, index: number) {
		// Every key stays with the handle: Enter or Space reaching the row would
		// start its song.
		event.stopPropagation();
		const to = event.key === 'ArrowUp' ? index - 1 : event.key === 'ArrowDown' ? index + 1 : null;
		if (to === null) return;
		event.preventDefault();
		if (to < 0 || to >= songs.length) return;
		onmove?.(index, to);
		requestAnimationFrame(() => listEl?.querySelectorAll<HTMLButtonElement>('.grip')[to]?.focus());
	}

	$effect(() => () => clearInterval(autoscroll));

	function onKey(event: KeyboardEvent, index: number) {
		// The row's own keys only. Enter on a link or a button inside it belongs
		// to that control: caught here, it started the row's song instead.
		if (event.target !== event.currentTarget) return;
		if (selectable.keydown(event, index, focusRow)) return;
		if (event.key === 'Enter') {
			event.preventDefault();
			activate(index);
		}
	}
</script>

{#snippet list()}
<ol
	bind:this={listEl}
	class="tracks hh-stagger"
	class:artwork={variant === 'artwork'}
	class:columns
	class:reorderable={onmove !== null}
	class:dragging={drag !== null}
	style:--rows={columns ? Math.ceil(songs.length / 2) : null}
>
	{#each songs as song, index (song.id + ':' + index)}
		{@const isCurrent = song.id === currentId}
		{@const isSelected = selectable.has(index)}
		{#if discs && (index === 0 || (songs[index - 1].disc ?? 1) !== (song.disc ?? 1))}
			<li class="disc-header hh-eyebrow" aria-hidden="true">Disc {song.disc ?? 1}</li>
		{/if}
		<li
			class:column-start={columns && index === Math.ceil(songs.length / 2)}
			class:dragged={drag?.from === index}
			style:translate={rowShift(index)}
		>
			<div
				class="track"
				class:current={isCurrent}
				class:selected={isSelected}
				role="button"
				tabindex="0"
				onclickcapture={(event) => selectable.click(event, index)}
				onmousedown={(event) => selectable.mousedown(event)}
				onpointerdown={(event) => selectable.pointerdown(event, index)}
				onpointermove={(event) => selectable.pointermove(event)}
				onpointerup={() => selectable.pointerend()}
				onpointercancel={() => selectable.pointerend()}
				ondblclick={(event) => {
					// A double press on a control in the row is that control's.
					// `stopPropagation` on its clicks does not stop the `dblclick` that
					// follows, which started the row's song. Two clicks that pick
					// rows, or two taps while picking, are not a double press either.
					if ((event.target as Element).closest('button, a')) return;
					if (event.shiftKey || event.ctrlKey || event.metaKey || selectable.active) return;
					activate(index);
				}}
				onkeydown={(event) => onKey(event, index)}
				oncontextmenu={(event) => {
					if (selectable.contextmenu(event, index)) return;
					// On a picked row the menu is for every picked row.
					if (isSelected) {
						contextMenu.open(event, { kind: 'selection' });
						return;
					}
					contextMenu.open(event, {
						kind: 'song',
						song,
						play: () => activate(index),
						remove: onremove ? { label: 'Remove from this playlist', run: () => onremove?.([index]) } : null
					});
				}}
				aria-current={isCurrent ? 'true' : undefined}
			>
				{#if onmove}
					<!-- Dragged by pointer or finger, or moved one place at a time with
					     the arrow keys while it has focus. -->
					<button
						class="grip"
						data-select-skip
						type="button"
						aria-label="Move {song.title}, number {index + 1} of {songs.length}. Use the up and down arrow keys."
						title="Drag to reorder"
						onpointerdown={(event) => startDrag(event, index)}
						onpointermove={moveDrag}
						onpointerup={endDrag}
						onpointercancel={cancelDrag}
						onkeydown={(event) => nudge(event, index)}
						onclick={(event) => event.stopPropagation()}
					>
						<Icon name="grip" size={14} />
					</button>
				{/if}
				<div class="lead">
					{#if variant === 'artwork'}
						<div class="thumb">
							<Cover coverArt={song.coverArt} size={96} alt="" radius="var(--r-sm)" />
							{#if isSelected}
								<span class="picked" aria-hidden="true"><Icon name="check" size={18} /></span>
							{/if}
						</div>
					{:else}
						<!--
							The number is the play control. On hover it glows in the accent
							and swells a little: a play glyph there was a second picture in
							a column of numbers. The label says what a press does.
						-->
						<button
							class="index hh-numeric"
							onclick={() => activate(index)}
							aria-label={isCurrent && player.playing ? `Pause ${song.title}` : `Play ${song.title}`}
						>
							<span class="resting">
								{#if isCurrent && player.playing}
									<span class="bars" aria-hidden="true">
										<i></i><i></i><i></i><i></i>
									</span>
								{:else if isSelected}
									<Icon name="check" size={14} />
								{:else}
									{song.track ?? index + 1}
								{/if}
							</span>
						</button>
					{/if}
					{#if variant === 'artwork'}
						<!-- The cover is the play control here, and lifts and glows on
						     hover as the number does in a numbered list. -->
						<button
							class="play-overlay"
							onclick={() => activate(index)}
							aria-label={isCurrent && player.playing ? `Pause ${song.title}` : `Play ${song.title}`}
						></button>
					{/if}
				</div>

				<div class="meta">
					<span class="title hh-truncate">{song.title}</span>
					{#if isSelected}<span class="hh-visually-hidden">Selected</span>{/if}
					{#if credited(song) || (showAlbum && song.album)}
						<span class="sub hh-truncate hh-muted">
							{#if credited(song)}
								<a href={song.artistId ? `/artists/${song.artistId}` : '#'}>
									{song.artist}
								</a>
							{/if}
							{#if showAlbum && song.album}
								{#if credited(song)}<span class="sep" aria-hidden="true">·</span>{/if}
								<a href={song.albumId ? `/albums/${song.albumId}` : '#'}>
									{song.album}
								</a>
							{/if}
						</span>
					{/if}
				</div>

				{#if showQuality}
					<div class="quality">
						<QualityBadge quality={song.quality} compact />
					</div>
				{/if}

				<div class="actions">
					<FavouriteButton id={song.id} kind="song" starred={song.starred} />
					<button
						class="row-action"
						onclick={(event) => {
							event.stopPropagation();
							player.addToQueue([song]);
						}}
						aria-label="Add {song.title} to the queue"
						title="Add to queue"
					>
						<Icon name="queue" size={16} />
					</button>
					<button
						class="row-action"
						onclick={(event) => {
							event.stopPropagation();
							addSongsToPlaylist([song], song.title);
						}}
						aria-label="Add {song.title} to a playlist"
						title="Add to playlist"
					>
						<Icon name="plus" size={16} />
					</button>
					<!-- While the account is a member of someone's listen-together session. -->
					{#if together.joined && !song.live}
						<button
							class="row-action"
							onclick={(event) => {
								event.stopPropagation();
								void together.add(song);
							}}
							aria-label="Add {song.title} to listen together"
							title="Add to listen together"
						>
							<Icon name="radio" size={15} />
						</button>
					{/if}
					{#if page.data.sharing}
						<button
							class="row-action"
							onclick={(event) => {
								event.stopPropagation();
								shareComposer.open(song);
							}}
							aria-label="Share a link to {song.title}"
							title="Share"
						>
							<Icon name="share" size={15} />
						</button>
					{/if}
					{#if onremove}
						<button
							class="row-action row-action--danger"
							onclick={(event) => {
								event.stopPropagation();
								onremove?.([index]);
							}}
							aria-label="Remove {song.title} from this playlist"
							title="Remove from playlist"
						>
							<Icon name="close" size={15} />
						</button>
					{/if}
				</div>

				<span class="duration hh-numeric hh-muted">{formatDuration(song.duration)}</span>
			</div>
		</li>
	{/each}
</ol>
{/snippet}

<!-- The columns follow the width the list has, not the window's, so the list
     gets a box of its own to measure. -->
{#if columns}
	<div class="frame">{@render list()}</div>
{:else}
	{@render list()}
{/if}

{#if songs.length === 0}
	<p class="empty hh-muted">Nothing here yet</p>
{/if}

<style>
	/*
	 * A tracklist as on the back of a sleeve: numbers hang in the margin,
	 * hairline rules separate the entries, and hovering tints the row. The eye
	 * reads down the titles in one column.
	 */
	.tracks {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.disc-header {
		padding: var(--space-5) 0 var(--space-2);
		color: var(--accent);
	}

	.track {
		display: grid;
		grid-template-columns: 2.25rem minmax(0, 1fr) auto auto 3.5rem;
		align-items: center;
		gap: var(--space-3);
		padding: 0.55rem var(--space-2);
		border-top: 1px solid var(--border-hairline);
		cursor: default;
		position: relative;
		isolation: isolate;
	}

	/*
	 * The hover wash: the accent, strongest at the number and gone two thirds
	 * of the way across, fading in and growing a little from the left. A layer
	 * of its own under the row's content, so only its opacity and scale move.
	 * The rows hold no glass.
	 */
	.track::before {
		content: '';
		position: absolute;
		inset: 0;
		z-index: -1;
		border-radius: var(--r-sm);
		background: linear-gradient(
			90deg,
			color-mix(in srgb, var(--accent) 13%, transparent),
			color-mix(in srgb, var(--accent) 4%, transparent) 55%,
			transparent
		);
		transform-origin: left center;
		opacity: 0;
		scale: 0.97 1;
		pointer-events: none;
		transition:
			opacity var(--dur-state) var(--ease-out),
			scale var(--dur-state) var(--ease-out);
	}

	/* And while the menu a right click opened on it is up; see
	   `context-menu.svelte.ts`. */
	.track:hover::before,
	.track:global([data-menu-open])::before,
	.track:focus-visible::before {
		opacity: 1;
		scale: 1;
	}

	/* A picked row: the wash held, stronger and across the whole row, with an
	   edge in the accent where it starts. */
	.track.selected::before {
		opacity: 1;
		scale: 1;
		background: linear-gradient(
			90deg,
			color-mix(in srgb, var(--accent) 24%, transparent),
			color-mix(in srgb, var(--accent) 9%, transparent)
		);
		box-shadow: inset 2px 0 0 var(--accent);
	}

	.track.selected .index .resting {
		color: var(--accent);
	}

	/* Over the cover of a picked row, which is the play control there. */
	.picked {
		position: absolute;
		inset: 0;
		display: grid;
		place-items: center;
		border-radius: var(--r-sm);
		background: color-mix(in srgb, var(--accent) 72%, transparent);
		color: var(--accent-contrast);
		pointer-events: none;
	}

	/*
	 * With a finger, a long press on a row picks it (`selection.svelte.ts`).
	 * Without these, iOS selects the text under the finger and opens its
	 * callout instead. A link keeps its own: a long press there is how it
	 * opens in a new tab.
	 */
	@media (pointer: coarse) {
		.track {
			-webkit-touch-callout: none;
			-webkit-user-select: none;
			user-select: none;
		}

		.track a {
			-webkit-touch-callout: default;
		}
	}

	/* A reorderable list puts the handle in a column of its own first, as the
	   queue does. The templates below are those above with it added. */
	.tracks.reorderable .track {
		grid-template-columns: 1.75rem 2.25rem minmax(0, 1fr) auto auto 3.5rem;
	}

	.tracks.reorderable.artwork .track {
		grid-template-columns: 1.75rem 2.75rem minmax(0, 1fr) auto auto 3.5rem;
	}

	.grip {
		display: grid;
		place-items: center;
		width: 1.75rem;
		height: 2.75rem;
		padding: 0;
		border-radius: var(--r-sm);
		color: var(--text-faint);
		cursor: grab;
		/* A finger on it drags the row rather than scrolling the page. */
		touch-action: none;
	}

	.grip:hover,
	.grip:focus-visible {
		color: var(--glow-color);
	}

	.dragging .grip {
		cursor: grabbing;
	}

	/* The rows being stepped past move on the spring. The one being carried
	   follows the pointer exactly, over the others. Only during a drag: on the
	   drop the offsets and the new order land together, and a transition then
	   would carry every row back from where it had stepped. */
	.tracks.reorderable.dragging > li {
		transition: translate var(--dur-state) var(--ease-out);
	}

	.tracks.reorderable > li.dragged {
		position: relative;
		z-index: 2;
		transition: none;
	}

	.tracks.reorderable > li.dragged .track {
		background: var(--bg-hover);
		box-shadow: 0 8px 24px rgb(0 0 0 / 0.28);
		border-radius: var(--r-sm);
	}

	.tracks.artwork .track {
		grid-template-columns: 2.75rem minmax(0, 1fr) auto auto 3.5rem;
		padding: 0.45rem var(--space-2);
	}

	/* No rule above the first entry, or above one that follows a disc heading. */
	li:first-child .track,
	.disc-header + li .track {
		border-top: none;
	}

	.frame {
		container-type: inline-size;
	}

	@container (min-width: 52rem) {
		.tracks.columns {
			display: grid;
			grid-template-columns: repeat(2, minmax(0, 1fr));
			grid-template-rows: repeat(var(--rows), auto);
			grid-auto-flow: column;
			column-gap: var(--space-6);
		}

		.tracks.columns .column-start .track {
			border-top: none;
		}
	}

	.track:hover,
	.track:focus-visible {
		text-shadow: var(--glow-text);
		color: var(--glow-color);
	}

	.track.current {
		text-shadow: var(--glow-text);
	}

	.track.current .title {
		color: var(--accent);
		font-weight: 600;
	}

	.lead {
		position: relative;
		display: grid;
		place-items: center;
		width: 100%;
		aspect-ratio: 1;
	}

	.tracks:not(.artwork) .lead {
		aspect-ratio: auto;
		height: 2rem;
		justify-items: end;
	}

	.thumb {
		width: 100%;
	}

	/* Mono, right-aligned, quiet: an index number, not a label. */
	/* The number and the glyph share one cell and cross-fade, so the row does
	   not reflow when the pointer arrives. */
	.index {
		display: grid;
		place-items: center end;
		min-width: 1.6rem;
		color: var(--text-faint);
		font-size: 0.75rem;
		font-variant-numeric: tabular-nums;
	}

	/* On hover the number lights up. */
	.index .resting {
		display: grid;
		place-items: center end;
		transition:
			color var(--dur-state) var(--ease-out),
			text-shadow var(--dur-state) var(--ease-out),
			filter var(--dur-state) var(--ease-out);
	}

	.track:hover .index .resting,
	.index:focus-visible .resting {
		color: var(--glow-color);
		text-shadow: var(--glow-text);
	}

	/* The bars cannot take a text-shadow; they glow as a filter instead. */
	.track:hover .index .bars,
	.index:focus-visible .bars {
		filter: var(--glow-icon);
	}

	/* The cover as the play control: transparent over it, and the cover lifts
	   and takes a glow in the accent on hover. */
	.play-overlay {
		position: absolute;
		inset: 0;
		border-radius: var(--r-sm);
	}

	.thumb {
		position: relative;
		transition: scale var(--dur-state) var(--ease-spring);
	}

	/* The glow, faded by opacity: a `drop-shadow` filter transitioned from
	   `none` snapped on in Chromium (see MediaCard). */
	.thumb::before {
		content: '';
		position: absolute;
		inset: 0;
		border-radius: var(--r-sm);
		box-shadow: 0 0 8px color-mix(in srgb, var(--accent) 55%, transparent);
		opacity: 0;
		transition: opacity var(--dur-state) var(--ease-out);
		pointer-events: none;
	}

	.track:hover .thumb,
	.lead:has(.play-overlay:focus-visible) .thumb {
		scale: 1.08;
	}

	.track:hover .thumb::before,
	.lead:has(.play-overlay:focus-visible) .thumb::before {
		opacity: 1;
	}

	/* The title and artist step a little to the right under the pointer. */
	.meta {
		display: grid;
		min-width: 0;
		transition: translate var(--dur-state) var(--ease-spring);
	}

	.track:hover .meta {
		translate: 0.2rem 0;
	}

	.title {
		color: var(--text-strong);
		font-weight: 500;
	}

	.sub {
		font-size: 0.8125rem;
	}

	.sub a:hover {
		text-decoration: underline;
		text-underline-offset: 2px;
	}

	.sep {
		margin: 0 0.35rem;
	}

	.quality {
		display: flex;
		align-items: center;
	}

	/* The row's actions come in one after another from the right, 35ms apart,
	   and all go at once when the pointer leaves. */
	.actions {
		display: flex;
		align-items: center;
		gap: 0.125rem;
	}

	.actions > :global(*) {
		opacity: 0;
		translate: 0.4rem 0;
		transition:
			opacity var(--dur-hover) var(--ease-out),
			translate var(--dur-state) var(--ease-out);
	}

	.track:hover .actions > :global(*),
	.track:focus-within .actions > :global(*) {
		opacity: 1;
		translate: 0 0;
	}

	.track:hover .actions > :global(:nth-child(2)),
	.track:focus-within .actions > :global(:nth-child(2)) {
		transition-delay: 35ms;
	}

	.track:hover .actions > :global(:nth-child(3)),
	.track:focus-within .actions > :global(:nth-child(3)) {
		transition-delay: 70ms;
	}

	.track:hover .actions > :global(:nth-child(n + 4)),
	.track:focus-within .actions > :global(:nth-child(n + 4)) {
		transition-delay: 105ms;
	}

	.row-action {
		display: grid;
		place-items: center;
		padding: 0.3rem;
		border-radius: var(--r-sm);
		color: var(--text-faint);
		transition:
			color var(--transition),
			background var(--transition);
	}

	.row-action:hover {
		color: var(--glow-color);
		filter: var(--glow-icon);
	}

	.row-action--danger:hover {
		color: var(--danger);
	}

	/* The last column, whether or not a row lays out a quality cell or its
	   actions before it: placed by order, it would move left without them. */
	.duration {
		grid-column: -2;
		text-align: right;
		color: var(--text-faint);
	}

	/*
	 * Four bars rising and falling from one baseline while the track plays.
	 *
	 * Each grows from the baseline over its own range and period (0.7 to 1.1s,
	 * periods that do not divide into each other), so the four never line up
	 * into a visible loop. Three bars scaled about their centres floated their
	 * feet, and on one 1-second cycle from 40 percent the shortest became a 2px
	 * dot.
	 */
	.bars {
		display: flex;
		align-items: flex-end;
		gap: 2px;
		height: 0.9rem;
	}

	.bars i {
		width: 3px;
		height: 100%;
		border-radius: 1.5px;
		background: var(--accent);
		transform-origin: bottom;
		animation: bar var(--period) ease-in-out var(--offset) infinite alternate;
	}

	.bars i:nth-child(1) {
		--low: 0.3;
		--high: 0.75;
		--period: 0.83s;
		--offset: -0.3s;
	}
	.bars i:nth-child(2) {
		--low: 0.45;
		--high: 1;
		--period: 0.71s;
		--offset: -0.55s;
	}
	.bars i:nth-child(3) {
		--low: 0.25;
		--high: 0.85;
		--period: 1.07s;
		--offset: -0.1s;
	}
	.bars i:nth-child(4) {
		--low: 0.35;
		--high: 0.65;
		--period: 0.93s;
		--offset: -0.7s;
	}

	@keyframes bar {
		from {
			scale: 1 var(--low);
		}
		to {
			scale: 1 var(--high);
		}
	}

	.empty {
		padding: var(--space-6);
		text-align: center;
	}

	@keyframes actions-in {
		from {
			opacity: 0;
		}
	}

	@media (max-width: 40rem) {
		.track,
		.tracks.artwork .track {
			grid-template-columns: 2.5rem minmax(0, 1fr) auto 3rem;
		}

		.tracks.reorderable .track,
		.tracks.reorderable.artwork .track {
			grid-template-columns: 1.75rem 2.5rem minmax(0, 1fr) auto 3rem;
		}

		.quality {
			display: none;
		}

		/*
		 * A phone has no hover, so the row actions sat invisible and still took
		 * their width: four of them left an iPhone 16 (393px) about 120px of
		 * title. They are laid out only for the row that has focus, which a tap
		 * gives it.
		 */
		.actions {
			display: none;
		}

		.track:focus-within .actions {
			display: flex;
			animation: actions-in var(--dur-hover) var(--ease-out);
		}
	}

	/* ── Terminal ────────────────────────────────────────────────────────────── */

	/*
	 * Rows as lines of a listing. Hover is a flat step of the ground, with
	 * nothing in the row moving. The playing row is a step of the ground with its
	 * title and its number in the accent, as the queue's is. It was the accent
	 * as the whole row's ground, which on an album of a few tracks was the
	 * largest area of colour on the screen.
	 */
	:global([data-theme='terminal']) .track::before {
		background: var(--bg-hover);
		scale: none;
		transition: opacity var(--dur-hover) var(--ease-out);
	}

	/* A picked row is the accent's ground, faint, with its edge. */
	:global([data-theme='terminal']) .track.selected::before {
		background: color-mix(in srgb, var(--accent) 20%, transparent);
		box-shadow: inset 3px 0 0 var(--accent);
	}

	:global([data-theme='terminal']) .track:hover .meta {
		translate: none;
	}

	:global([data-theme='terminal']) .track:hover .thumb,
	:global([data-theme='terminal']) .lead:has(.play-overlay:focus-visible) .thumb {
		scale: none;
	}

	:global([data-theme='terminal']) .thumb::before {
		display: none;
	}

	:global([data-theme='terminal']) .track:hover .index .resting,
	:global([data-theme='terminal']) .index:focus-visible .resting {
		text-shadow: none;
		scale: none;
	}

	:global([data-theme='terminal']) .track:hover .index .bars,
	:global([data-theme='terminal']) .index:focus-visible .bars {
		filter: none;
	}

	:global([data-theme='terminal']) .track.current {
		background: var(--bg-raised);
		border-top-color: transparent;
		border-radius: var(--r-sm);
	}

	:global([data-theme='terminal']) .track.current .title,
	:global([data-theme='terminal']) .track.current .index {
		color: var(--accent);
	}

	:global([data-theme='terminal']) .track.current .title {
		font-weight: 600;
	}

	/* The row under the playing one has no rule above it: the block ends there. */
	:global([data-theme='terminal']) li:has(.track.current) + li .track {
		border-top-color: transparent;
	}

	:global([data-theme='terminal']) .actions > :global(*) {
		translate: none;
		transition: opacity var(--dur-hover) var(--ease-out);
		transition-delay: 0s !important;
	}

	:global([data-theme='terminal']) .tracks.reorderable > li.dragged .track {
		box-shadow: inset 0 0 0 1px var(--accent);
	}

	/* The bars move in three hard steps. */
	:global([data-theme='terminal']) .bars i {
		border-radius: 0;
		animation-timing-function: steps(3, jump-none);
	}
</style>
