<script lang="ts">
	import type { Song } from '$lib/types';
	import { player } from '$lib/client/player.svelte';
	import { formatDuration } from '$lib/client/format';
	import { addSongsToPlaylist } from '$lib/client/playlists.svelte';
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
		/** Supplied by the playlist page so rows can be removed from it. */
		onremove = null
	}: {
		songs: Song[];
		variant?: 'numbered' | 'artwork';
		showAlbum?: boolean;
		showQuality?: boolean;
		groupByDisc?: boolean;
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

<ol class="tracks" class:artwork={variant === 'artwork'}>
	{#each songs as song, index (song.id + ':' + index)}
		{@const isCurrent = song.id === currentId}
		{#if discs && (index === 0 || (songs[index - 1].disc ?? 1) !== (song.disc ?? 1))}
			<li class="disc-header hh-eyebrow" aria-hidden="true">Disc {song.disc ?? 1}</li>
		{/if}
		<li>
			<div
				class="track"
				class:current={isCurrent}
				role="button"
				tabindex="0"
				ondblclick={() => activate(index)}
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
							The number is the play control. On hover it becomes the glyph
							rather than being covered by one: a 32px button laid over a
							two-character number was the largest thing in a row whose
							point is the title.
						-->
						<button
							class="index hh-numeric"
							onclick={() => activate(index)}
							aria-label={isCurrent && player.playing ? `Pause ${song.title}` : `Play ${song.title}`}
						>
							<span class="resting">
								{#if isCurrent && player.playing}
									<span class="bars" aria-hidden="true">
										<i></i><i></i><i></i>
									</span>
								{:else}
									{song.track ?? index + 1}
								{/if}
							</span>
							<span class="glyph" aria-hidden="true">
								<Icon name={isCurrent && player.playing ? 'pause' : 'play'} size={13} />
							</span>
						</button>
					{/if}
					{#if variant === 'artwork'}
						<!-- No number to swap here, so the cover keeps the overlay. -->
						<button class="play-overlay" onclick={() => activate(index)} aria-label="Play {song.title}">
							<Icon name={isCurrent && player.playing ? 'pause' : 'play'} size={14} />
						</button>
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
		transition: background var(--transition);
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

	.index .resting,
	.index .glyph {
		grid-area: 1 / 1;
		display: grid;
		place-items: center end;
		transition: opacity var(--transition);
	}

	.index .glyph {
		opacity: 0;
		color: var(--text-strong);
	}

	.track:hover .index .resting,
	.index:focus-visible .resting {
		opacity: 0;
	}

	.track:hover .index .glyph,
	.index:focus-visible .glyph {
		opacity: 1;
	}

	@media (prefers-reduced-motion: reduce) {
		.index .resting,
		.index .glyph {
			transition: none;
		}
	}

	.play-overlay {
		position: absolute;
		inset: 0;
		display: grid;
		place-items: center;
		opacity: 0;
		background: color-mix(in srgb, var(--bg-sunken) 78%, transparent);
		color: var(--text-strong);
		border-radius: var(--r-sm);
		transition: opacity var(--transition);
	}

	.track:hover .play-overlay,
	.play-overlay:focus-visible {
		opacity: 1;
	}

	.meta {
		display: grid;
		min-width: 0;
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

	.actions {
		display: flex;
		align-items: center;
		gap: 0.125rem;
		opacity: 0;
		transition: opacity var(--transition);
	}

	.track:hover .actions,
	.track:focus-within .actions {
		opacity: 1;
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

	/* Three bars rising and falling while the track plays. Motion, not glow. */
	.bars {
		display: flex;
		align-items: flex-end;
		gap: 2px;
		height: 0.85rem;
	}

	.bars i {
		width: 2px;
		background: var(--accent);
		border-radius: 1px;
		animation: pulse 1s ease-in-out infinite;
	}

	.bars i:nth-child(1) {
		height: 40%;
		animation-delay: -0.2s;
	}
	.bars i:nth-child(2) {
		height: 100%;
	}
	.bars i:nth-child(3) {
		height: 60%;
		animation-delay: -0.45s;
	}

	@keyframes pulse {
		0%,
		100% {
			transform: scaleY(0.4);
		}
		50% {
			transform: scaleY(1);
		}
	}

	.empty {
		padding: var(--space-6);
		text-align: center;
	}

	@media (max-width: 40rem) {
		.track,
		.tracks.artwork .track {
			grid-template-columns: 2.5rem minmax(0, 1fr) auto 3rem;
		}

		.quality {
			display: none;
		}
	}
</style>
