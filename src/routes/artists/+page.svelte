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
	 * Artist lists are long and alphabetical, so a jump bar beats scrolling.
	 * Only letters that actually have artists behind them are shown.
	 */
	const initials = $derived.by(() => {
		const seen = new Map<string, string>();
		for (const artist of visible) {
			const first = artist.name.trim()[0]?.toUpperCase() ?? '#';
			const key = /[A-Z]/.test(first) ? first : '#';
			if (!seen.has(key)) seen.set(key, artist.id);
		}
		return [...seen.entries()];
	});

</script>

<svelte:head>
	<title>Artists · Heddohon</title>
</svelte:head>

<div class="page">
	<header>
		<div>
			<span class="hh-eyebrow">Library</span>
			<h1>Artists</h1>
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

	{#if initials.length > 1}
		<nav class="jump" aria-label="Jump to letter">
			{#each initials as [letter, id] (letter)}
				<a href="#artist-{id}">{letter}</a>
			{/each}
		</nav>
	{/if}

	{#if visible.length > 0}
		<MediaGrid density="compact">
			{#each visible as artist (artist.id)}
				<div id="artist-{artist.id}" class="anchor">
					<MediaCard
						href="/artists/{artist.id}"
						title={artist.name}
						subtitle={artist.albumCount ? `${artist.albumCount} albums` : null}
						coverArt={artist.coverArt}
						rounded
					/>
				</div>
			{/each}
		</MediaGrid>

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

	/* Anchors need clearance so a jump does not land the card under the header. */
	.anchor {
		scroll-margin-top: var(--space-6);
	}

	.empty {
		padding: var(--space-7);
		text-align: center;
	}
</style>
