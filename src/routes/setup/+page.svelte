<script lang="ts">
	/**
	 * The first-run setup: the code from the server's log, then the music
	 * server and a few choices, then what was saved and what keeping it means.
	 *
	 * Everything is sent to `/api/setup` as JSON with the code, which this page
	 * holds in memory for as long as it is open and nowhere else.
	 */
	import Icon from '$lib/components/Icon.svelte';
	import Logo from '$lib/components/Logo.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	type Kind = 'subsonic' | 'jellyfin';
	type Probe = { state: 'idle' | 'busy' } | { state: 'ok'; server: string } | { state: 'no'; text: string };

	let step = $state<'code' | 'form' | 'done'>('code');
	let code = $state('');
	let busy = $state(false);
	let message = $state<string | null>(null);
	/** What the deployment lacks, told once the code is right. */
	let missing = $state<{ secret: boolean; upstream: boolean }>({ secret: true, upstream: true });

	let servers = $state<Record<Kind, { url: string; label: string; probe: Probe }>>({
		subsonic: { url: '', label: '', probe: { state: 'idle' } },
		jellyfin: { url: '', label: '', probe: { state: 'idle' } }
	});
	let theme = $state<'terminal' | 'liquid' | 'paper'>('terminal');
	let sharing = $state(true);
	let downloads = $state(true);
	let lrclib = $state(false);
	/** Where the deployment is opened: the address in the bar now, until it is changed. */
	let origin = $state('');
	let coverCacheMb = $state(512);
	/** What the environment already decides, and so is not asked for. */
	let decided = $state({ origin: false, coverCache: false });

	/** The key made for the deployment, shown once on the last step. */
	let secret = $state<string | null>(null);
	let copied = $state(false);
	/** What lets this page take the key out of the saved file, once. */
	let forgetToken = $state<string | null>(null);
	let forgetting = $state<'idle' | 'busy' | 'done' | 'failed'>('idle');
	/** The address in the browser's bar, where it is not the one the server believes it has. */
	let otherOrigin = $state<string | null>(null);
	/** The saved addresses the sign-in cookie is sent on without Secure. */
	let withoutSecure = $state<string[]>([]);

	const SERVERS: { kind: Kind; title: string; example: string; name: string }[] = [
		{ kind: 'subsonic', title: 'Navidrome or Subsonic', example: 'http://10.0.0.10:4533', name: 'Navidrome' },
		{ kind: 'jellyfin', title: 'Jellyfin', example: 'http://10.0.0.10:8096', name: 'Jellyfin' }
	];

	const WHY: Record<string, string> = {
		address: 'That is not an address this can use: http:// or https://, with no query.',
		unreachable: 'Nothing answered at that address within five seconds.',
		not_a_music_server: 'Something answered there, and it is not this kind of music server.'
	};

	async function send(body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
		const response = await fetch('/api/setup', {
			method: 'POST',
			headers: { 'content-type': 'application/json', accept: 'application/json' },
			body: JSON.stringify({ code, ...body })
		});
		const parsed = (await response.json().catch(() => ({}))) as Record<string, unknown>;
		return { status: response.status, body: parsed };
	}

	/** What a refusal of the code says, for any step. True when it was one. */
	function refused(status: number): boolean {
		if (status === 401) {
			step = 'code';
			message = 'That is not the code. It is the one printed at this start of the server: a restart makes a new one.';
			return true;
		}
		// Saved from another tab, or the environment was given the rest.
		if (status === 404 || status === 503) {
			location.href = '/login';
			return true;
		}
		return false;
	}

	async function enter(event: SubmitEvent) {
		event.preventDefault();
		if (busy || !code.trim()) return;
		busy = true;
		message = null;
		try {
			const { status, body } = await send({ action: 'check' });
			if (refused(status)) return;
			if (status !== 200) {
				message = 'The server did not take that. Try again.';
				return;
			}
			missing = body.missing as typeof missing;
			decided = (body.environment as typeof decided | undefined) ?? decided;
			origin ||= location.origin;
			step = 'form';
		} catch {
			message = 'The server did not answer.';
		} finally {
			busy = false;
		}
	}

	async function test(kind: Kind) {
		const server = servers[kind];
		if (server.probe.state === 'busy' || !server.url.trim()) return;
		server.probe = { state: 'busy' };
		try {
			const { status, body } = await send({ action: 'probe', kind, url: server.url });
			if (refused(status)) {
				server.probe = { state: 'idle' };
				return;
			}
			server.probe =
				body.ok === true
					? { state: 'ok', server: String(body.server ?? '') }
					: { state: 'no', text: WHY[String(body.why)] ?? 'That address could not be checked.' };
		} catch {
			server.probe = { state: 'no', text: 'The server did not answer.' };
		}
	}

	async function save(event: SubmitEvent) {
		event.preventDefault();
		if (busy) return;
		busy = true;
		message = null;
		try {
			const { status, body } = await send({
				action: 'save',
				values: {
					subsonicUrl: servers.subsonic.url,
					subsonicLabel: servers.subsonic.label,
					jellyfinUrl: servers.jellyfin.url,
					jellyfinLabel: servers.jellyfin.label,
					theme,
					sharing,
					downloads,
					lrclib,
					origin,
					coverCacheMb
				}
			});
			if (refused(status)) return;
			if (body.ok !== true) {
				message = typeof body.message === 'string' ? body.message : 'That could not be saved.';
				return;
			}
			secret = typeof body.secret === 'string' ? body.secret : null;
			forgetToken = typeof body.forgetToken === 'string' ? body.forgetToken : null;
			withoutSecure = Array.isArray(body.withoutSecure) ? body.withoutSecure.map(String) : [];
			// Only where the environment gives the address: one saved here is the
			// browser's own, or the operator's choice to make it another.
			otherOrigin = decided.origin && location.origin !== data.serverOrigin ? location.origin : null;
			// The code is spent, and the page has no more use for it.
			code = '';
			step = 'done';
		} catch {
			message = 'The server did not answer.';
		} finally {
			busy = false;
		}
	}

	/**
	 * Takes the key out of `setup.json`. The server keeps it in memory until
	 * it restarts, so nothing stops working; from then on it has to come from
	 * the environment.
	 */
	async function forgetKey() {
		if (!forgetToken || forgetting === 'busy') return;
		forgetting = 'busy';
		try {
			const response = await fetch('/api/setup', {
				method: 'POST',
				headers: { 'content-type': 'application/json', accept: 'application/json' },
				body: JSON.stringify({ action: 'forget', token: forgetToken })
			});
			forgetting = response.ok ? 'done' : 'failed';
			if (response.ok) forgetToken = null;
		} catch {
			forgetting = 'failed';
		}
	}

	async function copySecret() {
		if (!secret) return;
		try {
			await navigator.clipboard.writeText(`HEDDOHON_SECRET=${secret}`);
			copied = true;
			setTimeout(() => (copied = false), 2400);
		} catch {
			// No clipboard on plain http by address. The line is in a field that selects.
			copied = false;
		}
	}
