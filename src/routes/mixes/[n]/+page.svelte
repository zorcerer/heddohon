<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import HeroTitle from '$lib/components/HeroTitle.svelte';
	import Sleeve from '$lib/components/Sleeve.svelte';
	import TrackList from '$lib/components/TrackList.svelte';
	import { formatLongDuration } from '$lib/client/format';
	import { player } from '$lib/client/player.svelte';
	import { addSongsToPlaylist } from '$lib/client/playlists.svelte';
	import { heroSweep } from '$lib/client/motion';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	// The heading sweeps in from the left after a navigation; see `heroSweep`.
	const sweep = heroSweep();

	const mix = $derived(data.mix);
	const totalDuration = $derived(mix.songs.reduce((sum, song) => sum + song.duration, 0));
</script>

<svelte:head>
	<title>{mix.title} · Heddohon</title>
</svelte:head>

<div class="page">
	<header class="hero">
		<div class="art">
			<Sleeve coverArt={mix.coverArt} size={640} alt="" radius="var(--r-lg)" />
		</div>
		<div class="details" {@attach sweep}>
			<HeroTitle text={mix.title} max={3.2} />
			<p class="meta hh-numeric hh-muted">
				{mix.songs.length} track{mix.songs.length === 1 ? '' : 's'}
				{#if totalDuration}<span class="dot" aria-hidden="true">·</span>{formatLongDuration(totalDuration)}{/if}
			</p>

			<div class="actions">
				<button class="hh-button hh-button--primary" onclick={() => player.playNow(mix.songs)}>
					<Icon name="play" size={16} />
					Play
				</button>
				<button class="hh-button" onclick={() => player.playShuffled(mix.songs)}>
					<Icon name="shuffle" size={16} />
					Shuffle
				</button>
				<button class="hh-button" onclick={() => player.addToQueue(mix.songs)}>
					<Icon name="queue" size={16} />
					Queue
				</button>
				<!-- Kept as a playlist, it outlasts the day. -->
				<button class="hh-button hh-button--ghost" onclick={() => addSongsToPlaylist(mix.songs, mix.title)}>
					<Icon name="plus" size={16} />
					Save as a playlist
				</button>
			</div>
		</div>
	</header>

	<section>
		<TrackList songs={mix.songs} variant="artwork" showAlbum />
	</section>
</div>

<style>
	/* The playlist page's hero, which this follows. */
	.page {
		display: grid;
		gap: var(--space-6);
		max-width: 76rem;
	}

	.hero {
		display: grid;
		grid-template-columns: minmax(0, 13rem) minmax(0, 1fr);
		gap: calc(var(--space-7) + var(--space-2));
		align-items: center;
	}

	.details {
		container-type: inline-size;
		display: grid;
		gap: var(--space-2);
		justify-items: start;
		min-width: 0;
		width: 100%;
	}

	.meta {
		margin: 0;
		font-size: 0.8125rem;
	}

	.dot {
		margin: 0 0.45rem;
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

	@media (max-width: 52rem) {
		.hero {
			grid-template-columns: minmax(0, 1fr);
			gap: var(--space-4);
		}

		.art {
			max-width: 11rem;
		}
	}
</style>
