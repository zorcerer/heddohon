<script lang="ts">
	/**
	 * The views of the listening history, as tabs at the head of each: the
	 * plays one by one, the summary of them, and a recap of a year or a month.
	 * The same tabs as the favourites page.
	 */
	import { page } from '$app/state';

	const TABS = [
		{ href: '/history', label: 'Recently played' },
		{ href: '/stats', label: 'Your listening' },
		{ href: '/stats/recap', label: 'Recap' }
	];
</script>

<nav class="tabs" aria-label="Listening history">
	{#each TABS as tab (tab.href)}
		{@const active = page.url.pathname === tab.href}
		<a class="tab" class:active href={tab.href} aria-current={active ? 'page' : undefined}>{tab.label}</a>
	{/each}
</nav>

<style>
	.tabs {
		display: flex;
		gap: var(--space-1);
		margin-top: var(--space-2);
	}

	.tab {
		padding: 0.35rem 0.8rem;
		border-radius: var(--r-pill);
		color: var(--text-muted);
		font-size: 0.875rem;
		font-weight: 500;
		white-space: nowrap;
		transition:
			background var(--transition),
			color var(--transition);
	}

	/* The first tab's text lines up with the heading above it. */
	.tab:first-child {
		margin-left: -0.8rem;
	}

	.tab:hover,
	.tab.active {
		color: var(--glow-color);
		text-shadow: var(--glow-text);
	}

	/* ── Terminal ────────────────────────────────────────────────────────────── */

	/* The tab that is open: the accent, on a rule of it. The other themes light
	   the label, and this one has no glow to do it with. */
	:global([data-theme='terminal']) .tab.active {
		border-radius: 0;
		color: var(--accent);
		box-shadow: inset 0 -2px 0 var(--accent);
	}
</style>
