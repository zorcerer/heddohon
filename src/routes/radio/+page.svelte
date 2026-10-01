<script lang="ts">
	/**
	 * Internet radio: the stations the music server lists. A station plays as
	 * a queue of one live item (`client/radio.ts`), through this server
	 * (`server/radio.ts`).
	 */
	import Icon from '$lib/components/Icon.svelte';
	import { player } from '$lib/client/player.svelte';
	import { radioSongId, stationSong } from '$lib/client/radio';
	import type { RadioStation } from '$lib/types';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const isCurrent = (station: RadioStation) => player.current?.id === radioSongId(station);

	function tune(station: RadioStation) {
		// The station already playing is paused and resumed, not fetched again.
		if (isCurrent(station)) void player.toggle();
		else void player.playNow([stationSong(station)]);
	}

	/** A station's page as its host, which is what fits on the row. */
	const hostOf = (url: string) => new URL(url).hostname.replace(/^www\./, '');
</script>

<svelte:head>
	<title>Radio · Heddohon</title>
</svelte:head>

<div class="page">
	<header>
		<span class="hh-eyebrow">Library</span>
		<h1>Radio</h1>
		<p class="meta hh-numeric hh-muted">
			{data.stations.length} station{data.stations.length === 1 ? '' : 's'}
		</p>
	</header>

	{#if data.stations.length === 0}
		<p class="hh-muted empty">
			{data.serverLabel || 'The music server'} has no radio stations. Its administrator adds them in its own
			settings.
		</p>
	{:else}
		<ul class="stations hh-stagger">
			{#each data.stations as station (station.id)}
				{@const current = isCurrent(station)}
				<li class="station" class:current>
					<button
						class="tune"
						onclick={() => tune(station)}
						aria-label="{current && player.engaged ? 'Pause' : 'Play'} {station.name}"
					>
						<span class="glyph">
							<Icon name={current && player.engaged ? 'pause' : 'play'} size={16} />
						</span>
						<span class="name hh-truncate">{station.name}</span>
					</button>
					{#if station.homePage}
						<!-- Another site: a new tab, told nothing about this one. -->
						<a class="home hh-muted hh-truncate" href={station.homePage} target="_blank" rel="noopener noreferrer">
							{hostOf(station.homePage)}
						</a>
					{/if}
				</li>
			{/each}
		</ul>
		<p class="hh-muted note">
			A station plays through {data.appName}'s server, which fetches its stream. It is live: there is no seeking,
			and nothing is added to your listening history.
		</p>
	{/if}
</div>

<style>
	.page {
		display: grid;
		gap: var(--space-5);
		max-width: 56rem;
	}

	header {
		display: grid;
		gap: var(--space-1);
	}

	h1 {
		margin: 0;
		font-size: 2.25rem;
		letter-spacing: -0.02em;
		color: var(--text-strong);
	}

	.meta {
		margin: 0;
		font-size: 0.8125rem;
	}

	.stations {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
	}

	.station {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		align-items: center;
		gap: var(--space-4);
		border-bottom: 1px solid var(--border-hairline);
	}

	.tune {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr);
		align-items: center;
		gap: var(--space-3);
		padding: var(--space-3) var(--space-2);
		text-align: left;
		color: var(--text-default);
		border-radius: var(--r-sm);
		transition: background var(--transition);
	}

	.tune:hover {
		background: color-mix(in srgb, var(--accent) 8%, transparent);
	}

	.glyph {
		width: 2.25rem;
		height: 2.25rem;
		border-radius: 50%;
		display: grid;
		place-items: center;
		border: 1px solid var(--border-strong);
		color: var(--text-muted);
	}

	.station.current .glyph {
		color: var(--accent);
		border-color: var(--accent);
	}

	.name {
		font-size: 1rem;
		font-weight: 600;
		color: var(--text-strong);
	}

	.station.current .name {
		color: var(--accent);
	}

	.home {
		font-size: 0.8125rem;
		max-width: 16rem;
		padding-right: var(--space-2);
	}

	.home:hover {
		color: var(--text-default);
		text-decoration: underline;
		text-underline-offset: 3px;
	}

	.note,
	.empty {
		margin: 0;
		font-size: 0.8125rem;
		max-width: 62ch;
	}
</style>
