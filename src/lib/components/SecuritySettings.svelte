<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { replaceState } from '$app/navigation';
	import QrCode from './QrCode.svelte';
	import { createPasskey, passkeyFailure, passkeysAvailable, usePasskey } from '$lib/client/webauthn';

	/**
	 * Settings, Security: the account's second factors (issue #225). Every
	 * change goes through `/api/two-factor`. One that adds or takes away a
	 * factor first asks for a proof, which this component collects in place:
	 * a code or a passkey where the account has a factor, its password where
	 * it has none (`checkProof` in twofactor.ts).
	 */
	let {
		serverLabel,
		admin
	}: {
		serverLabel: string;
		/** For an administrator of the music server: the switch, and whether the environment sets it. */
		admin: { required: boolean; fromEnvironment: boolean } | null;
	} = $props();

	interface Passkey {
		id: string;
		name: string;
		createdAt: number;
		lastUsedAt: number | null;
	}
	interface Status {
		totp: boolean;
		passkeys: number;
		recoveryCodes: number;
		passkeyList: Passkey[];
		passkeysOffered: boolean;
		required: boolean;
		maxPasskeys: number;
		maxPasskeyName: number;
	}
	/** The link to the identity provider (`/api/oidc`); `provider` is null where none is configured. */
	interface OidcStatus {
		provider: string | null;
		link: { createdAt: number; lastUsedAt: number | null } | null;
	}

	let status = $state<Status | null>(null);
	let oidc = $state<OidcStatus | null>(null);
	let loadError = $state<string | null>(null);
	let canPasskey = $state(false);
	let busy = $state<string | null>(null);
	let message = $state<string | null>(null);
	let problem = $state<string | null>(null);

	/** A TOTP app being set up: the secret and the address its QR code holds. */
	let enrolling = $state<{ secret: string; uri: string } | null>(null);
	let enrolCode = $state('');
	/** Recovery codes just made, shown once. */
	let freshCodes = $state<string[] | null>(null);
	let passkeyName = $state('');
	let renaming = $state<string | null>(null);
	let renameTo = $state('');
	let clearName = $state('');
	let requireOn = $state(false);

	/**
	 * The proof being asked for, and what runs once it is given. `label` says
	 * what it is for.
	 */
	let asking = $state<{ label: string; run: (proof: Record<string, unknown>) => Promise<void> } | null>(null);
	let proofCode = $state('');
	let proofPassword = $state('');

	const hasFactor = $derived(!!status && (status.totp || status.passkeys > 0));

	onMount(() => {
		canPasskey = passkeysAvailable();
		requireOn = admin?.required ?? false;
		void refresh();
		void refreshOidc().then(reportOidcReturn);
	});

	async function call(body: Record<string, unknown>, path = '/api/two-factor'): Promise<Record<string, any>> {
		const response = await fetch(path, {
			method: 'POST',
			headers: { 'content-type': 'application/json', accept: 'application/json' },
			body: JSON.stringify(body)
		});
		const answer = await response.json().catch(() => null);
		if (!response.ok) throw new Error(answer?.error ?? answer?.message ?? 'That did not work. Try again.');
		return answer ?? {};
	}

	async function refresh() {
		try {
			const response = await fetch('/api/two-factor', { headers: { accept: 'application/json' } });
			if (!response.ok) throw new Error();
			status = await response.json();
			loadError = null;
		} catch {
			loadError = 'Could not read your sign-in settings. Reload the page to try again.';
		}
	}

	async function refreshOidc() {
		try {
			const response = await fetch('/api/oidc', { headers: { accept: 'application/json' } });
			if (response.ok) oidc = await response.json();
		} catch {
			// The block is left out, and the rest of the page still works.
		}
	}

	/**
	 * What a return from the provider to a link says, in `?oidc=` (the
	 * callback in `routes/login/oidc`). Taken off the address once shown, so a
	 * reload does not show it again.
	 */
	function reportOidcReturn() {
		const result = page.url.searchParams.get('oidc');
		const provider = oidc?.provider;
		if (!result || !provider) return;
		if (result === 'linked') message = `Linked. “Sign in with ${provider}” on the sign-in page now signs in to this account.`;
		else if (result === 'taken') problem = `That ${provider} account is linked to another account here. Unlink it there first.`;
		else if (result === 'cancelled') problem = `The link was cancelled at ${provider}.`;
		else if (result === 'expired') problem = 'That link took too long, or was finished in another browser. Try again.';
		else if (result === 'unreachable') problem = `${provider} could not be reached. Try again shortly.`;
		else problem = `${provider} did not complete the link. Try again.`;
		const url = new URL(page.url);
		url.searchParams.delete('oidc');
		replaceState(url, page.state);
	}

	/** Runs `work` with the buttons held, and reports what it threw. */
	async function act(name: string, work: () => Promise<void>) {
		busy = name;
		problem = null;
		message = null;
		try {
			await work();
		} catch (err) {
			problem = passkeyFailure(err);
		} finally {
			busy = null;
		}
	}

	function ask(label: string, run: (proof: Record<string, unknown>) => Promise<void>) {
		proofCode = '';
		proofPassword = '';
		problem = null;
		message = null;
		asking = { label, run };
	}

	async function prove(kind: 'code' | 'password' | 'passkey') {
		const pending = asking;
		if (!pending) return;
		await act('proof', async () => {
			let proof: Record<string, unknown>;
			if (kind === 'passkey') {
				const options = await call({ action: 'proof-options' });
				proof = { passkey: await usePasskey(options as never) };
			} else if (kind === 'code') {
				proof = { code: proofCode };
			} else {
				proof = { password: proofPassword };
			}
			await pending.run(proof);
			asking = null;
		});
	}

	function ended(count: unknown): string {
		const n = Number(count) || 0;
		return n > 0 ? ` ${n} other session${n === 1 ? ' was' : 's were'} signed out.` : '';
	}

	function startTotp() {
		ask('set up an authenticator app', async (proof) => {
			const started = await call({ action: 'totp-start', proof });
			enrolling = { secret: started.secret, uri: started.uri };
			enrolCode = '';
		});
	}

	async function confirmTotp() {
		await act('totp-confirm', async () => {
			const done = await call({ action: 'totp-confirm', code: enrolCode });
			enrolling = null;
			if (done.recoveryCodes?.length) freshCodes = done.recoveryCodes;
			message = `The authenticator app is on.${ended(done.sessionsEnded)}`;
			await refresh();
		});
	}

	function removeTotp() {
		ask('remove the authenticator app', async (proof) => {
			const done = await call({ action: 'totp-remove', proof });
			message = `The authenticator app is off.${ended(done.sessionsEnded)}`;
			await refresh();
		});
	}

	function newCodes() {
		ask('make new recovery codes', async (proof) => {
			const done = await call({ action: 'recovery-new', proof });
			freshCodes = done.recoveryCodes;
			message = 'New recovery codes. The old ones no longer work.';
			await refresh();
		});
	}

	function addPasskey() {
		const name = passkeyName;
		ask('add a passkey', async (proof) => {
			const options = await call({ action: 'passkey-options', proof });
			const credential = await createPasskey(options as never);
			const done = await call({ action: 'passkey-add', credential, name });
			passkeyName = '';
			if (done.recoveryCodes?.length) freshCodes = done.recoveryCodes;
			message = `Passkey added.${ended(done.sessionsEnded)}`;
			await refresh();
		});
	}

	async function rename(id: string) {
		await act(`rename:${id}`, async () => {
			await call({ action: 'passkey-rename', id, name: renameTo });
			renaming = null;
			await refresh();
		});
	}

	function removePasskey(key: Passkey) {
		ask(`remove the passkey “${key.name}”`, async (proof) => {
			const done = await call({ action: 'passkey-remove', id: key.id, proof });
			message = `Passkey removed.${ended(done.sessionsEnded)}`;
			await refresh();
		});
	}

	function linkOidc() {
		ask(`link your ${oidc?.provider} account`, async (proof) => {
			const answer = await call({ action: 'link', proof }, '/api/oidc');
			// The provider's own page, which sends the browser back to Settings.
			location.assign(answer.url);
		});
	}

	async function unlinkOidc() {
		await act('oidc-unlink', async () => {
			await call({ action: 'unlink' }, '/api/oidc');
			message = `Unlinked. ${oidc?.provider} no longer signs in to this account.`;
			await refreshOidc();
		});
	}

	async function saveRequired() {
		await act('require', async () => {
			await call({ action: 'admin-require', on: requireOn });
			message = requireOn ? 'Every account now needs a second factor.' : 'A second factor is now up to each account.';
			await refresh();
		});
	}

	function clearOther() {
		const username = clearName.trim();
		ask(`clear the second factors of ${username}`, async (proof) => {
			await call({ action: 'admin-clear', username, proof });
			clearName = '';
			message = `${username} can sign in with a password alone again, and has been signed out everywhere.`;
		});
	}

	async function copyCodes() {
		if (!freshCodes) return;
		try {
			await navigator.clipboard.writeText(freshCodes.join('\n'));
			message = 'Copied.';
		} catch {
			problem = 'Could not copy. Select the codes and copy them by hand.';
		}
	}

	const date = (at: number) => new Date(at).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
