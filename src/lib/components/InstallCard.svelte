<script lang="ts">
	/**
	 * A suggestion to get the app: one of Heddohon's own on Windows, Linux and
	 * Android, as a link to the latest release, and the page installed by the
	 * browser on a Mac, an iPhone and an iPad. Mounted once in the root layout;
	 * `client/install.svelte.ts` works out which, or whether.
	 *
	 * It waits until something has played in this page load, so it does not
	 * greet a first visit. It is gone for good on the account once dismissed,
	 * or once the account has run the installed app. Settings, Appearance keeps
	 * the offer.
	 */
	import { APP_KINDS, APP_RELEASES, installer, INSTALL_STEPS } from '$lib/client/install.svelte';
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
	/** One of our apps for this system, where there is one. */
	const kind = $derived(route === 'app-windows' || route === 'app-linux' || route === 'app-android' ? APP_KINDS[route] : null);
	const shown = $derived(installer.suggested && played && !dismissed && !closed);

	// Someone running the installed app has found it. The card is put away on
	// the account, so it does not come up in their other browsers.
	$effect(() => {
		if (installer.installed && !dismissed && !closed) dismiss();
	});

	function dismiss() {
		closed = true;
		void fetch('/api/settings', {
			method: 'PATCH',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ installCardDismissed: true })
		})
			// Read to its end: an unread response holds its connection open, and
			// this one can be sent as the page loads.
			.then((response) => response.arrayBuffer())
			.catch(() => undefined);
	}
</script>

{#if shown && route}
	<aside class="install hh-glass hh-glass--deep hh-float" aria-label="Install the app">
		<Icon name="download" size={17} />
		<p>
			{#if kind}
				<strong>{appName} for {kind.system}</strong>: {kind.files}, with the latest release.
			{:else}
				<strong>Install {appName}</strong> as an app, in a window of its own.
				{#if route === 'safari-mac' || route === 'safari-ios' || route === 'edge'}{INSTALL_STEPS[route]}{/if}
			{/if}
		</p>
		<div class="actions">
			{#if kind}
				<!-- Another site: a new tab, told nothing about this one. -->
				<a class="hh-button hh-button--primary" href={APP_RELEASES} target="_blank" rel="noopener noreferrer">{kind.action}</a>
			{/if}
			<!-- The browser's own install: the route itself on a Mac, and beside the APK on Android where Chrome offers it. -->
			{#if route === 'prompt' || (route === 'app-android' && installer.canPrompt)}
				<button
					class={route === 'prompt' ? 'hh-button hh-button--primary' : 'hh-button'}
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
	 * with the column as the player opens and closes and does not cover the
	 * rail or the player. The content scrolls inside its cell, so the card
	 * stays put.
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
		/* Opacity on the glass element itself keeps its blur through the fade. */
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
		text-decoration: none;
		white-space: nowrap;
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
