<script lang="ts">
	import { enhance } from '$app/forms';
	import { goto } from '$app/navigation';
	import { untrack } from 'svelte';
	import { page } from '$app/state';
	import Logo from '$lib/components/Logo.svelte';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	// Seeded once: after that the radio group owns the value.
	let selected = $state(untrack(() => form?.backend ?? data.servers[0]?.kind ?? 'subsonic'));
	let submitting = $state(false);

	const selectedServer = $derived(data.servers.find((server) => server.kind === selected));

	/*
	 * Quick Connect. The server starts the request and keeps its secret; this
	 * page only ever holds the code, and asks every 3 seconds whether it has been
	 * approved. Jellyfin expires a request after 10 minutes, and the page stops
	 * asking at the same point.
	 */
	const POLL_MS = 3000;
	type QuickConnectView =
		| { step: 'idle' }
		| { step: 'starting' }
		| { step: 'waiting'; code: string }
		| { step: 'expired' }
		| { step: 'signed-in' };
	let quickConnect = $state<QuickConnectView>({ step: 'idle' });
	let quickConnectError = $state<string | null>(null);
	let pollTimer: ReturnType<typeof setTimeout> | undefined;
	let expiryTimer: ReturnType<typeof setTimeout> | undefined;

	function stopPolling() {
		clearTimeout(pollTimer);
		clearTimeout(expiryTimer);
		pollTimer = expiryTimer = undefined;
	}

	$effect(() => stopPolling);

	async function startQuickConnect() {
		stopPolling();
		quickConnectError = null;
		quickConnect = { step: 'starting' };
		let body: { code?: string; expiresIn?: number; error?: string } | null = null;
		try {
			const response = await fetch('/login/quick-connect', {
				method: 'POST',
				headers: { 'content-type': 'application/json', accept: 'application/json' },
				body: JSON.stringify({ backend: selected })
			});
			body = await response.json().catch(() => null);
			if (!response.ok || !body?.code) throw new Error(body?.error ?? '');
		} catch (err) {
			quickConnectError =
				(err instanceof Error && err.message) || 'Could not start Quick Connect. Try again shortly.';
			quickConnect = { step: 'idle' };
			return;
		}
		const code = body.code;
		quickConnect = { step: 'waiting', code };
		expiryTimer = setTimeout(
			() => {
				stopPolling();
				quickConnect = { step: 'expired' };
			},
			(body.expiresIn ?? 600) * 1000
		);
		pollTimer = setTimeout(() => poll(code), POLL_MS);
	}

	async function poll(code: string) {
		let body: { state?: string; next?: string } | null = null;
		try {
			const response = await fetch('/login/quick-connect/poll', {
				method: 'POST',
				headers: { 'content-type': 'application/json', accept: 'application/json' },
				body: JSON.stringify({ code, next })
			});
			body = await response.json().catch(() => null);
		} catch {
			// A dropped request is asked again on the next tick.
		}
		// Cancelled or restarted while this request was out.
		if (quickConnect.step !== 'waiting' || quickConnect.code !== code) return;

		if (body?.state === 'signed-in') {
			stopPolling();
			quickConnect = { step: 'signed-in' };
			await goto(body.next ?? '/', { invalidateAll: true });
			return;
		}
		if (body?.state === 'expired') {
			stopPolling();
			quickConnect = { step: 'expired' };
			return;
		}
		pollTimer = setTimeout(() => poll(code), POLL_MS);
	}

	function cancelQuickConnect() {
		stopPolling();
		quickConnect = { step: 'idle' };
		quickConnectError = null;
		// Drops the sealed request from this browser. Jellyfin expires its own copy.
		fetch('/login/quick-connect', { method: 'DELETE' }).catch(() => undefined);
	}

	// Preserves the page the user was trying to reach before being redirected
	// here. Parsed against a throwaway origin and kept only if it stayed there:
	// a prefix test admits `/\evil.example`, which the URL parser resolves to
	// `evil.example`. The server re-checks this, the same way, on submit.
	const next = $derived.by(() => {
		const raw = page.url.searchParams.get('next');
		if (!raw) return '/';
		try {
			const url = new URL(raw, 'http://heddohon.invalid');
			if (url.origin !== 'http://heddohon.invalid') return '/';
			// `/.//evil.example` stays on the origin and parses to `//evil.example`.
			if (url.pathname.startsWith('//')) return '/';
			return `${url.pathname}${url.search}${url.hash}`;
		} catch {
			return '/';
		}
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

		{#if quickConnectError ?? form?.error}
			<p class="alert" role="alert">{quickConnectError ?? form?.error}</p>
		{/if}

		{#if quickConnect.step === 'idle' || quickConnect.step === 'starting'}
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

			{#if selectedServer?.quickConnect}
				<div class="divider" aria-hidden="true"><span class="hh-eyebrow">or</span></div>
				<button
					class="hh-button quick"
					type="button"
					onclick={startQuickConnect}
					disabled={quickConnect.step === 'starting' || submitting}
				>
					{quickConnect.step === 'starting' ? 'Asking the server for a code…' : 'Sign in with Quick Connect'}
				</button>
			{/if}
		{:else}
			<section class="quick-connect" aria-live="polite">
				{#if quickConnect.step === 'waiting'}
					<span class="hh-eyebrow">Quick Connect code</span>
					<p class="code">{quickConnect.code}</p>
					<p class="hh-muted note">
						In {selectedServer?.label ?? 'Jellyfin'}, open your user settings, choose Quick Connect
						and enter this code. This page signs in once the code is approved.
					</p>
					<p class="hh-muted note">The code expires after 10 minutes.</p>
				{:else if quickConnect.step === 'expired'}
					<p class="alert" role="alert">The code expired before it was approved.</p>
					<button class="hh-button hh-button--primary submit" type="button" onclick={startQuickConnect}>
						Get a new code
					</button>
				{:else}
					<p class="hh-muted note">Signed in. Opening your library…</p>
				{/if}
				{#if quickConnect.step !== 'signed-in'}
					<button class="hh-button hh-button--ghost" type="button" onclick={cancelQuickConnect}>
						Use a password instead
					</button>
				{/if}
			</section>
		{/if}

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

	.divider {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		margin: var(--space-4) 0;
	}

	.divider::before,
	.divider::after {
		content: '';
		flex: 1;
		border-top: 1px solid var(--border-hairline);
	}

	.quick {
		width: 100%;
		padding: 0.7rem 1rem;
		border-radius: var(--r-md);
	}

	.quick:disabled {
		opacity: 0.65;
		cursor: progress;
	}

	.quick-connect {
		display: grid;
		gap: var(--space-3);
	}

	.code {
		margin: 0;
		font-family: var(--font-mono);
		font-size: 2.25rem;
		font-weight: 600;
		letter-spacing: 0.2em;
		color: var(--text-strong);
		user-select: all;
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
