<script lang="ts">
	/**
	 * A suggestion to install the app, where this browser can install it.
	 * Mounted once in the root layout; `client/install.svelte.ts` works out
	 * how, or whether, the browser installs.
	 *
	 * It waits until something has played in this page load, so it never
	 * greets a first visit, and it is gone for good on the account once
	 * dismissed. Settings, Appearance keeps the same offer for later.
	 */
	import { installer, SAFARI_STEPS } from '$lib/client/install.svelte';
	import { player } from '$lib/client/player.svelte';
	import Icon from './Icon.svelte';

	let { appName, dismissed }: { appName: string; dismissed: boolean } = $props();

	let played = $state(false);
	/** Dismissed in this page load, before the layout's settings catch up. */
	let closed = $state(false);

	$effect(() => {
		if (player.engaged) played = true;
	});

	const route = $derived(installer.route);
	const shown = $derived(Boolean(route) && played && !dismissed && !closed);

	function dismiss() {
		closed = true;
		void fetch('/api/settings', {
			method: 'PATCH',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ installCardDismissed: true })
		}).catch(() => undefined);
	}
</script>

{#if shown && route}
	<aside class="install hh-glass hh-glass--deep hh-float" aria-label="Install the app">
		<Icon name="download" size={17} />
		<p>
			<strong>Install {appName}</strong> as an app, in a window of its own.
			{#if route !== 'prompt'}{SAFARI_STEPS[route]}{/if}
		</p>
		<div class="actions">
			{#if route === 'prompt'}
				<button
					class="hh-button hh-button--primary"
					type="button"
					disabled={installer.busy}
					onclick={() => void installer.install()}
				>
					Install
				</button>
			{/if}
			<button class="hh-button" type="button" onclick={dismiss}>Not now</button>
		</div>
	</aside>
{/if}

<style>
	/*
	 * Over the foot of the content column, in the same grid cell, so it moves
	 * with the column as the player opens and closes and never covers the rail
	 * or the player. The content scrolls inside its cell, so the card stays put.
	 */
	.install {
		grid-area: content;
		align-self: end;
		justify-self: center;
		z-index: 2;
		width: min(34rem, calc(100% - 2 * var(--space-4)));
		margin-bottom: var(--space-4);
		display: grid;
		grid-template-columns: auto minmax(0, 1fr) auto;
		align-items: center;
		gap: var(--space-3);
		padding: var(--space-3) var(--space-3) var(--space-3) var(--space-4);
		border-radius: var(--r-lg);
		color: var(--text-default);
		font-size: 0.8125rem;
		line-height: 1.45;
		/* Opacity on the glass element itself, not on an ancestor of it, keeps
		   its blur through the fade. */
		animation: arrive var(--dur-state) var(--ease-out) both;
	}

	.install > :global(svg) {
		color: var(--accent);
	}

	p {
		margin: 0;
	}

	strong {
		color: var(--text-strong);
	}

	.actions {
		display: flex;
		gap: var(--space-2);
	}

	.actions .hh-button {
		padding: 0.45rem 0.85rem;
		border-radius: var(--r-md);
		font-size: 0.8125rem;
	}

	/* A phone: the page scrolls as a whole, so the card is fixed above the dock. */
	@media (max-width: 60rem) {
		.install {
			position: fixed;
			left: var(--edge-left);
			right: var(--edge-right);
			bottom: var(--dock-space);
			width: auto;
			margin: 0;
			grid-template-columns: auto minmax(0, 1fr);
		}

		.actions {
			grid-column: 1 / -1;
			justify-content: flex-end;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.install {
			animation: none;
		}
	}

	@keyframes arrive {
		from {
			opacity: 0;
		}
	}
</style>
