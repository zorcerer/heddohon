<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import SectionHeader from '$lib/components/SectionHeader.svelte';
	import { playContainer } from '$lib/client/actions';
	import type { Genre } from '$lib/types';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const plural = (count: number, noun: string) => `${count.toLocaleString()} ${noun}${count === 1 ? '' : 's'}`;

	const counts = (genre: Genre) =>
		[
			genre.albumCount !== null ? plural(genre.albumCount, 'album') : null,
			genre.songCount !== null ? plural(genre.songCount, 'track') : null
		]
			.filter(Boolean)
			.join(' · ');

	/** What a genre is ranked by: its albums, or its tracks where albums are not counted. */
	const size = (genre: Genre) => genre.albumCount ?? genre.songCount ?? 0;

	/*
	 * The largest six set large, as the front of the page. Only with more than
	 * eight genres in all, so a short list is not printed twice, and only for
	 * genres that hold something.
	 */
	const TOP = 6;
	const top = $derived(
		data.genres.length > 8
			? [...data.genres].filter((genre) => size(genre) > 0).sort((a, b) => size(b) - size(a)).slice(0, TOP)
			: []
	);

	/** Every genre, A to Z under its initial, as a book's index sets its entries. */
	const letters = $derived.by(() => {
		const byKey = new Map<string, Genre[]>();
		const sorted = [...data.genres].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
		for (const genre of sorted) {
			const first = genre.name.trim()[0]?.toUpperCase() ?? '#';
			const key = /[A-Z]/.test(first) ? first : '#';
			const group = byKey.get(key);
			if (group) group.push(genre);
			else byKey.set(key, [genre]);
		}
		return [...byKey.entries()];
	});
</script>

<svelte:head>
	<title>Genres · Heddohon</title>
</svelte:head>

