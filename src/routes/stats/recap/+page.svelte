<script lang="ts">
	/**
	 * A year or a month of listening at a glance, and a card of it to save or
	 * share as a picture. Made from the history this server keeps; the card is
	 * drawn in the browser and nothing of it is sent anywhere.
	 */
	import { onMount } from 'svelte';
	import { browser } from '$app/environment';
	import Cover from '$lib/components/Cover.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import ListeningTabs from '$lib/components/ListeningTabs.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const stats = $derived(data.stats);
	const HOUR_MS = 60 * 60 * 1000;
	const TOP = 5;

	const monthName = (month: number, style: 'long' | 'short' = 'long') =>
		new Date(Date.UTC(2024, month - 1, 1)).toLocaleDateString(undefined, { month: style, timeZone: 'UTC' });
	const title = $derived(data.month === null ? String(data.year) : `${monthName(data.month)} ${data.year}`);
	const than = $derived(data.month === null ? `${data.year - 1}` : monthName(data.month === 1 ? 12 : data.month - 1));

	/** The year or month before and after, as links; none past the current one. */
	const step = $derived.by(() => {
		const at = (year: number, month: number | null) => (month === null ? `?year=${year}` : `?year=${year}&month=${month}`);
		const nowYear = new Date(data.now).getUTCFullYear();
		const nowMonth = new Date(data.now).getUTCMonth() + 1;
		if (data.month === null) {
			return { back: at(data.year - 1, null), on: data.year < nowYear ? at(data.year + 1, null) : null };
		}
		const back = data.month === 1 ? at(data.year - 1, 12) : at(data.year, data.month - 1);
		const later = data.year < nowYear || (data.year === nowYear && data.month < nowMonth);
		const on = later ? (data.month === 12 ? at(data.year + 1, 1) : at(data.year, data.month + 1)) : null;
		return { back, on };
	});

	const hours = $derived(stats.seconds / 3600);
	const hoursText = $derived(hours < 10 ? hours.toFixed(1) : Math.round(hours).toLocaleString());

	function change(now: number, then: number | undefined): string | null {
		if (!stats.before || then === undefined || then <= 0) return null;
		const percent = Math.round(((now - then) / then) * 100);
		if (percent === 0) return `the same as ${than}`;
		return `${percent > 0 ? '+' : '−'}${Math.abs(percent).toLocaleString()}% on ${than}`;
	}

	/*
	 * The busiest day and hour are in this browser's time zone, as on the stats
	 * page, so they are worked out after the page has mounted and the server's
	 * render leaves them out.
	 */
	let local = $state(false);
	onMount(() => (local = true));

	const when = $derived.by(() => {
		const hourOfDay = Array<number>(24).fill(0);
		const months = Array<number>(12).fill(0);
		const days = new Map<number, number>();
		if (!local) return null;
		for (const [hour, plays, seconds] of stats.hours) {
			const at = new Date(hour * HOUR_MS);
			hourOfDay[at.getHours()] += plays;
			months[at.getMonth()] += plays;
			const day = new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime();
			days.set(day, (days.get(day) ?? 0) + (seconds || plays * 180));
		}
		let busiestDay: number | null = null;
		for (const [day, seconds] of days) if (busiestDay === null || seconds > (days.get(busiestDay) ?? 0)) busiestDay = day;
		const busiestHour = hourOfDay.reduce((best, value, i) => (value > hourOfDay[best] ? i : best), 0);
		return {
			busiestDay,
			busiestDaySeconds: busiestDay === null ? 0 : (days.get(busiestDay) ?? 0),
			busiestHour,
			daysListened: days.size,
			months
		};
	});

	const dayText = (day: number) => new Date(day).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
	const hourText = (hour: number) => new Date(2024, 0, 1, hour).toLocaleTimeString(undefined, { hour: 'numeric' });
	const plural = (count: number, noun: string) => `${count.toLocaleString()} ${noun}${count === 1 ? '' : 's'}`;

	/* ── The card ─────────────────────────────────────────────────────── */

	let canvas = $state<HTMLCanvasElement | null>(null);
	let sharing = $state<string | null>(null);
	const canShare = $derived(browser && typeof navigator.canShare === 'function');

	/**
	 * A token of the page as the canvas reads it, a colour or a font: the
	 * browser resolves it on an element, since a token can name another.
	 */
	function token(name: string, property: 'color' | 'fontFamily' = 'color'): string {
		const probe = document.createElement('span');
		probe.style[property] = `var(${name})`;
		document.body.append(probe);
		const value = getComputedStyle(probe)[property];
		probe.remove();
		return value;
	}

	/** The text cut to `width` with an ellipsis. */
	function fit(context: CanvasRenderingContext2D, text: string, width: number): string {
		if (context.measureText(text).width <= width) return text;
		let cut = text;
		while (cut.length > 1 && context.measureText(`${cut}…`).width > width) cut = cut.slice(0, -1);
		return `${cut.trimEnd()}…`;
	}

	/**
	 * Draws the card at 1080 by 1350, the shape the photo apps take whole: the
	 * period, the hours, the plays and the days, the five artists and tracks
	 * played most, and the busiest day. In the page's own colours and faces,
	 * so it is in the account's theme.
	 */
	function draw(): HTMLCanvasElement | null {
		if (!canvas || !when) return null;
		const context = canvas.getContext('2d');
		if (!context) return null;
		const [W, H, M] = [1080, 1350, 84];
		canvas.width = W;
		canvas.height = H;
		const display = token('--font-display', 'fontFamily') || 'sans-serif';
		const body = token('--font-body', 'fontFamily') || 'sans-serif';
		const [ground, strong, muted, accent] = [token('--bg-base'), token('--text-strong'), token('--text-muted'), token('--accent')];

		context.fillStyle = ground;
		context.fillRect(0, 0, W, H);
		context.fillStyle = accent;
		context.fillRect(0, 0, W, 14);

		context.textBaseline = 'alphabetic';
		context.fillStyle = muted;
		context.font = `500 34px ${body}`;
		context.fillText(data.month === null ? 'My year in music' : 'My month in music', M, 130);
		context.fillStyle = strong;
		context.font = `700 104px ${display}`;
		context.fillText(fit(context, title, W - 2 * M), M, 240);

		context.fillStyle = accent;
		context.font = `700 150px ${display}`;
		context.fillText(hoursText, M, 420);
		const numberWidth = context.measureText(hoursText).width;
		context.fillStyle = muted;
		context.font = `500 40px ${body}`;
		context.fillText(hours === 1 ? 'hour' : 'hours', M + numberWidth + 24, 420);
		context.fillStyle = strong;
		context.font = `500 36px ${body}`;
		context.fillText(`${plural(stats.plays, 'play')} · ${plural(stats.artists, 'artist')} · ${plural(when.daysListened, 'day')}`, M, 484);

		/** A heading and up to five rows from `top`; returns where the next block starts. */
		const list = (heading: string, rows: string[], top: number): number => {
			context.fillStyle = muted;
			context.font = `600 30px ${body}`;
			context.fillText(heading.toUpperCase(), M, top);
			const shown = rows.slice(0, TOP);
			shown.forEach((row, i) => {
				context.fillStyle = accent;
				context.font = `700 38px ${display}`;
				context.fillText(String(i + 1), M, top + 64 + i * 58);
				context.fillStyle = strong;
				context.font = `500 38px ${body}`;
				context.fillText(fit(context, row, W - 2 * M - 64), M + 64, top + 64 + i * 58);
			});
			return top + 64 + shown.length * 58 + 40;
		};
		const next = list('Top artists', stats.topArtists.map((artist) => artist.name), 580);
		list(
			'Top tracks',
			stats.topTracks.map((track) => (track.artist ? `${track.title} · ${track.artist}` : track.title)),
			next
		);

		context.fillStyle = muted;
		context.font = `500 30px ${body}`;
		if (when.busiestDay !== null) {
			context.fillText(fit(context, `Busiest day: ${dayText(when.busiestDay)}`, W - 2 * M), M, H - 96);
		}
		context.fillText('Heddohon', M, H - 48);
		return canvas;
	}

	const fileName = $derived(`heddohon-recap-${data.year}${data.month === null ? '' : `-${String(data.month).padStart(2, '0')}`}.png`);

	async function picture(): Promise<Blob | null> {
		await document.fonts?.ready;
		const drawn = draw();
		if (!drawn) return null;
		return new Promise((resolve) => drawn.toBlob(resolve, 'image/png'));
	}

	/** Saves the card, as the backup in Settings is downloaded. */
	async function save() {
		sharing = 'Drawing…';
		const blob = await picture();
		sharing = null;
		if (!blob) return;
		const url = URL.createObjectURL(blob);
		const link = document.createElement('a');
		link.href = url;
		link.download = fileName;
		link.click();
		setTimeout(() => URL.revokeObjectURL(url), 1000);
	}

	/** Hands the card to the system's share sheet, where it takes files. */
	async function share() {
		sharing = 'Drawing…';
		const blob = await picture();
		sharing = null;
		if (!blob) return;
		const file = new File([blob], fileName, { type: 'image/png' });
		if (!navigator.canShare?.({ files: [file] })) {
			sharing = 'This browser cannot share a picture. Save it instead.';
			return;
		}
		await navigator.share({ files: [file], title }).catch(() => undefined);
	}
