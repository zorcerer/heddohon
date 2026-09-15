<script lang="ts">
	import { enhance } from '$app/forms';
	import { untrack } from 'svelte';
	import { page } from '$app/state';
	import Logo from '$lib/components/Logo.svelte';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	// Seeded once: after that the radio group owns the value.
	let selected = $state(untrack(() => form?.backend ?? data.servers[0]?.kind ?? 'subsonic'));
	let submitting = $state(false);

	// Preserves the page the user was trying to reach before being redirected
	// here. Relative paths only, so this can never become an open redirect.
	const next = $derived.by(() => {
		const raw = page.url.searchParams.get('next');
		return raw && raw.startsWith('/') && !raw.startsWith('//') ? raw : '/';
	});
</script>

<svelte:head>
	<title>Sign in · {data.appName}</title>
</svelte:head>

<main class="shell">
	<div class="panel hh-glass">
		<header>
			<div class="mark" aria-hidden="true">
				<Logo size={28} />
			</div>
			<h1>{data.appName}</h1>
			<p class="hh-muted tagline">
				Sign in with your music server account. Your credentials go straight to the server and are
				never stored in this browser.
			</p>
		</header>

		{#if form?.error}
			<p class="alert" role="alert">{form.error}</p>
		{/if}

		<form
			method="POST"
			use:enhance={() => {
				submitting = true;
				return async ({ update }) => {
					await update({ reset: false });
					submitting = false;
				};
			}}
		>
			{#if data.servers.length > 1}
				<fieldset class="servers">
					<legend class="hh-eyebrow">Music server</legend>
					{#each data.servers as server (server.kind)}
						<label class="server" class:selected={selected === server.kind}>
							<input
								type="radio"
								name="backend"
								value={server.kind}
								bind:group={selected}
								class="hh-visually-hidden"
							/>
							<span class="server-name">{server.label}</span>
							<span class="hh-eyebrow">{server.kind}</span>
						</label>
					{/each}
				</fieldset>
			{:else if data.servers.length === 1}
				<input type="hidden" name="backend" value={data.servers[0].kind} />
				<p class="single-server">
					<span class="hh-eyebrow">Signing in to</span>
					<strong>{data.servers[0].label}</strong>
				</p>
			{/if}

			<label class="field">
				<span class="hh-eyebrow">Username</span>
				<input
					class="hh-input"
					name="username"
					autocomplete="username"
					required
					autocapitalize="none"
					spellcheck="false"
					value={form?.username ?? ''}
				/>
			</label>

			<label class="field">
				<span class="hh-eyebrow">Password</span>
				<input
					class="hh-input"
					type="password"
					name="password"
					autocomplete="current-password"
					required
				/>
			</label>

			<input type="hidden" name="next" value={next} />

			<button class="hh-button hh-button--primary submit" type="submit" disabled={submitting}>
				{submitting ? 'Checking with the server…' : 'Sign in'}
			</button>
		</form>

		<footer>
			<p class="hh-muted note">
				Sessions expire after {data.sessionMaxHours} hours and cannot be extended.
			</p>
			{#if data.hint}
				<p class="hh-muted note">{data.hint}</p>
			{/if}
		</footer>
	</div>
</main>

<style>
	.shell {
		min-height: 100vh;
		display: grid;
		place-items: center;
		padding: var(--space-5);
		/* A single, very soft radial lift so the panel is not floating on flat
		   colour. No glow, no colour cast — just a hint of depth. */
		background:
			radial-gradient(120% 80% at 50% -10%, var(--bg-surface) 0%, transparent 60%),
			var(--bg-base);
	}

	.panel {
		width: min(26rem, 100%);
		border: 1px solid var(--glass-edge);
		border-radius: var(--r-xl);
		padding: var(--space-6);
		box-shadow: var(--shadow-high);
	}

	header {
		margin-bottom: var(--space-5);
	}

	.mark {
		width: 3rem;
		height: 3rem;
		display: grid;
		place-items: center;
		background: var(--accent);
		color: var(--accent-contrast);
		border-radius: var(--r-md);
		margin-bottom: var(--space-4);
	}

	h1 {
		font-size: 1.9rem;
		margin-bottom: var(--space-2);
	}

	.tagline {
		font-size: 0.875rem;
		margin: 0;
	}

	.alert {
		background: color-mix(in srgb, var(--danger) 14%, var(--bg-sunken));
		border: 1px solid color-mix(in srgb, var(--danger) 45%, transparent);
		border-radius: var(--r-sm);
		padding: var(--space-3) var(--space-4);
		font-size: 0.875rem;
		color: var(--text-strong);
		margin: 0 0 var(--space-4);
	}

	form {
		display: grid;
		gap: var(--space-4);
	}

	.servers {
		border: none;
		padding: 0;
		margin: 0;
		display: grid;
		gap: var(--space-2);
	}

	.servers legend {
		margin-bottom: var(--space-2);
		padding: 0;
	}

	.server {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: var(--space-3);
		padding: 0.625rem 0.875rem;
		border: 1px solid var(--field-edge);
		border-radius: var(--r-sm);
		background: var(--field-face);
		-webkit-backdrop-filter: var(--field-blur);
		backdrop-filter: var(--field-blur);
		cursor: pointer;
		transition:
			border-color var(--transition),
			background var(--transition);
	}

	.server:hover {
		border-color: var(--border-strong);
	}

	.server.selected {
		border-color: var(--accent);
		background: color-mix(in srgb, var(--accent) 10%, var(--bg-sunken));
	}

	.server-name {
		font-weight: 600;
		color: var(--text-strong);
	}

	.single-server {
		display: flex;
		align-items: baseline;
		gap: var(--space-2);
		margin: 0;
	}

	.single-server strong {
		color: var(--text-strong);
	}

	.field {
		display: grid;
		gap: var(--space-2);
	}

	.submit {
		margin-top: var(--space-2);
		padding: 0.7rem 1rem;
		border-radius: var(--r-md);
	}

	.submit:disabled {
		opacity: 0.65;
		cursor: progress;
	}

	footer {
		margin-top: var(--space-5);
		padding-top: var(--space-4);
		border-top: 1px solid var(--border-hairline);
		display: grid;
		gap: var(--space-1);
	}

	.note {
		font-size: 0.8125rem;
		margin: 0;
	}
</style>
