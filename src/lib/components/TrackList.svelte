<script lang="ts">
	import type { Song } from '$lib/types';
	import { player } from '$lib/client/player.svelte';
	import { formatDuration } from '$lib/client/format';
	import { addSongsToPlaylist } from '$lib/client/playlists.svelte';
	import { shareComposer } from '$lib/client/share.svelte';
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
		/**
		 * Two columns, reading down the first and then the second, once the list
		 * has 52rem to itself. For a short list of songs from different records,
		 * where one column at that width left most of each row empty.
		 */
		columns = false,
		/** Supplied by the playlist page so rows can be removed from it. */
		onremove = null
	}: {
		songs: Song[];
		variant?: 'numbered' | 'artwork';
		showAlbum?: boolean;
		showQuality?: boolean;
		groupByDisc?: boolean;
		columns?: boolean;
		onremove?: ((index: number) => void) | null;
	} = $props();

	const currentId = $derived(player.current?.id ?? null);

	/** Only worth showing disc headers when the release actually has more than one. */
	const discs = $derived.by(() => {
		if (!groupByDisc) return null;
		const unique = new Set(songs.map((song) => song.disc ?? 1));
		return unique.size > 1 ? unique : null;
	});

	/**
	 * Starts the row, or pauses it if it is the one already playing.
	 *
	 * The control used to show a pause glyph on the playing row and call
	 * `playNow` anyway, so pressing the thing that said "pause" restarted the
	 * track from the beginning.
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

	function onKey(event: KeyboardEvent, index: number) {
		if (event.key === 'Enter' || event.key === ' ') {
			event.preventDefault();
			activate(index);
		}
	}
</script>

{#snippet list()}
<ol
	class="tracks hh-stagger"
	class:artwork={variant === 'artwork'}
	class:columns
	style:--rows={columns ? Math.ceil(songs.length / 2) : null}
>
	{#each songs as song, index (song.id + ':' + index)}
		{@const isCurrent = song.id === currentId}
		{#if discs && (index === 0 || (songs[index - 1].disc ?? 1) !== (song.disc ?? 1))}
			<li class="disc-header hh-eyebrow" aria-hidden="true">Disc {song.disc ?? 1}</li>
		{/if}
		<li class:column-start={columns && index === Math.ceil(songs.length / 2)}>
			<div
				class="track"
				class:current={isCurrent}
				role="button"
				tabindex="0"
				ondblclick={(event) => {
					// A double press on the heart, a link or another control in the row is
					// that control's, not the row's: `stopPropagation` on their clicks does
					// not stop the `dblclick` that follows, and it started the row's song.
					if ((event.target as Element).closest('button, a')) return;
					activate(index);
				}}
				onkeydown={(event) => onKey(event, index)}
				aria-current={isCurrent ? 'true' : undefined}
			>
				<div class="lead">
					{#if variant === 'artwork'}
						<div class="thumb">
							<Cover coverArt={song.coverArt} size={96} alt="" radius="var(--r-sm)" />
						</div>
					{:else}
						<!--
							The number is the play control. On hover it glows in the accent
							and swells a little, rather than turning into a play glyph: the
							glyph was a second picture in a column of numbers. The label
							says what a press does.
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
								{:else}
									{song.track ?? index + 1}
								{/if}
							</span>
						</button>
					{/if}
					{#if variant === 'artwork'}
						<!-- The cover is the play control here, and lifts and glows on
						     hover the way the number does in a numbered list. -->
						<button
							class="play-overlay"
							onclick={() => activate(index)}
							aria-label={isCurrent && player.playing ? `Pause ${song.title}` : `Play ${song.title}`}
						></button>
					{/if}
				</div>

				<div class="meta">
					<span class="title hh-truncate">{song.title}</span>
					<span class="sub hh-truncate hh-muted">
						{#if song.artist}
							<a href={song.artistId ? `/artists/${song.artistId}` : '#'} onclick={(e) => e.stopPropagation()}>
								{song.artist}
							</a>
						{/if}
						{#if showAlbum && song.album}
							<span class="sep" aria-hidden="true">·</span>
							<a href={song.albumId ? `/albums/${song.albumId}` : '#'} onclick={(e) => e.stopPropagation()}>
								{song.album}
							</a>
						{/if}
					</span>
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
								onremove?.(index);
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

<!-- The columns are chosen by the width the list has, not the window's, so the
     list gets a box of its own to measure. -->
{#if columns}
	<div class="frame">{@render list()}</div>
{:else}
	{@render list()}
{/if}

{#if songs.length === 0}
	<p class="empty hh-muted">Nothing here yet.</p>
{/if}

<style>
	/*
	 * A tracklist printed on the back of a sleeve: numbers hang in the margin,
	 * hairline rules separate the entries, and hovering tints the row rather than
	 * filling it. The point is that the eye reads down the titles in one column
	 * instead of scanning a stack of buttons.
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
	 * The hover wash: the accent, strongest at the number and gone by two
	 * thirds of the way across, fading in and growing a little from the left.
	 * A layer of its own under the row's content, so only its opacity and
	 * scale move. The rows hold no glass.
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

	.track:hover::before,
	.track:focus-visible::before {
		opacity: 1;
		scale: 1;
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
	/*
	 * The number and the glyph occupy the same cell and cross-fade, so the row
	 * does not reflow by a pixel when the pointer arrives.
	 */
	.index {
		display: grid;
		place-items: center end;
		min-width: 1.6rem;
		color: var(--text-faint);
		font-size: 0.75rem;
		font-variant-numeric: tabular-nums;
	}

	/* On hover the number lights up in the accent and swells on the spring. */
	.index .resting {
		display: grid;
		place-items: center end;
		transform-origin: right center;
		transition:
			color var(--dur-state) var(--ease-out),
			text-shadow var(--dur-state) var(--ease-out),
			filter var(--dur-state) var(--ease-out),
			scale var(--dur-state) var(--ease-spring);
	}

	.track:hover .index .resting,
	.index:focus-visible .resting {
		color: var(--glow-color);
		text-shadow:
			0 0 6px color-mix(in srgb, var(--accent) 70%, transparent),
			0 0 16px color-mix(in srgb, var(--accent) 45%, transparent);
		scale: 1.2;
	}

	/* The bars cannot take a text-shadow; they glow as a filter instead. */
	.track:hover .index .bars,
	.index:focus-visible .bars {
		filter: drop-shadow(0 0 5px color-mix(in srgb, var(--accent) 80%, transparent));
	}

	/* The cover as the play control: transparent over it, and the cover lifts
	   and takes a glow in the accent on hover. */
	.play-overlay {
		position: absolute;
		inset: 0;
		border-radius: var(--r-sm);
	}

	.thumb {
		transition:
			scale var(--dur-state) var(--ease-spring),
			filter var(--dur-state) var(--ease-out);
	}

	.track:hover .thumb,
	.lead:has(.play-overlay:focus-visible) .thumb {
		scale: 1.08;
		filter: drop-shadow(0 0 8px color-mix(in srgb, var(--accent) 55%, transparent));
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
		letter-spacing: -0.005em;
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

	/*
	 * The row's actions come in one after another from the right, 35ms apart,
	 * and all go at once when the pointer leaves.
	 */
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

	.duration {
		text-align: right;
		color: var(--text-faint);
	}

	/*
	 * Four bars rising and falling from one baseline while the track plays.
	 *
	 * There were three, each scaled about its own centre while the row aligned
	 * their bottoms, so their feet floated up and down; and all three ran one
	 * 1-second cycle from 40 percent, which took the shortest to a 2px dot.
	 * Each bar now grows from the baseline over a range and a period of its
	 * own (0.7 to 1.1s, periods that do not divide into each other), so the
	 * four never line up into a visible loop.
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
</style>
