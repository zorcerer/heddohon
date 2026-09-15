<script lang="ts">
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import { untrack } from 'svelte';
	import Icon from '$lib/components/Icon.svelte';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	// A local editable copy; re-seeded whenever the server sends new values.
	let settings = $state(untrack(() => ({ ...data.settings })));
	let saving = $state(false);
	let clearing = $state(false);

	// The action returns fresh figures; before it runs, the loader's are current.
	const cache = $derived(
		form && 'coverCache' in form && form.coverCache ? form.coverCache : data.coverCache
	);

	/** Bytes as the nearest sensible unit, one decimal from a megabyte up. */
	function formatSize(bytes: number): string {
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
		return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	}

	$effect(() => {
		settings = { ...data.settings };
	});

	const expiry = $derived(
		data.sessionExpiresAt
			? new Date(data.sessionExpiresAt).toLocaleString(undefined, {
					dateStyle: 'medium',
					timeStyle: 'short'
				})
			: null
	);

	const hoursLeft = $derived(
		data.sessionExpiresAt
			? Math.max(0, Math.round((data.sessionExpiresAt - Date.now()) / 3_600_000))
			: 0
	);
</script>

<svelte:head>
	<title>Settings · Heddohon</title>
</svelte:head>

<div class="page">
	<header>
		<span class="hh-eyebrow">Your account</span>
		<h1>Settings</h1>
		<p class="hh-muted lede">
			These preferences are stored on the server against your account, not in this browser. Sign in
			anywhere and you get the same setup.
		</p>
	</header>

	{#if form?.saved}
		<p class="saved" role="status">Settings saved.</p>
	{/if}

	<form
		method="POST"
		action="?/save"
		use:enhance={() => {
			saving = true;
			return async ({ update }) => {
				await update({ reset: false });
				// The action only returns this page's data. Settings also drive the
				// layout (theme, grid density, player behaviour), so the layout load
				// has to re-run for the rest of the interface to follow the change.
				await invalidateAll();
				saving = false;
			};
		}}
	>
		<section class="hh-card hh-glass group">
			<div class="group-head">
				<h2>Appearance</h2>
				<p class="hh-muted">How the library is drawn.</p>
			</div>

			<label class="row">
				<span class="label">Theme</span>
				<select class="hh-input control" name="theme" bind:value={settings.theme}>
					<option value="dark">Dark</option>
					<option value="light">Light</option>
				</select>
			</label>

			<label class="row">
				<span class="label">
					Interface scale
					<span class="hint hh-muted">
						Sizes the whole interface, the way the browser's own zoom does. The
						player column takes a larger share of the screen as this goes up.
					</span>
				</span>
				<select class="hh-input control" name="uiScale" bind:value={settings.uiScale}>
					<option value="100">100%</option>
					<option value="110">110%</option>
					<option value="125">125%</option>
					<option value="150">150%</option>
					<option value="175">175%</option>
				</select>
			</label>

			<label class="row">
				<span class="label">
					Grid density
					<span class="hint hh-muted">Card size on library pages.</span>
				</span>
				<select class="hh-input control" name="gridSize" bind:value={settings.gridSize}>
					<option value="compact">Compact</option>
					<option value="comfortable">Comfortable</option>
					<option value="roomy">Roomy</option>
				</select>
			</label>

			<label class="row">
				<span class="label">Default album sort</span>
				<select
					class="hh-input control"
					name="defaultAlbumSort"
					bind:value={settings.defaultAlbumSort}
				>
					<option value="recentlyAdded">Recently added</option>
					<option value="alphabetical">A–Z</option>
					<option value="byArtist">By artist</option>
					<option value="byYear">By year</option>
					<option value="mostPlayed">Most played</option>
				</select>
			</label>

			<label class="row switch">
				<span class="label">
					Show quality badge
					<span class="hint hh-muted">
						The FLAC 24/96 tag beside the transport controls. Pressing it turns transcoding on
						and off.
					</span>
				</span>
				<input type="checkbox" name="showQualityBadge" bind:checked={settings.showQualityBadge} />
			</label>
		</section>

		<section class="hh-card hh-glass group">
			<div class="group-head">
				<h2>Playback</h2>
				<p class="hh-muted">
					Audio is streamed in its original format unless you ask for otherwise below. Nothing in
					the chain resamples, so what your library holds is what your browser decodes.
				</p>
			</div>

			<label class="row">
				<span class="label">
					Track transitions
					<span class="hint hh-muted">
						Tight handoff buffers the next track so the join does not wait on the
						network. Crossfade overlaps the two.
					</span>
				</span>
				<select class="hh-input control" name="transition" bind:value={settings.transition}>
					<option value="off">Hard cut</option>
					<option value="gapless">Tight handoff</option>
					<option value="crossfade">Crossfade</option>
				</select>
			</label>

			{#if settings.transition === 'crossfade'}
				<label class="row">
					<span class="label">Crossfade length</span>
					<span class="control range">
						<input
							type="range"
							name="crossfadeSeconds"
							min="1"
							max="12"
							step="1"
							bind:value={settings.crossfadeSeconds}
						/>
						<span class="hh-numeric">{settings.crossfadeSeconds}s</span>
					</span>
				</label>
			{:else}
				<input type="hidden" name="crossfadeSeconds" value={settings.crossfadeSeconds} />
			{/if}

			<label class="row switch">
				<span class="label">
					Preload the next track
					<span class="hint hh-muted">
						Buffers ahead so transitions do not wait on the network. Uses more bandwidth.
					</span>
				</span>
				<input type="checkbox" name="preloadNext" bind:checked={settings.preloadNext} />
			</label>

			<label class="row switch">
				<span class="label">
					Volume normalisation
					<span class="hint hh-muted">
						Applies gain to even out loudness between tracks. Off by default because it alters the
						signal.
					</span>
				</span>
				<input type="checkbox" name="normalizeVolume" bind:checked={settings.normalizeVolume} />
			</label>

			<label class="row switch">
				<span class="label">
					Report playback to {data.serverLabel}
					<span class="hint hh-muted">
						Sends now-playing and play counts so scrobbling and “recently played” work.
					</span>
				</span>
				<input type="checkbox" name="reportPlayback" bind:checked={settings.reportPlayback} />
			</label>
		</section>

		<section class="hh-card hh-glass group">
			<div class="group-head">
				<h2>Transcoding</h2>
				<p class="hh-muted">
					Asks {data.serverLabel} to convert each track as it is sent, instead of sending the file.
					For a connection that will not carry the original, or a browser that cannot decode it.
					The conversion happens on the music server, so what it can produce is decided there.
				</p>
			</div>

			<label class="row switch">
				<span class="label">
					Transcode audio
					<span class="hint hh-muted">
						The quality badge in the player turns this on and off too, without interrupting what
						is playing.
					</span>
				</span>
				<input type="checkbox" name="transcode" bind:checked={settings.transcode} />
			</label>

			<label class="row">
				<span class="label">
					Codec
					<span class="hint hh-muted">
						Opus is the most efficient of the three and is not decoded by every device. MP3 is
						decoded by all of them.
					</span>
				</span>
				<select class="hh-input control" name="transcodeCodec" bind:value={settings.transcodeCodec}>
					<option value="mp3">MP3</option>
					<option value="opus">Opus</option>
					<option value="aac">AAC</option>
				</select>
			</label>

			<label class="row">
				<span class="label">
					Bitrate
					<span class="hint hh-muted">
						A ceiling, not a promise: a music server configured lower will send less.
					</span>
				</span>
				<select
					class="hh-input control"
					name="transcodeBitrateKbps"
					bind:value={settings.transcodeBitrateKbps}
				>
					<option value={96}>96 kbps</option>
					<option value={128}>128 kbps</option>
					<option value={192}>192 kbps</option>
					<option value={256}>256 kbps</option>
					<option value={320}>320 kbps</option>
				</select>
			</label>
		</section>

		<div class="submit-row">
			<button class="hh-button hh-button--primary" type="submit" disabled={saving}>
				{saving ? 'Saving…' : 'Save settings'}
			</button>
		</div>
	</form>

	<section class="hh-card hh-glass group">
		<div class="group-head">
			<h2>Session &amp; security</h2>
		</div>

		<dl class="facts">
			<div>
				<dt>Signed in as</dt>
				<dd>{data.account.username}</dd>
			</div>
			<div>
				<dt>Music server</dt>
				<dd>{data.serverLabel} <span class="hh-eyebrow">{data.account.backend}</span></dd>
			</div>
			<div>
				<dt>This session expires</dt>
				<dd>
					{expiry}
					<span class="hh-numeric hh-muted">({hoursLeft}h left)</span>
				</dd>
			</div>
			<div>
				<dt>Active sessions</dt>
				<dd class="hh-numeric">{data.activeSessions}</dd>
			</div>
		</dl>

		<p class="hh-muted note">
			Sessions have a hard ceiling of {data.sessionMaxHours} hours and are never extended by
			activity — when the clock runs out you sign in again. Your music server password is held
			encrypted on the server and is never sent to this browser.
		</p>

		<form method="POST" action="/logout">
			<button class="hh-button danger" type="submit">
				<Icon name="logout" size={16} />
				Sign out
			</button>
		</form>
	</section>

	<section class="hh-card hh-glass group">
		<div class="group-head">
			<h2>Cover cache</h2>
		</div>

		<dl class="facts">
			<div>
				<dt>Held</dt>
				<dd class="hh-numeric">
					{#if cache.bytes === null}
						Off
					{:else}
						{formatSize(cache.bytes)} in {cache.files} file{cache.files === 1 ? '' : 's'}
					{/if}
				</dd>
			</div>
			<div>
				<dt>Limit</dt>
				<dd class="hh-numeric">
					{cache.limitBytes > 0 ? formatSize(cache.limitBytes) : 'Caching disabled'}
				</dd>
			</div>
			<div>
				<dt>Shared with</dt>
				<dd>
					Everyone signed in to {data.serverLabel || 'the music server'}
					{#if data.isAdmin === false}
						<span class="hh-muted sub">Your account is not an administrator there.</span>
					{/if}
				</dd>
			</div>
		</dl>

		<!--
			The cache is keyed by the music server's cover id, with no account in
			the key, so there is one copy of each cover for everyone. Any account
			may clear it, including one the music server does not treat as an
			administrator, and that is stated rather than enforced: what a clear
			costs is that the next request for each cover goes upstream again.
		-->
		<p class="hh-muted note">
			Artwork is kept on the server the first time it is fetched, so a second
			device does not ask the music server to render it again. The cache holds
			artwork, never audio. Clearing it is safe at any time: the next request
			for each cover fetches it once more, for everyone.
		</p>

		{#if cache.limitBytes > 0}
			<form
				method="POST"
				action="?/clearCovers"
				use:enhance={() => {
					clearing = true;
					return async ({ update }) => {
						await update({ reset: false });
						// The loader reports the held size, so the figures above only
						// follow the clear once it has re-run.
						await invalidateAll();
						clearing = false;
					};
				}}
			>
				<button class="hh-button" type="submit" disabled={clearing}>
					<Icon name="trash" size={16} />
					{clearing ? 'Clearing…' : 'Clear cover cache'}
				</button>
			</form>
		{/if}
	</section>
</div>

<style>
	.page {
		display: grid;
		gap: var(--space-5);
		max-width: 46rem;
	}

	header {
		display: grid;
		gap: 0.2rem;
	}

	.lede {
		margin: var(--space-2) 0 0;
		max-width: 54ch;
	}

	.saved {
		margin: 0;
		padding: var(--space-3) var(--space-4);
		background: color-mix(in srgb, var(--positive) 16%, var(--field-face));
		-webkit-backdrop-filter: var(--control-blur);
		backdrop-filter: var(--control-blur);
		border: 1px solid color-mix(in srgb, var(--positive) 40%, transparent);
		border-radius: var(--r-sm);
		font-size: 0.875rem;
		color: var(--text-strong);
	}

	form {
		display: grid;
		gap: var(--space-5);
	}

	.group {
		padding: var(--space-5);
		display: grid;
		gap: var(--space-4);
	}

	.group-head {
		display: grid;
		gap: 0.2rem;
		padding-bottom: var(--space-3);
		border-bottom: 1px solid var(--border-hairline);
	}

	.group-head p {
		margin: 0;
		font-size: 0.875rem;
		max-width: 56ch;
	}

	.row {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(0, 16rem);
		gap: var(--space-4);
		align-items: center;
	}

	.row.switch {
		grid-template-columns: minmax(0, 1fr) auto;
	}

	.label {
		display: grid;
		gap: 0.15rem;
		font-weight: 500;
		color: var(--text-strong);
		font-size: 0.9375rem;
	}

	.hint {
		font-weight: 400;
		font-size: 0.8125rem;
		max-width: 48ch;
	}

	.control {
		width: 100%;
	}

	select.hh-input {
		cursor: pointer;
	}

	.range {
		display: flex;
		align-items: center;
		gap: var(--space-3);
	}

	.range input[type='range'] {
		flex: 1;
		accent-color: var(--accent);
	}

	input[type='checkbox'] {
		width: 1.15rem;
		height: 1.15rem;
		accent-color: var(--accent);
		cursor: pointer;
	}

	.submit-row {
		display: flex;
		justify-content: flex-end;
	}

	.submit-row .hh-button {
		padding: 0.6rem 1.3rem;
		border-radius: var(--r-md);
	}

	.facts {
		display: grid;
		gap: var(--space-3);
		margin: 0;
	}

	.facts > div {
		display: grid;
		grid-template-columns: minmax(0, 12rem) minmax(0, 1fr);
		gap: var(--space-4);
		align-items: baseline;
	}

	dt {
		color: var(--text-muted);
		font-size: 0.875rem;
	}

	dd {
		margin: 0;
		color: var(--text-strong);
		font-weight: 500;
	}

	/* A second line under a fact rather than a run-on: this one is a sentence,
	   and the eyebrow treatment set it in tracked uppercase that wrapped. */
	.sub {
		display: block;
		font-size: 0.8125rem;
	}

	.note {
		margin: 0;
		font-size: 0.8125rem;
		max-width: 60ch;
		padding-top: var(--space-3);
		border-top: 1px solid var(--border-hairline);
	}

	.danger:hover {
		color: var(--danger);
		border-color: var(--danger);
	}

	@media (max-width: 40rem) {
		.row,
		.row.switch,
		.facts > div {
			grid-template-columns: minmax(0, 1fr);
			gap: var(--space-2);
		}

		.row.switch {
			grid-template-columns: minmax(0, 1fr) auto;
		}
	}
</style>
