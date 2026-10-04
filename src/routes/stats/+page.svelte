<script lang="ts">
	import { onMount } from 'svelte';
	import Cover from '$lib/components/Cover.svelte';
	import ListeningTabs from '$lib/components/ListeningTabs.svelte';
	import MediaCard from '$lib/components/MediaCard.svelte';
	import MediaGrid from '$lib/components/MediaGrid.svelte';
	import SectionHeader from '$lib/components/SectionHeader.svelte';
	import { playContainer } from '$lib/client/actions';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const stats = $derived(data.stats);

	const PERIODS = [
		{ id: 'month', label: 'Last 30 days' },
		{ id: 'quarter', label: 'Last 90 days' },
		{ id: 'year', label: 'This year' },
		{ id: 'all', label: 'Everything kept' }
	] as const;

	const HOUR_MS = 60 * 60 * 1000;

	const plural = (count: number, noun: string) => `${count.toLocaleString()} ${noun}${count === 1 ? '' : 's'}`;
	const hoursListened = $derived(stats.seconds / 3600);

	/*
	 * The hour of the day, the day of the week and the runs of days are the
	 * listener's own, in this browser's time zone, which the server does not
	 * know. They are worked out here once the page is in the browser; the
	 * server's render leaves them out, so the two renders agree.
	 */
	let local = $state(false);
	onMount(() => (local = true));

	const byLocalTime = $derived.by(() => {
		const hourOfDay = Array<number>(24).fill(0);
		// Monday first.
		const dayOfWeek = Array<number>(7).fill(0);
		const days = new Set<number>();
		if (!local) return { hourOfDay, dayOfWeek, streak: 0 };
		for (const [hour, plays] of stats.hours) {
			const at = new Date(hour * HOUR_MS);
			hourOfDay[at.getHours()] += plays;
			dayOfWeek[(at.getDay() + 6) % 7] += plays;
			days.add(new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime());
		}
		// The longest run of calendar days each with a play. A day is 23 or 25
		// hours at a clock change, so neighbours are found by the date.
		const sorted = [...days].sort((a, b) => a - b);
		let streak = 0;
		let run = 0;
		for (let i = 0; i < sorted.length; i++) {
			const previous = i > 0 ? new Date(sorted[i - 1]) : null;
			if (previous) previous.setDate(previous.getDate() + 1);
			run = previous && previous.getTime() === sorted[i] ? run + 1 : 1;
			streak = Math.max(streak, run);
		}
		return { hourOfDay, dayOfWeek, streak };
	});

	const weekdayNames = $derived(
		// 2024-01-01 was a Monday.
		Array.from({ length: 7 }, (_, i) =>
			new Date(2024, 0, 1 + i).toLocaleDateString(undefined, { weekday: 'long' })
		)
	);
	const hourName = (hour: number) =>
		new Date(2024, 0, 1, hour).toLocaleTimeString(undefined, { hour: 'numeric' });

	const peak = (values: number[]) => values.reduce((best, value, i) => (value > values[best] ? i : best), 0);
	const busiestHour = $derived(peak(byLocalTime.hourOfDay));
	const busiestDay = $derived(peak(byLocalTime.dayOfWeek));

	const since = $derived(
		data.from > 0 ? new Date(data.from).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' }) : null
	);
	const topArtistPlays = $derived(stats.topArtists[0]?.plays ?? 1);
</script>

<svelte:head>
	<title>Your listening · Heddohon</title>
</svelte:head>

