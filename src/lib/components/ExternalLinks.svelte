<script lang="ts">
	import type { ExternalLink } from '$lib/types';
	import Icon from './Icon.svelte';

	/**
	 * The foot of an album or artist page: where the music server says the same
	 * album or artist is described elsewhere. Each opens in a new tab, with no
	 * referrer, so the other site learns neither this server's address nor the
	 * page.
	 */
	let { links }: { links: ExternalLink[] } = $props();
</script>

<nav class="elsewhere" aria-label="Elsewhere">
	<span class="hh-eyebrow">Elsewhere</span>
	<ul>
		{#each links as link (link.url)}
			<li>
				<a class="chip" href={link.url} target="_blank" rel="noopener noreferrer external">
					{link.label}
					<Icon name="external" size={13} />
					<span class="hh-visually-hidden">(opens in a new tab)</span>
				</a>
			</li>
		{/each}
	</ul>
</nav>

<style>
	.elsewhere {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2) var(--space-3);
		padding-top: var(--space-4);
		border-top: 1px solid var(--border-hairline);
	}

	ul {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-1);
		margin: 0;
		padding: 0;
		list-style: none;
	}

	/* The look of the sort chips (`SortChips`), which every theme already
	   restyles through the same tokens. */
	.chip {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		padding: 0.3rem 0.75rem;
		border-radius: var(--r-pill);
		border: 1px solid var(--border-hairline);
		background: var(--control-face);
		-webkit-backdrop-filter: var(--control-blur);
		backdrop-filter: var(--control-blur);
		color: var(--text-muted-through);
		font-size: 0.8125rem;
		font-weight: 500;
		white-space: nowrap;
		transition:
			text-shadow var(--transition),
			color var(--transition),
			border-color var(--transition);
	}

	.chip:hover {
		color: var(--glow-color);
		text-shadow: var(--glow-text);
		border-color: var(--border-strong);
	}

	@media (prefers-reduced-transparency: reduce) {
		.chip {
			background: var(--bg-surface);
			-webkit-backdrop-filter: none;
			backdrop-filter: none;
		}
	}
</style>
