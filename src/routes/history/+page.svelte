<script lang="ts">
	import Pager from '$lib/components/Pager.svelte';
	import TrackList from '$lib/components/TrackList.svelte';
	import type { Song } from '$lib/types';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	/** Plays grouped by the day they were played on, in this browser's time zone. */
	const days = $derived.by(() => {
		const groups: { key: string; label: string; songs: Song[] }[] = [];
		const today = new Date();
		const yesterday = new Date(today);
		yesterday.setDate(today.getDate() - 1);
		for (const { song, playedAt } of data.plays) {
			const day = new Date(playedAt);
			const key = day.toDateString();
			let group = groups.at(-1);
			if (group?.key !== key) {
				const label =
					key === today.toDateString()
						? 'Today'
						: key === yesterday.toDateString()
							? 'Yesterday'
							: day.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
				groups.push((group = { key, label, songs: [] }));
			}
			group.songs.push(song);
		}
		return groups;
	});
</script>

<svelte:head>
	<title>Recently played · Heddohon</title>
</svelte:head>

<div class="page">
	<header>
		<span class="hh-eyebrow">Library</span>
		<h1 class="hh-display">Recently played</h1>
		<p class="meta hh-numeric hh-muted">
			{data.page.total.toLocaleString()} play{data.page.total === 1 ? '' : 's'}{data.historyDays === 365
				? ' in the last year'
				: data.historyDays === 90
					? ' in the last 90 days'
					: ''}
			· <a href="/stats">Your listening</a>
		</p>
	</header>

	{#each days as day (day.key)}
		<section aria-label={day.label}>
			<h2 class="day hh-eyebrow">{day.label}</h2>
			<TrackList songs={day.songs} variant="artwork" showAlbum />
		</section>
	{:else}
		<p class="empty hh-muted">
			Nothing yet. A track is added here once it has played for half its length, or four minutes.
		</p>
	{/each}

	<Pager
		page={data.page.page}
		pageCount={data.page.pageCount}
		total={data.page.total}
		hasPrevious={data.page.hasPrevious}
		hasNext={data.page.hasNext}
		href={(target) => `/history?page=${target}`}
		label="History pages"
		noun="plays"
	/>
</div>

<style>
	.page {
		display: grid;
		gap: var(--space-5);
		max-width: var(--grid-max);
	}

	header {
		display: grid;
		gap: 0.2rem;
		padding-bottom: var(--space-4);
		border-bottom: 1px solid var(--border-hairline);
	}

	h1 {
		margin: 0.2rem 0 0;
		font-size: clamp(2.25rem, 1.4rem + 2.6vw, 3.5rem);
	}

	.meta {
		margin: var(--space-1) 0 0;
		font-size: 0.8125rem;
	}

	.day {
		margin: 0 0 var(--space-2);
	}

	.empty {
		padding: var(--space-7);
		text-align: center;
	}
</style>
