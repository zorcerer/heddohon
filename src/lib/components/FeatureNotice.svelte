<script lang="ts">
	/**
	 * Tells an administrator, once, of the optional features that are off on
	 * this server, with the way to them (Settings, Features). Dismissed, or
	 * saved under Settings, the features named are marked seen for the
	 * account (`featuresSeen`), and a feature added later is told of alone.
	 * See `features.ts`.
	 */
	import Icon from './Icon.svelte';

	let { features, seen }: { features: { id: string; title: string }[]; seen: string[] } = $props();

	let dismissed = $state(false);

	async function dismiss() {
		dismissed = true;
		await fetch('/api/settings', {
			method: 'PATCH',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ featuresSeen: [...new Set([...seen, ...features.map((feature) => feature.id)])] })
		}).catch(() => undefined);
	}
</script>

{#if !dismissed}
	<aside class="notice hh-card hh-glass" aria-label="Features that are off">
		<Icon name="info" size={18} />
		<div class="text">
			<p class="title">{features.length === 1 ? 'A feature is off on this server' : 'Features are off on this server'}</p>
			<p class="hh-muted">{features.map((feature) => feature.title).join(', ')}</p>
		</div>
		<div class="actions">
			<a class="hh-button hh-button--primary" href="/settings?tab=features">Open Features</a>
			<button class="hh-button" type="button" onclick={dismiss}>Dismiss</button>
		</div>
	</aside>
{/if}

<style>
	.notice {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr) auto;
		align-items: center;
		gap: var(--space-3);
		padding: var(--space-3) var(--space-4);
		border-radius: var(--r-lg);
		font-size: 0.875rem;
	}

	.notice > :global(svg) {
		color: var(--accent);
	}

	p {
		margin: 0;
	}

	.title {
		color: var(--text-strong);
		font-weight: 600;
	}

	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
	}

	@media (max-width: 40rem) {
		.notice {
			grid-template-columns: auto minmax(0, 1fr);
		}

		.actions {
			grid-column: 1 / -1;
		}
	}
</style>