{#snippet columns(values: number[], names: string[], label: string, tick: (i: number) => string | null)}
	{@const max = Math.max(1, ...values)}
	{@const top = peak(values)}
	<figure class="chart">
		<div class="plot" role="group" aria-label={label}>
			{#each values as value, i (i)}
				<div class="column" class:peak={i === top && value > 0} role="img" aria-label="{names[i]}: {plural(value, 'play')}" style="--h: {(value / max) * 100}%">
					{#if i === top && value > 0}
						<span class="value hh-numeric">{value.toLocaleString()}</span>
					{/if}
					<span class="bar"></span>
					<span class="tip hh-numeric" aria-hidden="true">{names[i]} · {plural(value, 'play')}</span>
				</div>
			{/each}
		</div>
		<div class="axis" aria-hidden="true">
			{#each values as _, i (i)}
				<span>{tick(i) ?? ''}</span>
			{/each}
		</div>
		<details class="table">
			<summary>As a table</summary>
			<table>
				<thead><tr><th scope="col">{label}</th><th scope="col">Plays</th></tr></thead>
				<tbody>
					{#each values as value, i (i)}
						<tr><th scope="row">{names[i]}</th><td class="hh-numeric">{value.toLocaleString()}</td></tr>
					{/each}
				</tbody>
			</table>
		</details>
	</figure>
{/snippet}

<div class="page">
	<header>
		<span class="hh-eyebrow">Kept on this server, for you alone</span>
		<h1 class="hh-display">Your listening</h1>
		<ListeningTabs />
		<nav class="periods" aria-label="Period">
			{#each PERIODS as period (period.id)}
				<a class="chip" class:active={data.period === period.id} aria-current={data.period === period.id ? 'page' : undefined} href="/stats?period={period.id}" data-sveltekit-noscroll>
					{period.label}
				</a>
			{/each}
		</nav>
		{#if (data.period === 'year' || data.period === 'all') && data.historyDays === 90}
			<p class="hh-muted note">
				History is kept for 90 days. <a href="/settings?tab=history">Keep it longer</a> to sum up a year.
			</p>
		{/if}
	</header>

	{#if stats.plays === 0}
		<p class="empty hh-muted">
			Nothing played {since ? `since ${since}` : 'yet'}. A track counts once it has played for half its length, or
			four minutes.
		</p>
	{:else}
		<section class="figures" aria-label="In numbers">
			<div class="figure hero">
				<span class="label">Plays</span>
				<span class="number hh-numeric">{stats.plays.toLocaleString()}</span>
				{#if since}<span class="hh-muted sub">since {since}</span>{/if}
			</div>
			<div class="figure">
				<span class="label">Hours listened</span>
				<span class="number hh-numeric">{hoursListened < 10 ? hoursListened.toFixed(1) : Math.round(hoursListened).toLocaleString()}</span>
			</div>
			<div class="figure">
				<span class="label">Artists</span>
				<span class="number hh-numeric">{stats.artists.toLocaleString()}</span>
			</div>
			<div class="figure">
				<span class="label">Tracks</span>
				<span class="number hh-numeric">{stats.tracks.toLocaleString()}</span>
			</div>
			<div class="figure">
				<span class="label">Longest run</span>
				<span class="number hh-numeric">{local ? byLocalTime.streak : '·'}</span>
				<span class="hh-muted sub">days in a row</span>
			</div>
		</section>

		{#if local}
			<section class="when">
				<div>
					<SectionHeader title="Time of day" eyebrow={`Most at ${hourName(busiestHour)}`} />
					{@render columns(
						byLocalTime.hourOfDay,
						Array.from({ length: 24 }, (_, h) => hourName(h)),
						'Hour of the day',
						(h) => (h % 6 === 0 ? hourName(h) : null)
					)}
				</div>
				<div>
					<SectionHeader title="Day of the week" eyebrow={`Most on ${weekdayNames[busiestDay]}`} />
					{@render columns(byLocalTime.dayOfWeek, weekdayNames, 'Day of the week', (d) => weekdayNames[d].slice(0, 3))}
				</div>
			</section>
		{/if}

		{#if stats.topArtists.length > 0}
			<section>
				<SectionHeader title="Top artists" />
				<ol class="ranked">
					{#each stats.topArtists as artist, rank (artist.id ?? artist.name)}
						<li>
							<span class="rank hh-numeric">{rank + 1}</span>
							<span class="thumb"><Cover coverArt={artist.coverArt} size={96} alt="" radius="50%" fill /></span>
							<span class="name hh-truncate">
								{#if artist.id}<a href="/artists/{artist.id}">{artist.name}</a>{:else}{artist.name}{/if}
							</span>
							<span class="meter" aria-hidden="true"><span style="width: {(artist.plays / topArtistPlays) * 100}%"></span></span>
							<span class="count hh-numeric">{plural(artist.plays, 'play')}</span>
						</li>
					{/each}
				</ol>
			</section>
		{/if}

		{#if stats.topAlbums.length > 0}
			<section>
				<SectionHeader title="Top albums" />
				<MediaGrid density="compact">
					{#each stats.topAlbums as album (album.id)}
						<MediaCard
							href="/albums/{album.id}"
							title={album.name}
							subtitle={[album.artist, plural(album.plays, 'play')].filter(Boolean).join(' · ')}
							coverArt={album.coverArt}
							onplay={() => playContainer('album', album.id)}
						/>
					{/each}
				</MediaGrid>
			</section>
		{/if}

		{#if stats.topTracks.length > 0}
			<section>
				<SectionHeader title="Top tracks" />
				<ol class="ranked">
					{#each stats.topTracks as track, rank (track.id)}
						<li>
							<span class="rank hh-numeric">{rank + 1}</span>
							<span class="thumb"><Cover coverArt={track.coverArt} size={96} alt="" radius="var(--r-sm)" fill /></span>
							<span class="name hh-truncate">
								{#if track.albumId}<a href="/albums/{track.albumId}">{track.title}</a>{:else}{track.title}{/if}
								{#if track.artist}<span class="hh-muted"> · {track.artist}</span>{/if}
							</span>
							<span class="count hh-numeric">{plural(track.plays, 'play')}</span>
						</li>
					{/each}
				</ol>
			</section>
		{/if}

		{#if stats.newArtists.length > 0}
			<section>
				<SectionHeader title="New to you" eyebrow="First played in this period" />
				<ul class="new">
					{#each stats.newArtists as artist (artist.id ?? artist.name)}
						<li>
							{#if artist.id}<a class="chip" href="/artists/{artist.id}">{artist.name}</a>{:else}<span class="chip">{artist.name}</span>{/if}
							<span class="hh-muted hh-numeric">{artist.plays}</span>
						</li>
					{/each}
				</ul>
			</section>
		{/if}
	{/if}
</div>

<style>
	.page {
		display: grid;
		gap: var(--space-6);
		max-width: var(--grid-max);
	}

	header {
		display: grid;
		gap: 0.3rem;
		padding-bottom: var(--space-4);
		border-bottom: 1px solid var(--border-hairline);
	}

	h1 {
		margin: 0.2rem 0 var(--space-2);
		font-size: clamp(2.25rem, 1.4rem + 2.6vw, 3.5rem);
	}

	.periods {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-1);
	}

	/* The sort chips' material; see `SortChips`. */
	.chip {
		display: inline-block;
		padding: 0.3rem 0.75rem;
		border-radius: var(--r-pill);
		border: 1px solid var(--border-hairline);
		background: var(--control-face);
		color: var(--text-muted-through);
		font-size: 0.8125rem;
		font-weight: 500;
		white-space: nowrap;
		text-decoration: none;
		transition:
			color var(--transition),
			border-color var(--transition);
	}

	.chip:hover,
	.chip.active {
		color: var(--text-strong);
		border-color: var(--border-strong);
	}

	.chip.active {
		background: color-mix(in srgb, var(--accent) 18%, var(--control-face));
	}

	.note {
		margin: var(--space-2) 0 0;
		font-size: 0.8125rem;
	}

	.empty {
		padding: var(--space-7);
		text-align: center;
	}

	/* A row of figures, the first set large as the one the page leads with. */
	.figures {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr));
		gap: var(--space-2);
	}

	.figure {
		display: grid;
		align-content: start;
		gap: 0.15rem;
		padding: var(--space-3) var(--space-4);
		border-radius: var(--r-lg);
		border: 1px solid var(--border-hairline);
		background: var(--control-face);
	}

	.figure .label {
		font-size: 0.8125rem;
		color: var(--text-muted);
	}

	.figure .number {
		font-size: 1.75rem;
		font-weight: 600;
		color: var(--text-strong);
		font-variant-numeric: proportional-nums;
	}

	.figure.hero .number {
		font-size: 3rem;
		line-height: 1.05;
	}

	.figure .sub {
		font-size: 0.75rem;
	}

	.when {
		display: grid;
		grid-template-columns: minmax(0, 2fr) minmax(0, 1fr);
		gap: var(--space-6);
	}

	@media (max-width: 52rem) {
		.when {
			grid-template-columns: minmax(0, 1fr);
		}
	}

	/*
	 * Columns in one hue, the room's accent: the busiest at full strength and
	 * the rest at 40%, so the peak is the thing read first. Columns are at most
	 * 24px, rounded 4px at the top and square at the baseline, with the gap
	 * between them left as air.
	 */
	.chart {
		margin: 0;
		display: grid;
		gap: var(--space-1);
	}

	/* Room above the tallest column for its value. */
	.plot {
		display: flex;
		align-items: flex-end;
		gap: 2px;
		height: 10rem;
		padding-top: 1.25rem;
		border-bottom: 1px solid var(--border-hairline);
	}

	.column {
		position: relative;
		flex: 1;
		height: 100%;
		display: flex;
		justify-content: center;
		align-items: flex-end;
	}

	/* Its height from `--h` on the column, the share of the tallest. */
	.bar {
		display: block;
		width: min(100%, 24px);
		height: var(--h);
		min-height: 1px;
		border-radius: 4px 4px 0 0;
		background: color-mix(in srgb, var(--accent) 40%, transparent);
		transition: background var(--transition);
	}

	.column.peak .bar,
	.column:hover .bar {
		background: var(--accent);
	}

	/* Above the bar and out of the column's flow: in it, the label took height
	   from the bar it labels, and the peak was drawn shorter than the rest. */
	.value {
		position: absolute;
		bottom: calc(var(--h) + 0.2rem);
		font-size: 0.75rem;
		color: var(--text-default);
	}

	.tip {
		position: absolute;
		bottom: calc(100% + 0.4rem);
		left: 50%;
		translate: -50% 0;
		padding: 0.25rem 0.5rem;
		border-radius: var(--r-sm);
		background: var(--bg-raised);
		border: 1px solid var(--border-strong);
		color: var(--text-strong);
		font-size: 0.75rem;
		white-space: nowrap;
		pointer-events: none;
		opacity: 0;
		transition: opacity var(--dur-hover) var(--ease-out);
		z-index: 1;
	}

	.column:hover .tip {
		opacity: 1;
	}

	.axis {
		display: flex;
		gap: 2px;
		font-size: 0.6875rem;
		color: var(--text-muted);
	}

	.axis span {
		flex: 1;
		white-space: nowrap;
		overflow: visible;
	}

	.table summary {
		cursor: pointer;
		font-size: 0.75rem;
		color: var(--text-muted);
	}

	.table table {
		margin-top: var(--space-2);
		border-collapse: collapse;
		font-size: 0.8125rem;
	}

	.table th,
	.table td {
		padding: 0.15rem var(--space-3) 0.15rem 0;
		text-align: left;
		font-weight: 400;
	}

	.ranked {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 2px;
	}

	.ranked li {
		display: grid;
		grid-template-columns: 1.75rem 2.5rem minmax(0, 1fr) minmax(4rem, 10rem) auto;
		align-items: center;
		gap: var(--space-3);
		padding: 0.3rem 0;
	}

	.ranked li:not(:has(.meter)) {
		grid-template-columns: 1.75rem 2.5rem minmax(0, 1fr) auto;
	}

	.rank {
		color: var(--text-muted);
		text-align: right;
	}

	.thumb {
		display: block;
		width: 2.5rem;
		height: 2.5rem;
	}

	.name a {
		color: var(--text-strong);
		text-decoration: none;
	}

	.name a:hover {
		color: var(--glow-color);
	}

	.meter {
		height: 0.35rem;
		border-radius: var(--r-pill);
		background: color-mix(in srgb, var(--accent) 12%, transparent);
		overflow: hidden;
	}

	.meter span {
		display: block;
		height: 100%;
		background: var(--accent);
		border-radius: var(--r-pill);
	}

	.count {
		font-size: 0.8125rem;
		color: var(--text-muted);
	}

	.new {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
	}

	.new li {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
	}

	@media (max-width: 36rem) {
		.ranked li {
			grid-template-columns: 1.5rem 2.25rem minmax(0, 1fr) auto;
		}

		.meter {
			display: none;
		}
	}
</style>
