<script lang="ts">
	import { player } from '$lib/client/player.svelte';
	import HeroTitle from '$lib/components/HeroTitle.svelte';
	import Sleeve from '$lib/components/Sleeve.svelte';
	import FavouriteButton from '$lib/components/FavouriteButton.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import MediaCard from '$lib/components/MediaCard.svelte';
	import MediaGrid from '$lib/components/MediaGrid.svelte';
	import QualityBadge from '$lib/components/QualityBadge.svelte';
	import SectionHeader from '$lib/components/SectionHeader.svelte';
	import TrackList from '$lib/components/TrackList.svelte';
	import { playContainer } from '$lib/client/actions';
	import { ALBUM_HERO_COVER_SIZE, formatLongDuration } from '$lib/client/format';
	import { ambience } from '$lib/client/ambience.svelte';
	import { addSongsToPlaylist } from '$lib/client/playlists.svelte';
	import { heroSweep, motion } from '$lib/client/motion';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const album = $derived(data.album);

	// The heading sweeps in from the left after a navigation; see `heroSweep`.
	const sweep = heroSweep();

	/*
	 * The sleeve turns toward the pointer, up to 9 degrees each way, as a record
	 * sleeve does when it is held and tipped to the light; a highlight follows
	 * the pointer across it. Mouse only, and not under reduced motion. It
	 * settles flat on leaving, and on a press, so a click never starts a
	 * navigation with the cover turned.
	 */
	let holder = $state<HTMLDivElement | null>(null);
	let tilting = $state(false);
	function tilt(event: PointerEvent) {
		if (!holder || event.pointerType !== 'mouse' || motion(1) === 0) return;
		const box = holder.getBoundingClientRect();
		const x = Math.min(Math.max((event.clientX - box.left) / box.width, 0), 1);
		const y = Math.min(Math.max((event.clientY - box.top) / box.height, 0), 1);
		holder.style.setProperty('--tilt-x', ((x - 0.5) * 18).toFixed(2));
		holder.style.setProperty('--tilt-y', ((0.5 - y) * 18).toFixed(2));
		holder.style.setProperty('--sheen-x', `${(x * 100).toFixed(1)}%`);
		holder.style.setProperty('--sheen-y', `${(y * 100).toFixed(1)}%`);
		tilting = true;
	}
	function untilt() {
		tilting = false;
		for (const name of ['--tilt-x', '--tilt-y', '--sheen-x', '--sheen-y']) holder?.style.removeProperty(name);
	}


	const isPlayingThisAlbum = $derived(player.current?.albumId === album.id && player.playing);

	// This album is the subject of the page, so it colours the whole room while
	// nothing is playing. It does not override the tint on its own subtree any
	// more: a hero in one colour inside a page in another is exactly the
	// per-widget colouring the single root tint replaced.
	$effect(() => ambience.offer(album.coverArt));
	const totalDuration = $derived(
		album.duration ?? album.songs.reduce((sum, song) => sum + song.duration, 0)
	);

	/**
	 * A release is only labelled hi-res when every track qualifies — a single
	 * 24/96 bonus track on an otherwise CD-quality album should not earn the
	 * badge, and the reverse would be worse.
	 */
	const releaseQuality = $derived.by(() => {
		if (album.songs.length === 0) return null;
		const first = album.songs[0].quality;
		const uniform = album.songs.every(
			(song) =>
				song.quality.format === first.format &&
				song.quality.bitDepth === first.bitDepth &&
				song.quality.sampleRateHz === first.sampleRateHz
		);
		return uniform ? first : null;
	});

	const meta = $derived(
		[
			album.year ? String(album.year) : null,
			album.songs.length ? `${album.songs.length} tracks` : null,
			formatLongDuration(totalDuration) || null,
			album.genre
		].filter(Boolean)
	);
</script>

<svelte:head>
	<title>{album.name} · Heddohon</title>
</svelte:head>

