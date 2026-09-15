<script lang="ts">
	import type { Snippet } from 'svelte';
	import Icon from './Icon.svelte';

	let {
		title,
		/** Two-digit index, printed in the margin like a catalogue entry. */
		index = null,
		eyebrow = null,
		href = null,
		actions
	}: {
		title: string;
		index?: number | null;
		eyebrow?: string | null;
		href?: string | null;
		actions?: Snippet;
	} = $props();
</script>

<!--
  The rule that runs from the title to the right edge is what makes a page of
  shelves read as a printed index rather than a stack of carousels. The number
  sits outside the text column, in the margin, in mono.
-->
<header class="section-header">
	{#if index !== null}
		<span class="index hh-numeric" aria-hidden="true">{String(index).padStart(2, '0')}</span>
	{/if}

	<div class="titles">
		{#if eyebrow}
			<span class="hh-eyebrow">{eyebrow}</span>
		{/if}
		{#if href}
			<a class="link" {href}>
				<h2>{title}</h2>
				<Icon name="chevron-right" size={17} />
			</a>
		{:else}
			<h2>{title}</h2>
		{/if}
	</div>

	<span class="rule" aria-hidden="true"></span>

	{#if actions}
		<div class="actions">{@render actions()}</div>
	{/if}
</header>

<style>
	.section-header {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		margin-bottom: var(--space-4);
	}

	.index {
		font-size: 0.6875rem;
		color: var(--accent);
		letter-spacing: 0.08em;
		padding-top: 0.1rem;
		flex: none;
	}

	.titles {
		display: grid;
		gap: 0.1rem;
		min-width: 0;
		flex: none;
	}

	.link {
		display: inline-flex;
		align-items: center;
		gap: var(--space-2);
		color: var(--text-strong);
	}

	.link :global(svg) {
		color: var(--text-faint);
		transition:
			transform var(--transition),
			color var(--transition);
	}

	.link:hover :global(svg) {
		transform: translateX(3px);
		color: var(--accent);
	}

	/* Fills whatever the title leaves. */
	.rule {
		flex: 1;
		height: 1px;
		min-width: var(--space-4);
		background: var(--border-hairline);
	}

	.actions {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		flex: none;
	}

	@media (max-width: 40rem) {
		.index {
			display: none;
		}
	}
</style>