</script>

{#if loadError}
	<p class="hh-muted" role="alert">{loadError}</p>
{:else if !status}
	<p class="hh-muted">Loading…</p>
{:else}
	{#if status.required && !hasFactor}
		<p class="banner" role="alert">
			This server requires a second factor. Set up an authenticator app or a passkey to go on using it.
		</p>
	{/if}

	{#if message}
		<p class="ok" role="status">{message}</p>
	{/if}
	{#if problem && !asking}
		<p class="problem" role="alert">{problem}</p>
	{/if}

	{#if asking}
		<div class="proof hh-glass" role="group" aria-label="Confirm it is you">
			<p class="title">Confirm it is you to {asking.label}.</p>
			{#if hasFactor}
				<form
					class="inline"
					onsubmit={(event) => {
						event.preventDefault();
						void prove('code');
					}}
				>
					<label class="field">
						<span class="hh-eyebrow">{status.totp ? 'Code from your app, or a recovery code' : 'A recovery code'}</span>
						<!-- svelte-ignore a11y_autofocus -->
						<input
							class="hh-input"
							bind:value={proofCode}
							autocomplete="one-time-code"
							maxlength="64"
							autocapitalize="none"
							spellcheck="false"
							autofocus
							required
						/>
					</label>
					<button class="hh-button hh-button--primary" type="submit" disabled={busy !== null}>Confirm</button>
				</form>
				{#if status.passkeys > 0 && status.passkeysOffered && canPasskey}
					<button class="hh-button" type="button" disabled={busy !== null} onclick={() => prove('passkey')}>
						Confirm with a passkey
					</button>
				{/if}
			{:else}
				<form
					class="inline"
					onsubmit={(event) => {
						event.preventDefault();
						void prove('password');
					}}
				>
					<label class="field">
						<span class="hh-eyebrow">Your password for {serverLabel || 'the music server'}</span>
						<!-- svelte-ignore a11y_autofocus -->
						<input class="hh-input" type="password" bind:value={proofPassword} autocomplete="current-password" autofocus required />
					</label>
					<button class="hh-button hh-button--primary" type="submit" disabled={busy !== null}>Confirm</button>
				</form>
			{/if}
			{#if problem}
				<p class="problem" role="alert">{problem}</p>
			{/if}
			<button class="hh-button hh-button--ghost" type="button" onclick={() => (asking = null)}>Cancel</button>
		</div>
	{/if}

	{#if freshCodes}
		<div class="codes hh-glass">
			<p class="title">Your recovery codes</p>
			<p class="hh-muted small">
				Keep these somewhere safe. Each signs in once in place of your app or passkey. They are not shown again.
			</p>
			<ol class="code-list hh-numeric">
				{#each freshCodes as code (code)}
					<li>{code}</li>
				{/each}
			</ol>
			<div class="actions">
				<button class="hh-button" type="button" onclick={copyCodes}>Copy</button>
				<button class="hh-button hh-button--ghost" type="button" onclick={() => (freshCodes = null)}>I have saved them</button>
			</div>
		</div>
	{/if}

	<div class="block">
		<h3>Authenticator app</h3>
		{#if status.totp}
			<p class="hh-muted small">On. Sign-in asks for the six-digit code from the app after your password.</p>
			<div class="actions">
				<button class="hh-button danger" type="button" disabled={busy !== null || !!asking} onclick={removeTotp}>Remove</button>
			</div>
		{:else if enrolling}
			<p class="hh-muted small">
				Scan this with an authenticator app (Aegis, 2FAS, Google Authenticator, a password manager), or type the key into it.
				Then enter the code it shows.
			</p>
			<div class="enrol">
				<QrCode text={enrolling.uri} label="QR code for your authenticator app" />
				<div class="enrol-side">
					<span class="hh-eyebrow">Key</span>
					<code class="secret">{enrolling.secret.replace(/(.{4})/g, '$1 ').trim()}</code>
					<form
						class="inline"
						onsubmit={(event) => {
							event.preventDefault();
							void confirmTotp();
						}}
					>
						<label class="field">
							<span class="hh-eyebrow">Code from the app</span>
							<input
								class="hh-input"
								bind:value={enrolCode}
								inputmode="numeric"
								autocomplete="one-time-code"
								maxlength="8"
								required
							/>
						</label>
						<button class="hh-button hh-button--primary" type="submit" disabled={busy !== null}>
							{busy === 'totp-confirm' ? 'Checking…' : 'Turn on'}
						</button>
					</form>
					<button class="hh-button hh-button--ghost" type="button" onclick={() => (enrolling = null)}>Cancel</button>
				</div>
			</div>
		{:else}
			<p class="hh-muted small">Off. An app on your phone makes a new code every 30 seconds, asked for after your password.</p>
			<div class="actions">
				<button class="hh-button" type="button" disabled={busy !== null || !!asking} onclick={startTotp}>Set up</button>
			</div>
		{/if}
	</div>

	<div class="block">
		<h3>Passkeys</h3>
		{#if !status.passkeysOffered}
			<p class="hh-muted small">
				Passkeys need this server opened on an https address with a domain name. They cannot be made on this one.
			</p>
		{:else if !canPasskey}
			<p class="hh-muted small">This browser cannot use passkeys.</p>
		{:else}
			<p class="hh-muted small">
				A passkey on this device, your phone or a security key. It stands in for the code after your password, or signs in
				on its own from the sign-in page. A passkey works on this address ({page.url.hostname}) only.
			</p>
		{/if}
		{#if status.passkeyList.length > 0}
			<ul class="keys">
				{#each status.passkeyList as key (key.id)}
					<li>
						{#if renaming === key.id}
							<form
								class="inline"
								onsubmit={(event) => {
									event.preventDefault();
									void rename(key.id);
								}}
							>
								<input class="hh-input" bind:value={renameTo} maxlength={status.maxPasskeyName} aria-label="Name" required />
								<button class="hh-button" type="submit" disabled={busy !== null}>Save</button>
								<button class="hh-button hh-button--ghost" type="button" onclick={() => (renaming = null)}>Cancel</button>
							</form>
						{:else}
							<span class="key-text">
								<span class="hh-truncate">{key.name}</span>
								<span class="hh-muted small">
									Added <span class="hh-numeric">{date(key.createdAt)}</span>{#if key.lastUsedAt}
										· last used <span class="hh-numeric">{date(key.lastUsedAt)}</span>{/if}
								</span>
							</span>
							<span class="actions">
								<button
									class="hh-button hh-button--ghost"
									type="button"
									onclick={() => {
										renaming = key.id;
										renameTo = key.name;
									}}>Rename</button
								>
								<button
									class="hh-button danger"
									type="button"
									disabled={busy !== null || !!asking}
									onclick={() => removePasskey(key)}
									aria-label="Remove the passkey {key.name}">Remove</button
								>
							</span>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}
		{#if status.passkeysOffered && canPasskey && status.passkeys < status.maxPasskeys}
			<form
				class="inline"
				onsubmit={(event) => {
					event.preventDefault();
					addPasskey();
				}}
			>
				<label class="field">
					<span class="hh-eyebrow">Name</span>
					<input class="hh-input" bind:value={passkeyName} maxlength={status.maxPasskeyName} placeholder="Laptop, phone, key…" />
				</label>
				<button class="hh-button" type="submit" disabled={busy !== null || !!asking}>Add a passkey</button>
			</form>
		{/if}
	</div>

	{#if oidc?.provider}
		<div class="block">
			<h3>Single sign-on</h3>
			{#if oidc.link}
				<p class="hh-muted small">
					Linked <span class="hh-numeric">{date(oidc.link.createdAt)}</span>{#if oidc.link.lastUsedAt}
						· last used <span class="hh-numeric">{date(oidc.link.lastUsedAt)}</span>{/if}. “Sign in with {oidc.provider}” on the
					sign-in page signs in to this account{hasFactor ? ', then asks for your second factor' : ''}.
				</p>
				<div class="actions">
					<button class="hh-button danger" type="button" disabled={busy !== null || !!asking} onclick={unlinkOidc}>Unlink</button>
				</div>
			{:else}
				<p class="hh-muted small">
					Link your {oidc.provider} account, and the sign-in page signs in to this one through it, without your password for
					{serverLabel || 'the music server'}.
				</p>
				<div class="actions">
					<button class="hh-button" type="button" disabled={busy !== null || !!asking} onclick={linkOidc}>Link {oidc.provider}</button>
				</div>
			{/if}
		</div>
	{/if}

	{#if hasFactor}
		<div class="block">
			<h3>Recovery codes</h3>
			<p class="hh-muted small">
				<span class="hh-numeric">{status.recoveryCodes}</span> left. Each signs in once if your app and passkeys are lost.
			</p>
			<div class="actions">
				<button class="hh-button" type="button" disabled={busy !== null || !!asking} onclick={newCodes}>Make new codes</button>
			</div>
		</div>
	{/if}

	{#if admin}
		<div class="block">
			<h3>For every account on this server</h3>
			<p class="hh-muted small">Shown to administrators of {serverLabel || 'the music server'}.</p>
			<form
				class="inline"
				onsubmit={(event) => {
					event.preventDefault();
					void saveRequired();
				}}
			>
				<label class="switch">
					<input type="checkbox" bind:checked={requireOn} disabled={admin.fromEnvironment} />
					<span>
						Require a second factor
						<span class="hh-muted small">
							{admin.fromEnvironment
								? 'Set by HEDDOHON_REQUIRE_TWO_FACTOR in the environment.'
								: 'An account without one reaches only this page until it sets one up. Saved in setup.json.'}
						</span>
					</span>
				</label>
				{#if !admin.fromEnvironment}
					<button class="hh-button" type="submit" disabled={busy !== null}>Save</button>
				{/if}
			</form>
			<form
				class="inline"
				onsubmit={(event) => {
					event.preventDefault();
					clearOther();
				}}
			>
				<label class="field">
					<span class="hh-eyebrow">Clear the second factors of</span>
					<input class="hh-input" bind:value={clearName} maxlength="256" placeholder="Username" autocapitalize="none" spellcheck="false" required />
				</label>
				<button class="hh-button danger" type="submit" disabled={busy !== null || !!asking}>Clear</button>
			</form>
			<p class="hh-muted small">
				For someone who has lost their app, passkeys and recovery codes. They are signed out everywhere and sign in again with
				their password alone.
			</p>
		</div>
	{/if}
{/if}

<style>
	.block {
		display: grid;
		gap: var(--space-2);
		padding-top: var(--space-3);
		border-top: 1px solid var(--border-hairline);
	}

	.block:first-of-type {
		border-top: none;
		padding-top: 0;
	}

	h3 {
		margin: 0;
		font-size: 0.95rem;
	}

	.small {
		font-size: 0.8125rem;
		margin: 0;
	}

	.title {
		margin: 0;
		font-weight: 600;
		color: var(--text-strong);
	}

	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
	}

	.inline {
		display: flex;
		flex-wrap: wrap;
		align-items: end;
		gap: var(--space-2);
	}

	.field {
		display: grid;
		gap: 0.3rem;
		flex: 1 1 12rem;
	}

	.switch {
		display: flex;
		gap: var(--space-2);
		align-items: start;
		flex: 1 1 16rem;
	}

	.switch > span {
		display: grid;
		gap: 0.2rem;
	}

	.proof,
	.codes {
		display: grid;
		gap: var(--space-3);
		padding: var(--space-4);
		border-radius: var(--r-md);
	}

	.enrol {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-4);
		align-items: start;
	}

	.enrol-side {
		display: grid;
		gap: var(--space-2);
		flex: 1 1 14rem;
	}

	.secret {
		font-family: var(--font-mono);
		font-size: 0.875rem;
		word-break: break-all;
		user-select: all;
		color: var(--text-strong);
	}

	.code-list {
		margin: 0;
		padding-left: 1.5rem;
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(9rem, 1fr));
		gap: 0.25rem var(--space-4);
		font-family: var(--font-mono);
		user-select: all;
	}

	.keys {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: var(--space-2);
	}

	.keys li {
		display: flex;
		flex-wrap: wrap;
		justify-content: space-between;
		align-items: center;
		gap: var(--space-2);
	}

	.key-text {
		display: grid;
		min-width: 0;
	}

	.banner,
	.ok,
	.problem {
		margin: 0;
		font-size: 0.875rem;
		padding: var(--space-2) var(--space-3);
		border-radius: var(--r-sm);
		color: var(--text-strong);
	}

	.banner,
	.problem {
		border: 1px solid color-mix(in srgb, var(--danger) 45%, transparent);
		background: color-mix(in srgb, var(--danger) 12%, transparent);
	}

	.ok {
		border: 1px solid color-mix(in srgb, var(--positive) 40%, transparent);
		background: color-mix(in srgb, var(--positive) 12%, transparent);
	}
</style>