<div class="page">
	<header class="hero">
		<!-- Decoration under the pointer; the cover is not a control. -->
		<div class="art" role="presentation" onpointermove={tilt} onpointerleave={untilt} onpointerdown={untilt}>
			<div class="holder" class:tilting bind:this={holder}>
				<Sleeve
					coverArt={album.coverArt}
					size={ALBUM_HERO_COVER_SIZE}
					alt="Cover of {album.name}"
					transitionId={album.id}
					radius="var(--r-lg)"
				/>
				<span class="sheen" aria-hidden="true"></span>
			</div>
		</div>

		<div class="details" {@attach sweep}>
			<span class="hh-eyebrow">Album</span>
			<HeroTitle text={album.name} />

			{#if album.artist}
				<p class="artist">
					{#if album.artistId}
						<a href="/artists/{album.artistId}">{album.artist}</a>
					{:else}
						{album.artist}
					{/if}
				</p>
			{/if}

			<p class="meta hh-numeric hh-muted">
				{#each meta as item, index (item)}
					{#if index > 0}<span class="dot" aria-hidden="true">·</span>{/if}{item}
				{/each}
			</p>

			{#if releaseQuality}
				<div class="badge-row">
					<QualityBadge quality={releaseQuality} />
				</div>
			{/if}

			<div class="actions">
				<button
					class="hh-button hh-button--primary"
					onclick={() => player.playNow(album.songs)}
					disabled={album.songs.length === 0}
					aria-label="Play"
					title="Play"
				>
					<Icon name="play" size={16} />
					<span class="label">Play</span>
				</button>
				<button
					class="hh-button"
					onclick={() => player.playShuffled(album.songs)}
					disabled={album.songs.length < 2}
					aria-label="Shuffle"
					title="Shuffle"
				>
					<Icon name="shuffle" size={16} />
					<span class="label">Shuffle</span>
				</button>
				<button
					class="hh-button"
					onclick={() => player.addToQueue(album.songs)}
					disabled={album.songs.length === 0}
					aria-label="Add to queue"
					title="Add to queue"
				>
					<Icon name="queue" size={16} />
					<span class="label">Queue</span>
				</button>
				<button
					class="hh-button"
					onclick={() => addSongsToPlaylist(album.songs, album.name)}
					disabled={album.songs.length === 0}
					aria-label="Add to playlist"
					title="Add to playlist"
				>
					<Icon name="plus" size={16} />
					<span class="label">Add to playlist</span>
				</button>
				<FavouriteButton id={album.id} kind="album" starred={album.starred} size={20} />
			</div>
		</div>
	</header>

	<section class="tracks">
		<TrackList songs={album.songs} variant="numbered" groupByDisc />
	</section>

	<!--
		The artist's back catalogue, above the suggestions: an album by the same
		artist is a better answer to "what else" than one by a similar artist,
		so it should not be below eight records that are only related.
	-->
	{#await data.artistAlbums then artistAlbums}
		{#if artistAlbums.length > 0 && album.artist && album.artistId}
			<section>
				<SectionHeader
					title={album.artist}
					eyebrow="More from"
					href="/artists/{album.artistId}"
				/>
				<MediaGrid density="compact">
					{#each artistAlbums as other (other.id)}
						<MediaCard
							href="/albums/{other.id}"
							title={other.name}
							subtitle={other.year ? String(other.year) : null}
							coverArt={other.coverArt}
							transitionId={other.id}
							onplay={() => playContainer('album', other.id)}
						/>
					{/each}
				</MediaGrid>
			</section>
		{/if}
	{/await}

	<!--
		Awaited in the markup rather than in the loader, so the track list is in
		the first byte of HTML and this arrives later down the same response. The
		pending branch is empty on purpose: a row of skeletons would reserve space
		for a shelf that is empty on any server without similarity data.
	-->
	{#await data.similar then similar}
		{#if similar.length > 0}
			<section>
				<SectionHeader title="You might like" eyebrow="Related" />
				<!-- Compact: a suggestion is secondary to the page it sits under, and at
				     this size the whole shelf fits without dominating the scroll. -->
				<MediaGrid density="compact">
					{#each similar as suggestion (suggestion.id)}
						<MediaCard
							href="/albums/{suggestion.id}"
							title={suggestion.name}
							subtitle={suggestion.artist}
							coverArt={suggestion.coverArt}
							transitionId={suggestion.id}
							onplay={() => playContainer('album', suggestion.id)}
						/>
					{/each}
				</MediaGrid>
			</section>
		{/if}
	{/await}
</div>

<style>
	.page {
		display: grid;
		gap: var(--space-6);
		max-width: 76rem;
	}

	.hero {
		position: relative;
		display: grid;
		grid-template-columns: minmax(0, 15rem) minmax(0, 1fr);
		gap: calc(var(--space-7) + var(--space-2));
		/*
		 * Centred, not bottom-aligned. The artwork is a fixed square beside a
		 * column whose height the title decides, so hanging the row off its
		 * bottom edge pooled every spare pixel above the sleeve — and the longer
		 * the title, the bigger the hole. Centring splits that slack, and it also
		 * covers the other direction: a one-line title makes the artwork the
		 * taller item, and bottom-alignment then shoved the text down instead.
		 */
		align-items: center;
		padding: var(--space-5);
		margin: calc(var(--space-5) * -1);
		border-radius: var(--r-xl);
		overflow: hidden;
	}

	/* The depth the turn is seen from: close enough that the near edge grows. */
	.art {
		perspective: 50rem;
	}

	/*
	 * The turn, and a lift toward the viewer with it. While the pointer moves it
	 * follows in 120ms; on leaving it settles flat on the spring, a little past
	 * level and back. Only this wrapper turns: the sleeve inside carries the
	 * view-transition name, and this is flat again before any navigation.
	 */
	.holder {
		position: relative;
		transform: rotateY(calc(var(--tilt-x, 0) * 1deg)) rotateX(calc(var(--tilt-y, 0) * 1deg));
		transition:
			transform var(--dur-travel) var(--ease-spring),
			filter var(--dur-state) var(--ease-out);
	}

	.holder.tilting {
		transform: rotateY(calc(var(--tilt-x, 0) * 1deg)) rotateX(calc(var(--tilt-y, 0) * 1deg))
			translateZ(1.25rem);
		/*
		 * Kept inside the hero's 24px of padding, which clips: at 1.4rem of blur
		 * pushed up to 0.72rem sideways, the glow reached 33px past the sleeve and
		 * was cut off along the edge by the rail. Now at most 0.2rem sideways and
		 * 0.55rem of blur, 12px, at 16 percent of the accent.
		 */
		filter: drop-shadow(
			calc(var(--tilt-x, 0) * -0.022rem) calc(0.4rem + var(--tilt-y, 0) * 0.02rem) 0.55rem
				color-mix(in srgb, var(--accent) 16%, transparent)
		);
		transition:
			transform 120ms var(--ease-out),
			filter var(--dur-state) var(--ease-out);
	}

	/* Light off the sleeve's face where the pointer is, as off a glossy print. */
	.sheen {
		position: absolute;
		inset: 0;
		border-radius: var(--r-lg);
		background: radial-gradient(
			circle at var(--sheen-x, 50%) var(--sheen-y, 50%),
			rgb(255 255 255 / 0.22),
			rgb(255 255 255 / 0.05) 35%,
			transparent 60%
		);
		mix-blend-mode: soft-light;
		opacity: 0;
		pointer-events: none;
		transition: opacity var(--dur-state) var(--ease-out);
	}

	.tilting .sheen {
		opacity: 1;
	}

	.details {
		/* The hero title sizes itself against this column — see HeroTitle. */
		container-type: inline-size;
		display: grid;
		gap: var(--space-2);
		justify-items: start;
		min-width: 0;
	}

	.artist {
		margin: 0;
		font-size: 1.05rem;
		color: var(--text-default);
		font-weight: 500;
	}

	.artist a:hover {
		color: var(--accent);
		text-decoration: underline;
		text-underline-offset: 3px;
	}

	.meta {
		margin: 0;
		font-size: 0.8125rem;
	}

	.dot {
		margin: 0 0.45rem;
	}

	.badge-row {
		margin-top: var(--space-1);
	}

	.actions {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		margin-top: var(--space-3);
		flex-wrap: wrap;
	}

	.actions .hh-button {
		padding: 0.55rem 1.05rem;
		border-radius: var(--r-md);
	}

	.actions .hh-button:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.tracks {
		padding: 0;
	}

	@media (max-width: 52rem) {
		.hero {
			grid-template-columns: minmax(0, 1fr);
			gap: var(--space-4);
		}

		.art {
			max-width: 13rem;
		}

		/* Stacked, the text sits below the sleeve and nothing can overlap it. */
	}

	/*
	 * A phone: glyphs only. With labels the four buttons and the heart wrapped
	 * onto two rows, and "Add to playlist" alone took most of the first. Each
	 * button carries its name in `aria-label` and `title`, so the label that
	 * goes is only the painted one. 44px squares, the size a finger needs; play
	 * stays the accent, round, to keep it the first thing to press.
	 */
	@media (max-width: 36rem) {
		.actions .label {
			display: none;
		}

		.actions .hh-button {
			width: 2.75rem;
			height: 2.75rem;
			padding: 0;
		}

		.actions .hh-button--primary {
			width: 3.25rem;
			height: 3.25rem;
			border-radius: 50%;
		}

		/* Icon sizes itself inline, so only `!important` reaches it. 16px was
		   drawn to sit beside a word; alone in a 44px button it read as a dot. */
		.actions .hh-button :global(svg) {
			width: 1.25rem !important;
			height: 1.25rem !important;
		}
	}
</style>
