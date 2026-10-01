<script lang="ts">
	import MediaCard from './MediaCard.svelte';
	import MediaShelf from './MediaShelf.svelte';
	import { playContainer } from '$lib/client/actions';
	import type { RememberedAlbum } from '$lib/server/history';

	/**
	 * The home page's "On this day", set as an almanac: a calendar leaf for the
	 * date, then a timeline running back from it, a mark for each earlier year
	 * with that year's albums under it. The shelf is only drawn in the browser
	 * (see the home page), so `today` is the browser's date.
	 */
	let { albums, today, index }: { albums: RememberedAlbum[]; today: Date; index: number } = $props();

	// The albums arrive the latest year first; kept in that order, one group a year.
	const years = $derived.by(() => {
		const groups: { year: number; albums: RememberedAlbum[] }[] = [];
		for (const album of albums) {
			const group = groups.at(-1);
			if (group?.year === album.year) group.albums.push(album);
			else groups.push({ year: album.year, albums: [album] });
		}
		return groups;
	});

	const ago = (year: number) => {
		const years = today.getFullYear() - year;
		return years === 1 ? 'A year ago' : `${years} years ago`;
	};

	const weekday = $derived(today.toLocaleDateString(undefined, { weekday: 'long' }));
	const month = $derived(today.toLocaleDateString(undefined, { month: 'long' }));
	const datetime = $derived(
		`${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
	);
</script>

<MediaShelf title="On this day" eyebrow="In earlier years" {index}>
	<div class="leaf">
		<p class="mark today"><span class="when hh-numeric">Today</span></p>
		<time class="page" {datetime}>
			<span class="weekday hh-eyebrow">{weekday}</span>
			<span class="day hh-display">{today.getDate()}</span>
			<span class="month">{month}</span>
		</time>
	</div>
	{#each years as group (group.year)}
		<div class="year" style:--albums={group.albums.length}>
			<p class="mark">
				<span class="when hh-numeric">{group.year}</span>
				<span class="ago hh-eyebrow">{ago(group.year)}</span>
			</p>
			<div class="albums">
				{#each group.albums as album (album.id)}
					<MediaCard
						href="/albums/{album.id}"
						title={album.name}
						subtitle={album.artist}
						coverArt={album.coverArt}
						transitionId={album.id}
						onplay={() => playContainer('album', album.id)}
					/>
				{/each}
			</div>
		</div>
	{/each}
</MediaShelf>

<style>
	/*
	 * A year's albums are one item of the shelf's line, as wide as that many
	 * cards and their gaps, so the shelf's card width and gap (both smaller on
	 * a phone) carry through by inheritance.
	 */
	.year {
		grid-column: span var(--albums);
		display: grid;
		align-content: start;
		gap: inherit;
		row-gap: 0;
	}

	.albums {
		display: grid;
		grid-auto-flow: column;
		grid-auto-columns: var(--card);
		gap: inherit;
	}

	/*
	 * The timeline: a rule along the top of the line, broken by nothing, with
	 * a mark where each year starts. It runs on through the gap after each
	 * item so the rule reads as one line from today back.
	 */
	.mark {
		position: relative;
		display: flex;
		align-items: baseline;
		gap: var(--space-2);
		height: 2.25rem;
		margin: 0 calc(-1 * var(--space-2)) 0 0;
		padding: var(--space-2) var(--space-2) 0;
		border-top: 1px solid var(--border-strong);
		white-space: nowrap;
	}

	.mark::before {
		content: '';
		position: absolute;
		top: -4px;
		left: var(--space-2);
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--bg-base);
		box-shadow: inset 0 0 0 1.5px var(--text-muted);
	}

	.mark.today::before {
		background: var(--accent);
		box-shadow: none;
	}

	.when {
		color: var(--text-strong);
		font-size: 0.9375rem;
		font-weight: 600;
	}

	.ago {
		overflow: hidden;
		text-overflow: ellipsis;
	}

	/*
	 * The date as a page torn from a day-to-a-page calendar: the size of a
	 * cover and level with the covers beside it, the day at poster scale, and
	 * a perforated top edge. It stays in the page's own colours; only the
	 * mark for today takes the accent.
	 */
	.leaf {
		display: grid;
		align-content: start;
	}

	.page {
		position: relative;
		display: grid;
		grid-template-rows: auto 1fr auto;
		justify-items: center;
		align-items: center;
		aspect-ratio: 1;
		margin: var(--space-2) var(--space-2) 0;
		padding: var(--space-3) var(--space-2) var(--space-3);
		border: 1px solid var(--border-hairline);
		border-radius: var(--r-md);
		background: var(--bg-raised);
		box-shadow: var(--float-shadow);
		text-align: center;
	}

	/* The perforation: a row of holes along the top where the page was torn off. */
	.page::before {
		content: '';
		position: absolute;
		top: 0.4rem;
		left: 0.75rem;
		right: 0.75rem;
		height: 4px;
		background: radial-gradient(circle, var(--bg-base) 1.5px, transparent 2px) 0 0 / 9px 4px repeat-x;
		opacity: 0.9;
	}

	.weekday {
		color: var(--text-muted);
	}

	.day {
		font-size: 4.25rem;
		line-height: 1;
		font-variant-numeric: tabular-nums;
	}

	.month {
		color: var(--text-default);
		font-weight: 600;
		font-size: 0.9375rem;
		letter-spacing: -0.01em;
	}

	@media (max-width: 36rem) {
		.mark {
			height: 2rem;
			margin-right: calc(-1 * var(--space-1));
			padding-inline: var(--space-1);
		}

		.mark::before {
			left: var(--space-1);
		}

		.page {
			margin: var(--space-1) var(--space-1) 0;
			padding-block: var(--space-2);
		}

		.day {
			font-size: 3rem;
		}

		.month {
			font-size: 0.8125rem;
		}
	}
</style>
