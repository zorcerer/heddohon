<script lang="ts" generics="T extends string">
	/**
	 * The sort selector of the library listings. Links, not buttons, so a
	 * sorted view is a URL: shareable, bookmarkable and restored by Back.
	 */
	let {
		sorts,
		active,
		labels,
		href,
		label = 'Sort'
	}: {
		sorts: readonly T[];
		active: T;
		labels: Record<T, string>;
		href: (sort: T) => string;
		label?: string;
	} = $props();
</script>

<nav class="sorts" aria-label={label}>
	{#each sorts as sort (sort)}
		<a
			class="chip"
			class:active={sort === active}
			href={href(sort)}
			aria-current={sort === active ? 'true' : undefined}
			data-sveltekit-noscroll
		>
			{labels[sort] ?? sort}
		</a>
	{/each}
</nav>

<style>
	.sorts {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-1);
	}

	.chip {
		padding: 0.3rem 0.75rem;
		border-radius: var(--r-pill);
		border: 1px solid var(--border-hairline);
		background: var(--control-face);
		-webkit-backdrop-filter: var(--control-blur);
		backdrop-filter: var(--control-blur);
		/* The tone for text on a translucent face. `--text-muted` on a
		   see-through chip depends on the field behind it, and measured 4.53:1
		   against a 4.5 floor. */
		color: var(--text-muted-through);
		font-size: 0.8125rem;
		font-weight: 500;
		white-space: nowrap;
		/* The fill as well, so the chosen order fades in rather than snapping. */
		transition:
			text-shadow var(--transition),
			color var(--transition),
			border-color var(--transition),
			background var(--transition);
	}

	.chip:hover {
		color: var(--glow-color);
		text-shadow: var(--glow-text);
		border-color: var(--border-strong);
	}

	.chip.active {
		background: var(--accent);
		border-color: var(--accent);
		color: var(--accent-contrast);
		/* Solid fill behind it — see `.hh-button--primary`. */
		text-shadow: none;
	}

	/* After the rules above, not with the glass primitives: only source order
	   separates two single-class selectors. */
	@media (prefers-reduced-transparency: reduce) {
		.chip {
			background: var(--bg-surface);
			-webkit-backdrop-filter: none;
			backdrop-filter: none;
		}

		.chip:hover {
			background: var(--bg-surface);
		}

		.chip.active {
			background: var(--accent);
		}
	}
</style>