<div class="page">
	<header>
		<span class="hh-eyebrow">Library</span>
		<h1>Genres</h1>
		<p class="meta hh-numeric hh-muted">{plural(data.genres.length, 'genre')}</p>
	</header>

	{#if data.genres.length > 0}
		{#if top.length > 0}
			<section>
				<SectionHeader title="Largest" index={1} />
				<!-- Type rather than cover art: a genre has no artwork of its own, and
				     borrowing one album's would say that album is the genre. -->
				<ul class="top hh-stagger">
					{#each top as genre, rank (genre.id)}
						<li class="feature">
							<a class="open" href="/genres/{encodeURIComponent(genre.id)}">
								<span class="rank hh-numeric" aria-hidden="true">{String(rank + 1).padStart(2, '0')}</span>
								<span class="name hh-display hh-clamp-2">{genre.name}</span>
								<span class="count hh-numeric">{counts(genre)}</span>
							</a>
							<button
								class="play"
								type="button"
								onclick={() => playContainer('genre', genre.id)}
								aria-label="Play {genre.name}"
								title="Play a random selection"
							>
								<Icon name="play" size={13} />
							</button>
						</li>
					{/each}
				</ul>
			</section>
		{/if}

		<section>
			{#if top.length > 0}
				<SectionHeader title="A to Z" eyebrow="With album counts" index={2} />
			{/if}
			<div class="index">
				{#each letters as [letter, genres] (letter)}
					<div class="letter-group">
						<span class="letter hh-display" aria-hidden="true">{letter}</span>
						<ul>
							{#each genres as genre (genre.id)}
								<li class="entry">
									<a class="entry-link" href="/genres/{encodeURIComponent(genre.id)}">
										<span class="entry-name">{genre.name}</span>
										<span class="leader" aria-hidden="true"></span>
										<span class="entry-count hh-numeric" title={counts(genre)}>{size(genre).toLocaleString()}</span>
									</a>
									{#if top.length === 0}
										<button
											class="play small"
											type="button"
											onclick={() => playContainer('genre', genre.id)}
											aria-label="Play {genre.name}"
											title="Play a random selection"
										>
											<Icon name="play" size={11} />
										</button>
									{/if}
								</li>
							{/each}
						</ul>
					</div>
				{/each}
			</div>
		</section>
	{:else}
		<p class="empty hh-muted">The music server reports no genres.</p>
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
		gap: 0.2rem;
		padding-bottom: var(--space-4);
		border-bottom: 1px solid var(--border-hairline);
	}

	h1 {
		margin: 0;
	}

	.meta {
		margin: var(--space-1) 0 0;
		font-size: 0.8125rem;
	}

	.top {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(15rem, 1fr));
		gap: var(--space-2);
	}

	/*
	 * The chips' material at poster size, lit from one corner with the room's
	 * colour: the only hue it has is the one everything else has.
	 */
	.feature {
		position: relative;
		border-radius: var(--r-lg);
		border: 1px solid var(--border-hairline);
		background:
			radial-gradient(120% 90% at 0% 0%, color-mix(in srgb, var(--accent) 16%, transparent), transparent 60%),
			var(--control-face);
		-webkit-backdrop-filter: var(--control-blur);
		backdrop-filter: var(--control-blur);
		transition: border-color var(--transition);
	}

	.feature:hover,
	.feature:focus-within {
		border-color: var(--border-strong);
	}

	.open {
		display: grid;
		align-content: space-between;
		gap: var(--space-4);
		min-height: 9.5rem;
		padding: var(--space-4) var(--space-5);
		padding-right: calc(var(--space-4) + 2.5rem);
		text-decoration: none;
	}

	.rank {
		font-size: 0.6875rem;
		letter-spacing: 0.08em;
		color: var(--accent);
	}

	.name {
		font-size: clamp(1.5rem, 1.1rem + 1vw, 2rem);
		line-height: 1.05;
		color: var(--text-strong);
		transition:
			color var(--transition),
			text-shadow var(--transition);
	}

	.open:hover .name {
		color: var(--glow-color);
		text-shadow: var(--glow-text);
	}

	.count {
		font-size: 0.75rem;
		color: var(--text-muted-through);
	}

	.play {
		position: absolute;
		right: var(--space-4);
		bottom: var(--space-4);
		width: 2.25rem;
		height: 2.25rem;
		border-radius: 50%;
		display: grid;
		place-items: center;
		padding-left: 2px;
		color: var(--text-muted-through);
		border: 1px solid var(--border-strong);
		transition:
			color var(--transition),
			background var(--transition),
			border-color var(--transition);
	}

	.play:hover {
		color: var(--accent-contrast);
		background: var(--accent);
		border-color: var(--accent);
	}

	/*
	 * Columns of about 15rem, filled down and then across, with the letters
	 * run in above their entries and dotted leaders out to the counts: the
	 * whole list reads in a screen or two where tiles took several.
	 */
	.index {
		columns: 15rem;
		column-gap: var(--space-6);
	}

	.letter-group {
		break-inside: avoid;
		padding-bottom: var(--space-4);
	}

	.letter {
		display: block;
		font-size: 1.5rem;
		line-height: 1;
		color: var(--accent);
		padding: 0 var(--space-1) var(--space-2);
	}

	.letter-group ul {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.entry {
		position: relative;
		display: flex;
		align-items: center;
	}

	.entry-link {
		flex: 1;
		min-width: 0;
		display: flex;
		align-items: baseline;
		gap: var(--space-2);
		padding: 0.3rem var(--space-1);
		border-radius: var(--r-sm);
		text-decoration: none;
		font-size: 0.875rem;
	}

	.entry-name {
		color: var(--text-default);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		transition:
			color var(--transition),
			text-shadow var(--transition);
	}

	.entry-link:hover .entry-name,
	.entry-link:focus-visible .entry-name {
		color: var(--glow-color);
		text-shadow: var(--glow-text);
	}

	.leader {
		flex: 1;
		min-width: var(--space-3);
		border-bottom: 1px dotted var(--border-strong);
		translate: 0 -0.25em;
	}

	.entry-count {
		font-size: 0.75rem;
		color: var(--text-faint);
	}

	.play.small {
		position: static;
		flex: none;
		width: 1.6rem;
		height: 1.6rem;
		margin-left: var(--space-1);
	}

	.empty {
		padding: var(--space-7);
		text-align: center;
	}

	@media (max-width: 36rem) {
		.top {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}

		.open {
			min-height: 7.5rem;
			padding: var(--space-3);
			padding-bottom: calc(var(--space-3) + 2.5rem);
		}

		.name {
			font-size: 1.25rem;
		}

		.count {
			white-space: nowrap;
			overflow: hidden;
			text-overflow: ellipsis;
		}

		/* Two columns rather than one entry per line under a letter per screen. */
		.index {
			columns: 2;
			column-gap: var(--space-4);
		}

		.letter {
			font-size: 1.125rem;
		}

		.play {
			right: var(--space-3);
			bottom: var(--space-3);
		}
	}
</style>
