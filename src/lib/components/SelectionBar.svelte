<script lang="ts">
	/**
	 * The bar a selection of songs brings up: how many are picked, and what can
	 * be done with them together. Mounted once in the root layout; see
	 * `selection.svelte.ts`.
	 */
	import { beforeNavigate } from '$app/navigation';
	import { player } from '$lib/client/player.svelte';
	import { selection, selectionActions } from '$lib/client/selection.svelte';
	import Icon from './Icon.svelte';

	const count = $derived(selection.count);
	const actions = $derived(count > 0 ? selectionActions() : []);
	/** On a phone, the open player covers the page's list, and the bar with it, but not the queue's. */
	const covered = $derived(player.sheetLayout && player.panelOpen && !selection.source?.inPlayer);

	beforeNavigate(() => selection.clear());

	/*
	 * Escape leaves the selection, unless something above the page has it: the
	 * right-click menu stops it on its way, and an open dialog takes it to
	 * close.
	 */
	function onkeydown(event: KeyboardEvent) {
		if (event.key !== 'Escape' || count === 0 || event.defaultPrevented) return;
		if (document.querySelector('dialog[open]')) return;
		selection.clear();
	}
</script>

<svelte:window {onkeydown} />

{#if count > 0}
	<div
		class="bar selection-bar hh-glass hh-glass--deep hh-float"
		class:covered
		class:over-player={selection.source?.inPlayer}
		role="toolbar"
		aria-label="{count} {count === 1 ? 'song' : 'songs'} selected"
	>
		<button class="clear" type="button" onclick={() => selection.clear()} aria-label="Clear the selection" title="Clear (Esc)">
			<Icon name="close" size={16} />
		</button>
		<span class="count hh-numeric" aria-live="polite">{count} selected</span>
		<div class="actions">
			{#each actions as action (action.label)}
				<button
					class="action"
					class:danger={action.danger}
					type="button"
					onclick={() => void action.run()}
					aria-label={action.label}
					title={action.label}
				>
					<Icon name={action.icon} size={17} />
					<span class="label">{action.label.replace('…', '')}</span>
				</button>
			{/each}
		</div>
	</div>
{/if}

<style>
	/*
	 * Over the foot of the content column, in its grid cell, as the install
	 * card is: it moves with the column and covers neither the rail nor the
	 * player. Over the "listening now" pill, which shares the corner.
	 */
	.bar {
		grid-area: content;
		align-self: end;
		justify-self: center;
		z-index: 3;
		display: flex;
		align-items: center;
		gap: var(--space-2);
		max-width: calc(100% - 2 * var(--space-4));
		margin-bottom: var(--space-4);
		padding: var(--space-1) var(--space-2) var(--space-1) var(--space-1);
		border-radius: var(--r-pill);
		color: var(--text-default);
		/* Opacity on the glass element itself keeps its blur through the fade. */
		animation: arrive var(--dur-state) var(--ease-out) both;
	}

	/*
	 * Room at the foot of the page while the bar is up, so the last rows can be
	 * scrolled clear of it: 2.75rem of bar and its 1rem gap. On a phone the
	 * page has the dock's room below this already.
	 */
	:global(.app:has(> .selection-bar) main.content::after) {
		content: '';
		display: block;
		height: 3.75rem;
	}

	@keyframes arrive {
		from {
			opacity: 0;
		}
	}

	.clear {
		display: grid;
		place-items: center;
		width: 2.25rem;
		height: 2.25rem;
		border-radius: 50%;
		color: var(--text-muted);
	}

	.clear:hover,
	.clear:focus-visible {
		color: var(--glow-color);
		background: var(--bg-hover);
	}

	.count {
		flex: none;
		padding-right: var(--space-2);
		color: var(--text-strong);
		font-size: 0.875rem;
		font-weight: 600;
		white-space: nowrap;
	}

	.actions {
		display: flex;
		align-items: center;
		gap: 0.125rem;
		min-width: 0;
		overflow-x: auto;
		scrollbar-width: none;
	}

	.action {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		flex: none;
		height: 2.25rem;
		padding: 0 var(--space-3);
		border-radius: var(--r-pill);
		color: var(--text-default);
		font-size: 0.8125rem;
		white-space: nowrap;
		transition:
			color var(--transition),
			background var(--transition);
	}

	.action :global(svg) {
		color: var(--text-muted);
	}

	.action:hover,
	.action:focus-visible {
		background: var(--bg-hover);
		color: var(--glow-color);
	}

	.action:hover :global(svg),
	.action:focus-visible :global(svg) {
		color: var(--accent);
	}

	.action.danger,
	.action.danger :global(svg) {
		color: var(--danger);
	}

	/* The labels go before the bar is wider than the column: the icons stay, named by their titles. */
	@media (max-width: 75rem) {
		.label {
			display: none;
		}

		.action {
			padding: 0 0.6rem;
		}
	}

	/*
	 * A phone: fixed above the dock, across the screen, over the pill (39)
	 * and the dock (40). For the queue, at the foot of the screen over the
	 * player's sheet (45), which covers the dock; for any other list, hidden
	 * while the sheet is open, as the dock is.
	 */
	@media (max-width: 60rem) {
		.bar {
			position: fixed;
			left: var(--edge-left);
			right: var(--edge-right);
			bottom: var(--dock-space);
			z-index: 41;
			max-width: 34rem;
			margin: 0 auto;
			justify-content: space-between;
		}

		.bar.over-player {
			bottom: calc(var(--edge-bottom) + var(--float-gap));
			z-index: 46;
		}

		.bar.covered {
			visibility: hidden;
		}

		.count {
			padding-right: 0;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.bar {
			animation: none;
		}
	}

	/* ── Terminal ────────────────────────────────────────────────────────────── */

	/* Squared, in lower case, the chosen action the accent on the pane, as in the right-click menu. */
	:global([data-theme='terminal']) .bar,
	:global([data-theme='terminal']) .clear,
	:global([data-theme='terminal']) .action {
		border-radius: var(--r-sm);
	}

	:global([data-theme='terminal']) .bar {
		border: 1px solid var(--border-strong);
	}

	:global([data-theme='terminal']) .action {
		text-transform: lowercase;
	}

	:global([data-theme='terminal']) .action:hover,
	:global([data-theme='terminal']) .action:focus-visible {
		background: var(--accent);
		color: var(--accent-contrast);
	}

	:global([data-theme='terminal']) .action:hover :global(svg),
	:global([data-theme='terminal']) .action:focus-visible :global(svg) {
		color: var(--accent-contrast);
	}
</style>