</script>

<svelte:head>
	<title>Set up Heddohon</title>
</svelte:head>

<main class="stage">
	<div class="panel hh-glass hh-float">
		<header>
			<Logo size={36} />
			<div>
				<span class="hh-eyebrow">First run</span>
				<h1>Set up Heddohon</h1>
			</div>
		</header>

		{#if step === 'code'}
				<p class="lede">
					This server has not been told its music server yet. When it started it printed a code to its
					log, which only someone running it can read. Enter the code to continue.
				</p>
				<p class="how hh-muted">
					With Docker: <code>docker logs heddohon</code>, with the name of your container.
				</p>
				{#if message}<p class="alert" role="alert">{message}</p>{/if}
				<form onsubmit={enter}>
					<label class="field">
						<span class="label">Setup code</span>
						<input
							class="hh-input code"
							bind:value={code}
							name="setup-code"
							placeholder="XXXXX-XXXXX-XXXXX-XXXXX"
							autocomplete="off"
							autocapitalize="characters"
							spellcheck="false"
							maxlength="40"
							required
						/>
					</label>
					<button class="hh-button hh-button--primary" type="submit" disabled={busy || !code.trim()}>
						{busy ? 'Checking…' : 'Continue'}
					</button>
				</form>
		{:else if step === 'form'}
			{#if message}<p class="alert" role="alert">{message}</p>{/if}
			<form onsubmit={save}>
				{#if missing.upstream}
					<p class="lede">
						Give the address of at least one music server, as this server reaches it on its own network.
						It is not shown to anyone who signs in.
					</p>
					{#each SERVERS as { kind, title, example, name } (kind)}
						{@const server = servers[kind]}
						<fieldset>
							<legend>{title}</legend>
							<label class="field">
								<span class="label">Address</span>
								<input
									class="hh-input"
									bind:value={server.url}
									oninput={() => (server.probe = { state: 'idle' })}
									name="{kind}-url"
									type="url"
									placeholder={example}
									autocomplete="off"
									spellcheck="false"
									maxlength="2048"
								/>
							</label>
							<label class="field">
								<span class="label">Name on the sign-in page</span>
								<input class="hh-input" bind:value={server.label} name="{kind}-label" placeholder={name} maxlength="60" />
							</label>
							<div class="probe">
								<button
									class="hh-button"
									type="button"
									onclick={() => test(kind)}
									disabled={server.probe.state === 'busy' || !server.url.trim()}
								>
									{server.probe.state === 'busy' ? 'Asking…' : 'Test the address'}
								</button>
								<span class="result" class:ok={server.probe.state === 'ok'} class:no={server.probe.state === 'no'} aria-live="polite">
									{#if server.probe.state === 'ok'}
										<Icon name="check" size={14} />
										{server.probe.server} answers there.
									{:else if server.probe.state === 'no'}
										{server.probe.text}
									{/if}
								</span>
							</div>
						</fieldset>
					{/each}
				{:else}
					<p class="lede">The music server is set in the environment. What is left is below.</p>
				{/if}

				{#if !decided.origin}
					<fieldset>
						<legend>Address</legend>
						<label class="field">
							<span class="label">Where Heddohon is opened</span>
							<input
								class="hh-input"
								bind:value={origin}
								name="origin"
								placeholder="http://192.168.1.10:3000"
								autocomplete="off"
								spellcheck="false"
								maxlength="1024"
							/>
						</label>
						<p class="how hh-muted">
							The address in this browser's bar, filled in. Sign-in and every change are accepted from it
							and refused from any other site. Add a second one after a space, such as the public
							<code>https://</code> address it will have behind a proxy; an administrator can change the list
							later under Settings, Storage. On a plain <code>http://</code> address on the local network the
							sign-in cookie is sent without <code>Secure</code>, since the browser would not send it back
							otherwise.
						</p>
					</fieldset>
				{/if}

				<fieldset>
					<legend>Choices</legend>
					<label class="field">
						<span class="label">Theme an account starts in</span>
						<select class="hh-input" bind:value={theme} name="theme">
							<option value="terminal">Terminal</option>
							<option value="liquid">Liquid</option>
							<option value="paper">Paper</option>
						</select>
					</label>
					{#if !decided.coverCache}
						<label class="field">
							<span class="label">Cover cache, in megabytes</span>
							<input class="hh-input" bind:value={coverCacheMb} name="coverCacheMb" type="number" min="0" max="65536" step="1" inputmode="numeric" />
							<span class="hint hh-muted">Covers kept on this server's disk, in the data directory. 0 switches the cache off.</span>
						</label>
					{/if}
					<label class="check">
						<input type="checkbox" bind:checked={sharing} name="sharing" />
						<span>
							Shared links and listening together
							<span class="hint hh-muted">An account can make a link that plays a song, an album or a playlist without signing in.</span>
						</span>
					</label>
					<label class="check">
						<input type="checkbox" bind:checked={downloads} name="downloads" />
						<span>
							Downloads
							<span class="hint hh-muted">The original file can be saved from the player.</span>
						</span>
					</label>
					<label class="check">
						<input type="checkbox" bind:checked={lrclib} name="lrclib" />
						<span>
							Lyrics from LRCLIB
							<span class="hint hh-muted">
								For a track the music server has no lyrics for, its artist, title, album and length are sent
								to lrclib.net.
							</span>
						</span>
					</label>
				</fieldset>

				<p class="how hh-muted">
					Every other setting is an environment variable; <code>.env.example</code> lists them. A variable
					set there takes precedence over what is saved here.
				</p>

				<button class="hh-button hh-button--primary" type="submit" disabled={busy}>
					{busy ? 'Saving…' : 'Save and finish'}
				</button>
			</form>
		{:else}
			<p class="lede" role="status">Heddohon is set up. What was entered is saved in <code>setup.json</code> in the data directory.</p>

			{#if secret}
				<section class="notice" aria-labelledby="key-title">
					<h2 id="key-title">The key is yours to keep</h2>
					<p>
						A key was made for this server and saved in <code>setup.json</code>. It protects the music-server
						sign-ins Heddohon stores, and it now sits beside the database that holds them. Anyone who can
						read the data directory, or a backup of it, can read them:
					</p>
					<ul>
						<li>
							<strong>Navidrome and Subsonic:</strong> the password of every account that has signed in, in
							full. The protocol needs it with each request, so it is what is stored.
						</li>
						<li>
							<strong>Jellyfin:</strong> an access token for each account, and not its password, which is
							not kept. The token opens that account on the Jellyfin server until it is revoked there.
						</li>
					</ul>
					<p>
						<strong>Keeping that directory and its backups private is your responsibility.</strong> Heddohon
						cannot do it for you.
					</p>
					<p>To keep the key apart from the data, set it in the container's environment and restart:</p>
					<div class="env">
						<input
							class="hh-input secret"
							readonly
							value="HEDDOHON_SECRET={secret}"
							aria-label="The line for the environment"
							onfocus={(event) => event.currentTarget.select()}
						/>
						<button class="hh-button" type="button" onclick={copySecret}>
							<Icon name={copied ? 'check' : 'copy'} size={15} />
							{copied ? 'Copied' : 'Copy'}
						</button>
					</div>
					<p class="hh-muted small">
						The environment takes precedence. If the key is changed or lost, the stored sign-ins cannot be
						read and every account signs in again.
					</p>
					{#if forgetting === 'done'}
						<p role="status">
							<strong>The key is out of <code>setup.json</code>.</strong> This server keeps it in memory until
							it restarts. Set the line above in its environment before then: started without it, Heddohon
							asks for this setup again and makes a new key.
						</p>
					{:else if forgetToken}
						<p>
							Once the line above is copied somewhere safe, the key can be taken out of
							<code>setup.json</code>, so that it is no longer beside the database:
						</p>
						<div class="env">
							<button class="hh-button" type="button" onclick={forgetKey} disabled={forgetting === 'busy'}>
								<Icon name="trash" size={15} />
								{forgetting === 'busy' ? 'Removing…' : 'I have copied it: remove it from setup.json'}
							</button>
						</div>
						<p class="hh-muted small">
							The server keeps the key in memory until it restarts, so nothing stops working now. Started
							again without <code>HEDDOHON_SECRET</code> in its environment, it asks for this setup again and
							makes a new key, and every account signs in again.
						</p>
						{#if forgetting === 'failed'}
							<p class="alert" role="alert">That did not work. Remove the <code>HEDDOHON_SECRET</code> line from <code>setup.json</code> by hand.</p>
						{/if}
					{/if}
				</section>
			{/if}

			{#if withoutSecure.length > 0}
				<section class="notice" aria-labelledby="http-title">
					<h2 id="http-title">Sign-in on plain http</h2>
					<p>
						On {withoutSecure.join(' and ')} the sign-in cookie is sent without <code>Secure</code>, since a
						browser does not send a <code>Secure</code> cookie back over <code>http://</code>. Anyone who can
						read that network's traffic can read the cookie, and the password as it is typed.
					</p>
					<p>
						<strong>That is yours to accept for a local network.</strong> Put Heddohon behind
						<code>https://</code> before it is reached from anywhere else, and add that address under
						Settings, Storage. Setting <code>HEDDOHON_COOKIE_SECURE=true</code> in the environment ends
						this, and sign-in on a plain <code>http://</code> address with it.
					</p>
				</section>
			{/if}

			{#if otherOrigin}
				<section class="notice" aria-labelledby="origin-title">
					<h2 id="origin-title">Set ORIGIN before signing in</h2>
					<p>
						This page is open at <code>{otherOrigin}</code>, and the server believes it is served at
						<code>{data.serverOrigin}</code>. Sign-in is refused until the two match. Set this in the
						container's environment and restart:
					</p>
					<div class="env">
						<input
							class="hh-input secret"
							readonly
							value="ORIGIN={otherOrigin}"
							aria-label="The line for the environment"
							onfocus={(event) => event.currentTarget.select()}
						/>
					</div>
				</section>
			{/if}

			<a class="hh-button hh-button--primary" href="/login" data-sveltekit-reload>Go to sign in</a>
		{/if}
	</div>
</main>

<style>
	.stage {
		position: relative;
		z-index: 1;
		min-height: 100vh;
		display: grid;
		place-items: center;
		padding: var(--space-6) var(--space-4);
	}

	.panel {
		width: min(34rem, 100%);
		padding: var(--space-6);
		display: grid;
		gap: var(--space-4);
	}

	header {
		display: flex;
		align-items: center;
		gap: var(--space-3);
	}

	h1 {
		font-size: 1.375rem;
		margin: 0.1rem 0 0;
	}

	h2 {
		font-size: 1rem;
		margin: 0;
	}

	p {
		margin: 0;
	}

	.lede {
		color: var(--text-default);
		line-height: 1.55;
	}

	.how,
	.small,
	.hint {
		font-size: 0.8125rem;
		line-height: 1.5;
	}

	code {
		font-family: var(--font-mono);
		font-size: 0.9em;
		color: var(--text-strong);
	}

	form {
		display: grid;
		gap: var(--space-4);
	}

	fieldset {
		display: grid;
		gap: var(--space-3);
		margin: 0;
		padding: var(--space-4);
		border: 1px solid var(--border-hairline);
		border-radius: var(--r-md);
		min-width: 0;
	}

	legend {
		padding: 0 var(--space-2);
		color: var(--text-strong);
		font-weight: 600;
		font-size: 0.875rem;
	}

	.field {
		display: grid;
		gap: var(--space-2);
	}

	.label {
		font-size: 0.8125rem;
		color: var(--text-muted);
	}

	.code {
		font-family: var(--font-mono);
		letter-spacing: 0.08em;
		text-transform: uppercase;
	}

	.probe {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: var(--space-3);
	}

	.result {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		font-size: 0.8125rem;
		color: var(--text-muted);
	}

	.result.ok {
		color: var(--positive);
	}

	.result.no {
		color: var(--danger);
	}

	.check {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr);
		gap: var(--space-3);
		align-items: start;
		font-size: 0.9375rem;
		color: var(--text-strong);
	}

	.check input {
		margin-top: 0.25rem;
		accent-color: var(--accent);
	}

	.hint {
		display: block;
	}

	.alert {
		background: color-mix(in srgb, var(--danger) 14%, var(--bg-sunken));
		border: 1px solid color-mix(in srgb, var(--danger) 45%, transparent);
		border-radius: var(--r-sm);
		padding: var(--space-3) var(--space-4);
		font-size: 0.875rem;
		color: var(--text-strong);
	}

	/* What the operator has to read before going on: set off from the rest by
	   an edge in the accent, and not by colour alone. */
	.notice {
		display: grid;
		gap: var(--space-3);
		padding: var(--space-4);
		border: 1px solid var(--border-strong);
		border-left: 3px solid var(--accent);
		border-radius: var(--r-sm);
		background: var(--bg-sunken);
		font-size: 0.875rem;
		line-height: 1.55;
	}

	.notice ul {
		margin: 0;
		padding-left: 1.1rem;
		display: grid;
		gap: var(--space-2);
	}

	.env {
		display: flex;
		gap: var(--space-2);
	}

	.secret {
		font-family: var(--font-mono);
		font-size: 0.75rem;
		min-width: 0;
	}

	.hh-button {
		justify-self: start;
	}

	.env .hh-button {
		flex: none;
	}
</style>
