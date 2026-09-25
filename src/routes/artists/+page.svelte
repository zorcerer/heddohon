<script lang="ts">
	import { goto } from '$app/navigation';
	import { page as pageState } from '$app/state';
	import { untrack } from 'svelte';
	import MediaCard from '$lib/components/MediaCard.svelte';
	import MediaGrid from '$lib/components/MediaGrid.svelte';
	import Pager from '$lib/components/Pager.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	// Filtering runs on the server so it searches the whole library, not just the
	// hundred artists this page happens to hold. Debounced, and pushed through
	// the URL so a filtered view is shareable and the back button restores it.
	let filter = $state(untrack(() => data.query));
	let timer: ReturnType<typeof setTimeout> | null = null;

	$effect(() => {
		filter = data.query;
	});

	function onFilter() {
		if (timer) clearTimeout(timer);
		const next = filter;
		timer = setTimeout(() => {
			const params = new URLSearchParams();
			if (next.trim()) params.set('q', next.trim());
			void goto(params.size ? `/artists?${params}` : '/artists', {
				keepFocus: true,
				replaceState: true,
				noScroll: true
			});
		}, 280);
	}

	function pageHref(target: number): string {
		const params = new URLSearchParams(pageState.url.searchParams);
		params.set('page', String(target));
		return `/artists?${params}`;
	}

	const visible = $derived(data.items);

	/**
	 * The page's artists under their initials, as a printed index sets them.
	 * The key skips a leading article, as Navidrome and Jellyfin do when they
	 * sort ("The Beatles" is under B), so the groups follow the order the
	 * server sent. Anything that does not start with a letter goes under #.
	 */
	const ARTICLE = /^(the|a|an|el|la|los|las|le|les|os|as|o)\s+/i;
	const groups = $derived.by(() => {
		const byKey = new Map<string, typeof visible>();
		for (const artist of visible) {
			const first = artist.name.trim().replace(ARTICLE, '')[0]?.toUpperCase() ?? '#';
			const key = /[A-Z]/.test(first) ? first : '#';
			const group = byKey.get(key);
			if (group) group.push(artist);
			else byKey.set(key, [artist]);
		}
		return [...byKey.entries()];
	});

	const albumCount = (count: number | null) =>
		count ? `${count} album${count === 1 ? '' : 's'}` : null;
</script>

<svelte:head>
	<title>Artists · Heddohon</title>
</svelte:head>

<div class="page">
	<header>
		<div>
			<span class="hh-eyebrow">Library</span>
			<h1>Artists</h1>
			<p class="meta hh-numeric hh-muted">
				{data.libraryTotal.toLocaleString()} artist{data.libraryTotal === 1 ? '' : 's'}
			</p>
		</div>
		<input
			class="hh-input filter"
			type="search"
			bind:value={filter}
			oninput={onFilter}
			placeholder="Filter {data.libraryTotal.toLocaleString()} artists"
			aria-label="Filter artists"
		/>
	</header>

	{#if groups.length > 1}
		<nav class="jump" aria-label="Jump to letter">
			{#each groups as [letter] (letter)}
				<a href="#letter-{letter === '#' ? 'other' : letter}">{letter}</a>
			{/each}
		</nav>
	{/if}

	{#if visible.length > 0}
		<div class="index">
			{#each groups as [letter, artists] (letter)}
				<section class="group" id="letter-{letter === '#' ? 'other' : letter}" aria-label={letter}>
					<span class="letter hh-display" aria-hidden="true">{letter}</span>
					<MediaGrid density="compact">
						{#each artists as artist (artist.id)}
							<MediaCard
								href="/artists/{artist.id}"
								title={artist.name}
								subtitle={albumCount(artist.albumCount)}
								coverArt={artist.coverArt}
								rounded
							/>
						{/each}
					</MediaGrid>
				</section>
			{/each}
		</div>

		<Pager {...data} href={pageHref} label="Artist pages" noun="artists" />
	{:else}
		<p class="empty hh-muted">No artists matched “{data.query}”.</p>
	{/if}
</div>

<style>
	.page {
		display: grid;
		gap: var(--space-5);
		max-width: var(--grid-max);
	}

	header {
		display: flex;
		align-items: flex-end;
		justify-content: space-between;
		gap: var(--space-5);
		flex-wrap: wrap;
	}

	.filter {
		width: min(20rem, 100%);
	}

	.meta {
		margin: var(--space-1) 0 0;
		font-size: 0.8125rem;
	}

	.jump {
		display: flex;
		flex-wrap: wrap;
		gap: 2px;
		padding-bottom: var(--space-2);
		border-bottom: 1px solid var(--border-hairline);
	}

	.jump a {
		min-width: 1.6rem;
		padding: 0.15rem 0.35rem;
		text-align: center;
		border-radius: var(--r-sm);
		font-family: var(--font-mono);
		font-size: 0.75rem;
		color: var(--text-faint);
		transition:
			color var(--transition),
			background var(--transition);
	}

	.jump a:hover {
		color: var(--accent);
		text-shadow: var(--glow-text);
	}

	.index {
		display: grid;
		gap: var(--space-4);
	}

	/*
	 * The letter in the margin, large and quiet, the way a printed index sets
	 * its section letters; it stays beside its group while the group scrolls.
	 */
	.group {
		display: grid;
		grid-template-columns: 3.5rem minmax(0, 1fr);
		gap: var(--space-3);
		align-items: start;
		/* Clear of the top of the column when a jump lands on it. */
		scroll-margin-top: var(--space-5);
	}

	.letter {
		position: sticky;
		top: 0;
		padding-top: var(--space-2);
		font-size: 2.75rem;
		line-height: 1;
		color: var(--accent);
		opacity: 0.8;
		text-align: center;
	}

	.group + .group {
		padding-top: var(--space-4);
		border-top: 1px solid var(--border-hairline);
	}

	/* A phone: the letter above its group rather than beside it. */
	@media (max-width: 36rem) {
		.group {
			grid-template-columns: minmax(0, 1fr);
			gap: var(--space-2);
		}

		.letter {
			position: static;
			text-align: left;
			font-size: 1.75rem;
			padding: 0 var(--space-1);
		}
	}

	.empty {

		padding: var(--space-7);
		text-align: center;
	}
</style>