</script>

<svelte:head>
	<title>{title} recap · Heddohon</title>
</svelte:head>

<div class="page">
	<header>
		<h1 class="hh-display">{title}</h1>
		<ListeningTabs />
		<nav class="periods" aria-label="Period">
			<a class="chip" href={step.back} data-sveltekit-noscroll aria-label="The {data.month === null ? 'year' : 'month'} before">
				<Icon name="chevron-left" size={14} />
			</a>
			{#if data.month === null}
				{#each data.years.slice(0, 6) as year (year)}
					<a class="chip" class:active={year === data.year} aria-current={year === data.year ? 'page' : undefined} href="?year={year}" data-sveltekit-noscroll>{year}</a>
				{/each}
			{:else}
				<a class="chip" href="?year={data.year}" data-sveltekit-noscroll>All of {data.year}</a>
			{/if}
			{#if step.on}
				<a class="chip" href={step.on} data-sveltekit-noscroll aria-label="The {data.month === null ? 'year' : 'month'} after">
					<Icon name="chevron-right" size={14} />
				</a>
			{/if}
		</nav>
	</header>

	{#if stats.plays === 0}
		<p class="empty hh-muted">Nothing was played in {title}, or none of it is kept.</p>
	{:else}
		<section class="figures" aria-label="In numbers">
			<div class="figure hero">
				<span class="label">Hours listened</span>
				<span class="number hh-numeric">{hoursText}</span>
				{#if change(stats.seconds, stats.before?.seconds)}<span class="hh-muted sub">{change(stats.seconds, stats.before?.seconds)}</span>{/if}
			</div>
			<div class="figure">
				<span class="label">Plays</span>
				<span class="number hh-numeric">{stats.plays.toLocaleString()}</span>
				{#if change(stats.plays, stats.before?.plays)}<span class="hh-muted sub">{change(stats.plays, stats.before?.plays)}</span>{/if}
			</div>
			<div class="figure">
				<span class="label">Artists</span>
				<span class="number hh-numeric">{stats.artists.toLocaleString()}</span>
				{#if change(stats.artists, stats.before?.artists)}<span class="hh-muted sub">{change(stats.artists, stats.before?.artists)}</span>{/if}
			</div>
			<div class="figure">
				<span class="label">Tracks</span>
				<span class="number hh-numeric">{stats.tracks.toLocaleString()}</span>
				{#if change(stats.tracks, stats.before?.tracks)}<span class="hh-muted sub">{change(stats.tracks, stats.before?.tracks)}</span>{/if}
			</div>
		</section>

		{#if when}
			<section class="figures" aria-label="When">
				<div class="figure">
					<span class="label">Busiest day</span>
					<span class="value">{when.busiestDay === null ? '–' : dayText(when.busiestDay)}</span>
					<span class="hh-muted sub">{(when.busiestDaySeconds / 3600).toFixed(1)} hours</span>
				</div>
				<div class="figure">
					<span class="label">Busiest hour</span>
					<span class="value">{hourText(when.busiestHour)}</span>
				</div>
				<div class="figure">
					<span class="label">Days with music</span>
					<span class="value hh-numeric">{when.daysListened.toLocaleString()}</span>
				</div>
			</section>

			{#if data.month === null}
				{@const max = Math.max(1, ...when.months)}
				<section aria-label="By month">
					<h2>By month</h2>
					<ol class="months">
						{#each when.months as plays, i (i)}
							<li>
								<a href="?year={data.year}&month={i + 1}" aria-label="{monthName(i + 1)}: {plural(plays, 'play')}">
									<span class="bar" style="--h: {(plays / max) * 100}%"></span>
									<span class="month" aria-hidden="true">{monthName(i + 1, 'short')}</span>
								</a>
							</li>
						{/each}
					</ol>
				</section>
			{/if}
		{/if}

		<div class="lists">
			<section>
				<h2>Top artists</h2>
				<ol class="ranked">
					{#each stats.topArtists.slice(0, 10) as artist, i (artist.id ?? artist.name)}
						<li>
							<span class="rank hh-numeric">{i + 1}</span>
							<Cover coverArt={artist.coverArt} size={64} alt="" radius="var(--r-sm)" />
							<span class="name hh-truncate">
								{#if artist.id}<a href="/artists/{artist.id}">{artist.name}</a>{:else}{artist.name}{/if}
							</span>
							<span class="hh-numeric hh-muted">{plural(artist.plays, 'play')}</span>
						</li>
					{/each}
				</ol>
			</section>
			<section>
				<h2>Top albums</h2>
				<ol class="ranked">
					{#each stats.topAlbums.slice(0, 10) as album, i (album.id)}
						<li>
							<span class="rank hh-numeric">{i + 1}</span>
							<Cover coverArt={album.coverArt} size={64} alt="" radius="var(--r-sm)" />
							<span class="name hh-truncate"><a href="/albums/{album.id}">{album.name}</a></span>
							<span class="hh-numeric hh-muted">{plural(album.plays, 'play')}</span>
						</li>
					{/each}
				</ol>
			</section>
			<section>
				<h2>Top tracks</h2>
				<ol class="ranked">
					{#each stats.topTracks.slice(0, 10) as track, i (track.id)}
						<li>
							<span class="rank hh-numeric">{i + 1}</span>
							<Cover coverArt={track.coverArt} size={64} alt="" radius="var(--r-sm)" />
							<span class="name hh-truncate">
								{#if track.albumId}<a href="/albums/{track.albumId}">{track.title}</a>{:else}{track.title}{/if}
								{#if track.artist}<span class="hh-muted"> · {track.artist}</span>{/if}
							</span>
							<span class="hh-numeric hh-muted">{plural(track.plays, 'play')}</span>
						</li>
					{/each}
				</ol>
			</section>
			{#if stats.newArtists.length > 0}
				<section>
					<h2>First heard in {title}</h2>
					<ol class="ranked">
						{#each stats.newArtists.slice(0, 10) as artist, i (artist.id ?? artist.name)}
							<li>
								<span class="rank hh-numeric">{i + 1}</span>
								<Cover coverArt={artist.coverArt} size={64} alt="" radius="var(--r-sm)" />
								<span class="name hh-truncate">
									{#if artist.id}<a href="/artists/{artist.id}">{artist.name}</a>{:else}{artist.name}{/if}
								</span>
							</li>
						{/each}
					</ol>
				</section>
			{/if}
		</div>

		<section class="card" aria-label="A card to share">
			<h2>A card to share</h2>
			<div class="card-actions">
				<button class="hh-button hh-button--primary" type="button" onclick={save} disabled={!when}>
					<Icon name="download" size={16} />
					Save as a picture
				</button>
				{#if canShare}
					<button class="hh-button" type="button" onclick={share} disabled={!when}>
						<Icon name="share" size={16} />
						Share
					</button>
				{/if}
			</div>
			{#if sharing}<p class="hh-muted note" role="status">{sharing}</p>{/if}
			<canvas bind:this={canvas} class="hh-visually-hidden" aria-hidden="true"></canvas>
		</section>
	{/if}
</div>

<style>
	.page {
		display: grid;
		gap: var(--space-6);
		max-width: 64rem;
	}

	header {
		display: grid;
		gap: var(--space-2);
	}

	h1 {
		margin: 0;
	}

	h2 {
		margin: 0 0 var(--space-3);
		font-size: 1rem;
	}

	.periods {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-1);
		margin-top: var(--space-2);
	}

	.chip {
		display: inline-flex;
		align-items: center;
		padding: 0.3rem 0.75rem;
		border: 1px solid var(--border-hairline);
		border-radius: var(--r-pill);
		color: var(--text-muted);
		font-size: 0.8125rem;
	}

	.chip:hover,
	.chip:focus-visible {
		color: var(--text-strong);
		border-color: var(--border-strong);
	}

	.chip.active {
		color: var(--accent-contrast);
		background: var(--accent);
		border-color: var(--accent);
	}

	.figures {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr));
		gap: var(--space-4);
	}

	.figure {
		display: grid;
		align-content: start;
		gap: var(--space-1);
		padding-top: var(--space-3);
		border-top: 1px solid var(--border-hairline);
	}

	.label {
		color: var(--text-muted);
		font-size: 0.8125rem;
	}

	.number {
		color: var(--text-strong);
		font-size: 2rem;
		font-weight: 700;
		line-height: 1.1;
	}

	.hero .number {
		color: var(--accent);
		font-size: 3rem;
	}

	.value {
		color: var(--text-strong);
		font-size: 1.125rem;
		font-weight: 600;
	}

	.sub {
		font-size: 0.8125rem;
	}

	.months {
		display: grid;
		grid-template-columns: repeat(12, minmax(0, 1fr));
		gap: var(--space-2);
		height: 9rem;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.months a {
		display: grid;
		grid-template-rows: minmax(0, 1fr) auto;
		gap: var(--space-1);
		height: 100%;
		color: var(--text-muted);
		font-size: 0.75rem;
		text-align: center;
	}

	.months .bar {
		align-self: end;
		height: var(--h);
		min-height: 2px;
		border-radius: var(--r-sm) var(--r-sm) 0 0;
		background: var(--accent);
		opacity: 0.8;
	}

	.months a:hover .bar,
	.months a:focus-visible .bar {
		opacity: 1;
	}

	.lists {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(19rem, 1fr));
		gap: var(--space-6);
	}

	.ranked {
		display: grid;
		gap: var(--space-2);
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.ranked li {
		display: grid;
		grid-template-columns: 1.5rem 2.5rem minmax(0, 1fr) auto;
		align-items: center;
		gap: var(--space-3);
		font-size: 0.875rem;
	}

	.rank {
		color: var(--accent);
		font-weight: 700;
		text-align: right;
	}

	.name {
		color: var(--text-strong);
	}

	.name a:hover {
		text-decoration: underline;
	}

	.card {
		display: grid;
		gap: var(--space-2);
		padding-top: var(--space-4);
		border-top: 1px solid var(--border-hairline);
	}

	.card h2 {
		margin: 0;
	}

	.card-actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
	}

	.note,
	.empty {
		margin: 0;
		font-size: 0.875rem;
	}

	@media (max-width: 40rem) {
		.months {
			gap: 2px;
		}
	}
</style>
