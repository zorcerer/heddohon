<script lang="ts">
	import { page } from '$app/state';
	import Icon from '$lib/components/Icon.svelte';
</script>

<svelte:head>
	<title>{page.status} · Heddohon</title>
</svelte:head>

<div class="wrap">
	<div class="hh-card hh-glass panel">
		<span class="hh-numeric status">{page.status}</span>
		<h1>{page.error?.message ?? 'Something went wrong'}</h1>
		{#if page.error?.detail}
			<p class="detail hh-muted">{page.error.detail}</p>
		{/if}
		<div class="actions">
			<a class="hh-button hh-button--primary" href="/">
				<Icon name="home" size={16} />
				Back to the library
			</a>
			{#if page.status === 401}
				<a class="hh-button" href="/login">Sign in again</a>
			{/if}
		</div>
	</div>
</div>

<style>
	.wrap {
		display: grid;
		place-items: center;
		padding: var(--space-7) var(--space-4);
		min-height: 60vh;
	}

	.panel {
		padding: var(--space-6);
		max-width: 34rem;
		display: grid;
		gap: var(--space-3);
		justify-items: start;
	}

	.status {
		font-size: 0.75rem;
		color: var(--text-faint);
		letter-spacing: 0.1em;
	}

	h1 {
		font-size: 1.5rem;
		margin: 0;
	}

	.detail {
		margin: 0;
		font-size: 0.875rem;
		font-family: var(--font-mono);
		padding: var(--space-3);
		background: var(--field-face);
		-webkit-backdrop-filter: var(--field-blur);
		backdrop-filter: var(--field-blur);
		border: 1px solid var(--field-edge);
		border-radius: var(--r-sm);
		width: 100%;
		overflow-wrap: anywhere;
	}

	.actions {
		display: flex;
		gap: var(--space-2);
		margin-top: var(--space-2);
		flex-wrap: wrap;
	}
</style>
