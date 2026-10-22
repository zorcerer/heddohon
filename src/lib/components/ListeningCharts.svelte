<script lang="ts">
	/**
	 * When the listening happened, as four views of one series: day by day, a
	 * calendar, the hour against the day of the week, and the parts of the day.
	 *
	 * All of it is made here from plays by the hour, since the calendar day and
	 * the hour of the day are this browser's and the server does not know its
	 * time zone. The page mounts this only in the browser.
	 *
	 * One hue throughout, the accent, lighter to stronger for more: the charts
	 * show how much, and nothing in them is a category. Each has its values as
	 * a table under it, for a reader the picture does not reach.
	 */
	import SectionHeader from './SectionHeader.svelte';

	let {
		hours,
		from,
		to
	}: {
		/** `[hours since the epoch, plays, seconds]`, in order. */
		hours: [number, number, number][];
		/** The start of the period, or 0 for everything kept. */
		from: number;
		/** The moment the figures were read at. */
		to: number;
	} = $props();

	const HOUR_MS = 60 * 60 * 1000;
	/** Past this many days the trend is by the week: a year of days is a line too fine to read. */
	const DAILY_UP_TO = 92;
	/** The calendar shows at most this many weeks, the last ones. */
	const CALENDAR_WEEKS = 53;

	interface Day {
		at: Date;
		plays: number;
		seconds: number;
	}

	const dayStart = (at: Date) => new Date(at.getFullYear(), at.getMonth(), at.getDate());
	const nextDay = (at: Date) => new Date(at.getFullYear(), at.getMonth(), at.getDate() + 1);
	/** Monday first. */
	const weekday = (at: Date) => (at.getDay() + 6) % 7;

	const series = $derived.by(() => {
		const byDay = new Map<number, { plays: number; seconds: number }>();
		// Rows are days of the week from Monday, columns the hours of the day.
		const grid = Array.from({ length: 7 }, () => Array<number>(24).fill(0));
		const parts = [0, 0, 0, 0];
		for (const [hour, plays, seconds] of hours) {
			const at = new Date(hour * HOUR_MS);
			const key = dayStart(at).getTime();
			const day = byDay.get(key) ?? { plays: 0, seconds: 0 };
			day.plays += plays;
			day.seconds += seconds;
			byDay.set(key, day);
			grid[weekday(at)][at.getHours()] += plays;
			parts[Math.floor(at.getHours() / 6)] += plays;
		}
		// Every day of the period, with the days nothing played on, to the day
		// the figures were read. Everything kept starts at its first play.
		const first = hours.length > 0 ? new Date(hours[0][0] * HOUR_MS) : new Date(to);
		const start = dayStart(from > 0 ? new Date(from) : first);
		const end = dayStart(new Date(to));
		const days: Day[] = [];
		// Stepped by the date: a day is 23 or 25 hours at a clock change.
		for (let at = start; at <= end; at = nextDay(at)) {
			const found = byDay.get(at.getTime());
			days.push({ at, plays: found?.plays ?? 0, seconds: found?.seconds ?? 0 });
		}
		return { days, grid, parts };
	});

	const plural = (count: number, noun: string) => `${count.toLocaleString()} ${noun}${count === 1 ? '' : 's'}`;
	const length = (seconds: number) => {
		const minutes = Math.round(seconds / 60);
		return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
	};
	const dayName = (at: Date) => at.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
	const shortDay = (at: Date) => at.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
	const weekdayNames = Array.from({ length: 7 }, (_, i) =>
		// 2024-01-01 was a Monday.
		new Date(2024, 0, 1 + i).toLocaleDateString(undefined, { weekday: 'long' })
	);
	const hourName = (hour: number) => new Date(2024, 0, 1, hour).toLocaleTimeString(undefined, { hour: 'numeric' });

	/** A count as one of five steps: none, and four of rising strength by its share of the most. */
	const level = (value: number, most: number) => (value <= 0 || most <= 0 ? 0 : Math.min(4, Math.ceil((value / most) * 4)));

	// ── Day by day ─────────────────────────────────────────────────────────

	interface Bucket {
		label: string;
		plays: number;
		seconds: number;
	}

	const trend = $derived.by(() => {
		const { days } = series;
		const weekly = days.length > DAILY_UP_TO;
		const buckets: Bucket[] = [];
		if (!weekly) {
			for (const day of days) buckets.push({ label: dayName(day.at), plays: day.plays, seconds: day.seconds });
		} else {
			// Weeks from Monday. The first and the last may be part of one.
			let open: (Bucket & { first: Date; last: Date }) | null = null;
			const close = () => {
				if (open) buckets.push({ ...open, label: `${shortDay(open.first)} to ${dayName(open.last)}` });
			};
			for (const day of days) {
				if (!open || weekday(day.at) === 0) {
					close();
					open = { label: '', plays: 0, seconds: 0, first: day.at, last: day.at };
				}
				open.plays += day.plays;
				open.seconds += day.seconds;
				open.last = day.at;
			}
			close();
		}
		const most = Math.max(1, ...buckets.map((bucket) => bucket.plays));
		const peak = buckets.reduce((best, bucket, i) => (bucket.plays > buckets[best].plays ? i : best), 0);
		// The plot is 100 by 100 and stretched to its box; the line keeps its
		// width through `vector-effect`.
		const x = (i: number) => (buckets.length === 1 ? 50 : (i / (buckets.length - 1)) * 100);
		const y = (plays: number) => 100 - (plays / most) * 100;
		const points = buckets.map((bucket, i) => `${x(i).toFixed(2)},${y(bucket.plays).toFixed(2)}`);
		return {
			weekly,
			buckets,
			most,
			peak,
			x,
			y,
			line: `M${points.join('L')}`,
			area: `M0,100L${points.join('L')}L100,100Z`,
			firstLabel: days.length > 0 ? shortDay(days[0].at) : '',
			lastLabel: days.length > 0 ? shortDay(days[days.length - 1].at) : ''
		};
	});

	/** The bucket under the pointer or the arrow keys, for the crosshair and its line of text. */
	let at = $state<number | null>(null);
	const shown = $derived(at !== null ? (trend.buckets[at] ?? null) : null);

	function follow(event: PointerEvent) {
		const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
		const share = Math.min(1, Math.max(0, (event.clientX - box.left) / box.width));
		at = Math.round(share * (trend.buckets.length - 1));
	}

	function step(event: KeyboardEvent) {
		const last = trend.buckets.length - 1;
		if (event.key === 'ArrowRight') at = Math.min(last, (at ?? -1) + 1);
		else if (event.key === 'ArrowLeft') at = Math.max(0, (at ?? last + 1) - 1);
		else if (event.key === 'Home') at = 0;
		else if (event.key === 'End') at = last;
		else if (event.key === 'Escape') at = null;
		else return;
		event.preventDefault();
	}

	// ── The calendar ───────────────────────────────────────────────────────

	const calendar = $derived.by(() => {
		const all = series.days;
		// Whole weeks: the first column starts on its Monday, with the days
		// before the period left empty.
		const cells: (Day | null)[] = [];
		const lead = all.length > 0 ? weekday(all[0].at) : 0;
		for (let i = 0; i < lead; i++) cells.push(null);
		cells.push(...all);
		const weeks: (Day | null)[][] = [];
		for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
		const kept = weeks.slice(-CALENDAR_WEEKS);
		const most = Math.max(0, ...kept.flat().map((day) => day?.plays ?? 0));
		// A month is named over the column its first day is in.
		const months = kept.map((week, i) => {
			const first = week.find((day) => day && day.at.getDate() === 1);
			const opening = i === 0 ? week.find((day) => day) : null;
			const named = first ?? opening;
			return named ? named.at.toLocaleDateString(undefined, { month: 'short' }) : '';
		});
		// Two names would overlap where a period opens a few days before a month does.
		if (months.length > 1 && months[0] && months[1]) months[0] = '';
		return { weeks: kept, most, months, cut: weeks.length > kept.length };
	});

	const gridMost = $derived(Math.max(0, ...series.grid.flat()));
	const partsTotal = $derived(Math.max(1, series.parts.reduce((sum, value) => sum + value, 0)));
	const PARTS = [
		{ name: 'Night', span: 'midnight to 6' },
		{ name: 'Morning', span: '6 to noon' },
		{ name: 'Afternoon', span: 'noon to 6' },
		{ name: 'Evening', span: '6 to midnight' }
	];
	const busiestPart = $derived(series.parts.reduce((best, value, i) => (value > series.parts[best] ? i : best), 0));
	const busiestCell = $derived.by(() => {
		let best = { day: 0, hour: 0, plays: 0 };
		series.grid.forEach((row, day) => row.forEach((plays, hour) => plays > best.plays && (best = { day, hour, plays })));
		return best;
	});

	/*
	 * One line of text for the cell under the pointer, drawn by the pointer.
	 * A cell is 11px, so the text cannot be inside it. The cells say the same
	 * in their labels, and the tables under the charts hold every value.
	 */
	let tip = $state<{ text: string; x: number; y: number; left: boolean } | null>(null);
	function point(event: PointerEvent) {
		const cell = (event.target as HTMLElement).closest<HTMLElement>('[data-tip]');
		// To the right of the pointer, and to its left in the last 18rem of the
		// window. Centred on the pointer, it ran under the rail from the
		// calendar's first weeks.
		tip = cell
			? { text: cell.dataset.tip ?? '', x: event.clientX, y: event.clientY, left: event.clientX > innerWidth - 288 }
			: null;
	}
</script>

{#snippet scale()}
	<p class="scale hh-muted" aria-hidden="true">
		Fewer
		{#each [0, 1, 2, 3, 4] as step (step)}<span class="cell" data-level={step}></span>{/each}
		More
	</p>
{/snippet}

<section class="trend">
	<SectionHeader
		title={trend.weekly ? 'Week by week' : 'Day by day'}
	/>
	<figure class="chart">
		<!-- A slider along the line: one stop for the keyboard, moved by the
		     arrow keys, with the day it is on and its plays as its value. -->
		<div
			class="plot"
			role="slider"
			tabindex="0"
			aria-orientation="horizontal"
			aria-label="Plays {trend.weekly ? 'by week' : 'by day'}, {trend.firstLabel} to {trend.lastLabel}"
			aria-valuemin={0}
			aria-valuemax={Math.max(0, trend.buckets.length - 1)}
			aria-valuenow={at ?? Math.max(0, trend.buckets.length - 1)}
			aria-valuetext={shown ? `${shown.label}: ${plural(shown.plays, 'play')}` : 'No day chosen'}
			onpointermove={follow}
			onpointerleave={() => (at = null)}
			onkeydown={step}
			onblur={() => (at = null)}
		>
			<svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
				<path class="area" d={trend.area} />
				<path class="line" d={trend.line} />
			</svg>
			{#if shown && at !== null}
				<span class="cross" style:left="{trend.x(at)}%"></span>
				<span class="dot" style:left="{trend.x(at)}%" style:top="{trend.y(shown.plays)}%"></span>
			{/if}
			<span class="most hh-numeric" aria-hidden="true">{trend.most.toLocaleString()}</span>
		</div>
		<div class="ends hh-numeric" aria-hidden="true"><span>{trend.firstLabel}</span><span>{trend.lastLabel}</span></div>
		<p class="readout hh-numeric">
			{#if shown}
				{shown.label} · {plural(shown.plays, 'play')}{shown.seconds > 0 ? ` · ${length(shown.seconds)}` : ''}
			{/if}
		</p>
		<details class="table">
			<summary>As a table</summary>
			<table>
				<thead><tr><th scope="col">{trend.weekly ? 'Week' : 'Day'}</th><th scope="col">Plays</th><th scope="col">Time</th></tr></thead>
				<tbody>
					{#each trend.buckets as bucket, i (i)}
						<tr><th scope="row">{bucket.label}</th><td class="hh-numeric">{bucket.plays.toLocaleString()}</td><td class="hh-numeric">{length(bucket.seconds)}</td></tr>
					{/each}
				</tbody>
			</table>
		</details>
	</figure>
</section>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="maps" onpointermove={point} onpointerleave={() => (tip = null)}>
	<section>
		<SectionHeader title="Calendar" />
		<figure class="chart">
			<!-- Where a year does not fit the column it scrolls, and opens on its
			     last weeks: the newest days are the ones looked for. -->
			<div
				class="calendar"
				style:--weeks={calendar.weeks.length}
				{@attach (node) => {
					node.scrollLeft = node.scrollWidth;
				}}
			>
				<div class="months hh-numeric" aria-hidden="true">
					{#each calendar.months as month, i (i)}<span>{month}</span>{/each}
				</div>
				<div class="days-of-week hh-numeric" aria-hidden="true">
					{#each weekdayNames as name, i (i)}<span>{i % 2 === 0 ? name.slice(0, 3) : ''}</span>{/each}
				</div>
				<div class="weeks" role="img" aria-label="Plays on each day, as a calendar of {calendar.weeks.length} weeks. The table under it has each day.">
					{#each calendar.weeks as week, w (w)}
						{#each week as day, d (d)}
							{#if day}
								<span
									class="cell"
									data-level={level(day.plays, calendar.most)}
									data-tip="{dayName(day.at)} · {plural(day.plays, 'play')}{day.seconds > 0 ? ` · ${length(day.seconds)}` : ''}"
								></span>
							{:else}
								<span class="cell blank"></span>
							{/if}
						{/each}
					{/each}
				</div>
			</div>
			{@render scale()}
			<details class="table">
				<summary>As a table</summary>
				<table>
					<thead><tr><th scope="col">Day</th><th scope="col">Plays</th><th scope="col">Time</th></tr></thead>
					<tbody>
						{#each calendar.weeks.flat() as day, i (i)}
							{#if day && day.plays > 0}
								<tr><th scope="row">{dayName(day.at)}</th><td class="hh-numeric">{day.plays.toLocaleString()}</td><td class="hh-numeric">{length(day.seconds)}</td></tr>
							{/if}
						{/each}
					</tbody>
				</table>
			</details>
		</figure>
	</section>

	<section>
		<SectionHeader
			title="Hour by day of the week"
		/>
		<figure class="chart">
			<div class="punch">
				<div class="hour-names hh-numeric" aria-hidden="true">
					{#each Array(24) as _, hour (hour)}<span>{hour % 6 === 0 ? hourName(hour) : ''}</span>{/each}
				</div>
				{#each series.grid as row, day (day)}
					<span class="day-name hh-numeric" aria-hidden="true">{weekdayNames[day].slice(0, 3)}</span>
					<div class="row" role="img" aria-label="{weekdayNames[day]}: {plural(row.reduce((sum, value) => sum + value, 0), 'play')}">
						{#each row as plays, hour (hour)}
							<span class="cell" data-level={level(plays, gridMost)} data-tip="{weekdayNames[day]}, {hourName(hour)} · {plural(plays, 'play')}"></span>
						{/each}
					</div>
				{/each}
			</div>
			{@render scale()}
			<details class="table">
				<summary>As a table</summary>
				<table>
					<thead>
						<tr><th scope="col">Hour</th>{#each weekdayNames as name (name)}<th scope="col">{name.slice(0, 3)}</th>{/each}</tr>
					</thead>
					<tbody>
						{#each Array(24) as _, hour (hour)}
							<tr><th scope="row">{hourName(hour)}</th>{#each series.grid as row, day (day)}<td class="hh-numeric">{row[hour]}</td>{/each}</tr>
						{/each}
					</tbody>
				</table>
			</details>
		</figure>
	</section>
</div>

<section>
	<SectionHeader title="Part of the day" />
	<ol class="parts">
		{#each PARTS as part, i (part.name)}
			<li>
				<span class="part-name">{part.name} <span class="hh-muted">{part.span}</span></span>
				<span class="meter" aria-hidden="true"><span style:width="{(series.parts[i] / partsTotal) * 100}%"></span></span>
				<span class="count hh-numeric">{Math.round((series.parts[i] / partsTotal) * 100)}% · {plural(series.parts[i], 'play')}</span>
			</li>
		{/each}
	</ol>
</section>

{#if tip}
	<span class="tip hh-numeric" class:left={tip.left} aria-hidden="true" style:left="{tip.x}px" style:top="{tip.y}px">{tip.text}</span>
{/if}

<style>
	section {
		display: grid;
		gap: var(--space-3);
		min-width: 0;
	}

	.chart {
		display: grid;
		gap: var(--space-2);
		margin: 0;
		min-width: 0;
	}

	/* ── Day by day ── */

	.plot {
		position: relative;
		height: 9rem;
		border-bottom: 1px solid var(--border-strong);
		border-radius: var(--r-sm) var(--r-sm) 0 0;
		cursor: crosshair;
		touch-action: pan-y;
	}

	.plot:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 3px;
	}

	svg {
		display: block;
		width: 100%;
		height: 100%;
		overflow: visible;
	}

	.line {
		fill: none;
		stroke: var(--accent);
		stroke-width: 2;
		stroke-linejoin: round;
		stroke-linecap: round;
		vector-effect: non-scaling-stroke;
	}

	.area {
		fill: color-mix(in srgb, var(--accent) 14%, transparent);
	}

	.cross {
		position: absolute;
		top: 0;
		bottom: 0;
		width: 1px;
		background: var(--border-strong);
		pointer-events: none;
	}

	/* A ring of the ground around it, so it reads over the line and the area. */
	.dot {
		position: absolute;
		width: 0.5rem;
		height: 0.5rem;
		margin: -0.25rem 0 0 -0.25rem;
		border-radius: 50%;
		background: var(--accent);
		box-shadow: 0 0 0 2px var(--bg-base);
		pointer-events: none;
	}

	.most {
		position: absolute;
		top: 0;
		left: 0;
		font-size: 0.6875rem;
		color: var(--text-muted);
		pointer-events: none;
	}

	.ends {
		display: flex;
		justify-content: space-between;
		font-size: 0.6875rem;
		color: var(--text-muted);
	}

	.readout {
		margin: 0;
		min-height: 1.4em;
		font-size: 0.8125rem;
		color: var(--text-strong);
	}

	/* ── The two maps ── */

	.maps {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(100%, 22rem), 1fr));
		gap: var(--space-6);
		align-items: start;
	}

	/*
	 * Five steps of one hue: nothing, and the accent at a quarter, a half,
	 * three quarters and whole over the raised ground. A 2px gap of the page
	 * between cells, and each on the smaller radius.
	 */
	.cell {
		display: block;
		border-radius: 2px;
		background: var(--bg-raised);
	}

	.cell[data-level='1'] {
		background: color-mix(in srgb, var(--accent) 28%, var(--bg-raised));
	}

	.cell[data-level='2'] {
		background: color-mix(in srgb, var(--accent) 52%, var(--bg-raised));
	}

	.cell[data-level='3'] {
		background: color-mix(in srgb, var(--accent) 76%, var(--bg-raised));
	}

	.cell[data-level='4'] {
		background: var(--accent);
	}

	.cell.blank {
		background: none;
	}

	.calendar {
		--cell: clamp(0.5rem, calc((100cqw - 2.25rem) / var(--weeks) - 2px), 0.9rem);
		display: grid;
		grid-template-columns: 2.25rem minmax(0, 1fr);
		grid-template-rows: auto auto;
		container-type: inline-size;
		overflow-x: auto;
	}

	.months {
		grid-column: 2;
		display: grid;
		grid-auto-flow: column;
		grid-auto-columns: calc(var(--cell) + 2px);
		justify-content: start;
		font-size: 0.6875rem;
		color: var(--text-muted);
		white-space: nowrap;
	}

	/* A month's name is wider than a week's column, and runs on over the next. */
	.months span {
		overflow: visible;
		width: 0;
	}

	.days-of-week {
		display: grid;
		grid-template-rows: repeat(7, calc(var(--cell) + 2px));
		align-items: center;
		font-size: 0.6875rem;
		color: var(--text-muted);
	}

	.weeks {
		display: grid;
		grid-auto-flow: column;
		grid-template-rows: repeat(7, var(--cell));
		grid-auto-columns: var(--cell);
		gap: 2px;
		justify-content: start;
	}

	.punch {
		display: grid;
		grid-template-columns: 2.25rem minmax(0, 1fr);
		gap: 2px var(--space-2);
		align-items: center;
	}

	.hour-names {
		grid-column: 2;
		display: grid;
		grid-template-columns: repeat(24, minmax(0, 1fr));
		font-size: 0.6875rem;
		color: var(--text-muted);
		white-space: nowrap;
	}

	.hour-names span {
		overflow: visible;
		width: 0;
	}

	.day-name {
		font-size: 0.6875rem;
		color: var(--text-muted);
	}

	.row {
		display: grid;
		grid-template-columns: repeat(24, minmax(0, 1fr));
		gap: 2px;
	}

	.row .cell {
		height: 1.1rem;
	}

	.scale {
		display: flex;
		align-items: center;
		gap: 3px;
		margin: 0;
		font-size: 0.6875rem;
	}

	.scale .cell {
		width: 0.7rem;
		height: 0.7rem;
	}

	.scale .cell:first-of-type {
		margin-left: 0.3rem;
	}

	.scale .cell:last-of-type {
		margin-right: 0.3rem;
	}

	.tip {
		position: fixed;
		z-index: 65;
		translate: 0.75rem calc(-100% - 0.5rem);
		padding: 0.25rem 0.5rem;
		border: 1px solid var(--border-strong);
		border-radius: var(--r-sm);
		background: var(--bg-raised);
		color: var(--text-strong);
		font-size: 0.75rem;
		white-space: nowrap;
		pointer-events: none;
	}

	.tip.left {
		translate: calc(-100% - 0.75rem) calc(-100% - 0.5rem);
	}

	/* ── Part of the day ── */

	.parts {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
	}

	.parts li {
		display: grid;
		grid-template-columns: minmax(9rem, 14rem) minmax(4rem, 1fr) auto;
		align-items: center;
		gap: var(--space-3);
		padding: 0.5rem var(--space-2);
		border-top: 1px solid var(--border-hairline);
		font-size: 0.875rem;
	}

	.parts li:first-child {
		border-top: none;
	}

	.part-name {
		color: var(--text-strong);
	}

	.part-name .hh-muted {
		font-size: 0.75rem;
	}

	.meter {
		height: 0.375rem;
		border-radius: var(--r-pill);
		background: var(--bg-raised);
		overflow: hidden;
	}

	.meter span {
		display: block;
		height: 100%;
		border-radius: inherit;
		background: var(--accent);
	}

	.count {
		font-size: 0.8125rem;
		color: var(--text-muted);
		white-space: nowrap;
	}

	/* The tables under the charts, as the page's other charts have them. */
	.table summary {
		width: fit-content;
		font-size: 0.75rem;
		color: var(--text-muted);
		cursor: pointer;
	}

	.table table {
		margin-top: var(--space-2);
		border-collapse: collapse;
		font-size: 0.8125rem;
	}

	.table th,
	.table td {
		padding: 0.2rem var(--space-3) 0.2rem 0;
		text-align: left;
		font-weight: 400;
	}

	.table td {
		text-align: right;
	}

	.table thead th {
		color: var(--text-muted);
	}

	@media (max-width: 36rem) {
		.parts li {
			grid-template-columns: minmax(0, 1fr) auto;
		}

		.parts .meter {
			grid-column: 1 / -1;
			grid-row: 2;
		}
	}
</style>
