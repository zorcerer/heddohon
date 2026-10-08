<script lang="ts">
	import { enhance } from '$app/forms';
	import { invalidateAll, replaceState } from '$app/navigation';
	import { page } from '$app/state';
	import type { SubmitFunction } from '@sveltejs/kit';
	import { untrack } from 'svelte';
	import Cover from '$lib/components/Cover.svelte';
	import Avatar from '$lib/components/Avatar.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import { avatarUrl, listeners } from '$lib/client/listeners.svelte';
	import { player } from '$lib/client/player.svelte';
	import { EQ_FREQUENCIES, EQ_RANGE_DB } from '$lib/client/audiochain';
	import { EQ_PRESETS, processing } from '$lib/client/processing.svelte';
	import { APP_KINDS, APP_RELEASES, installer, INSTALL_STEPS } from '$lib/client/install.svelte';

	/** One of Heddohon's own apps for this system, where there is one; see `install.svelte.ts`. */
	const appKind = $derived(
		installer.route === 'app-windows' || installer.route === 'app-linux' || installer.route === 'app-android' ? APP_KINDS[installer.route] : null
	);

	/** A band's centre as it is printed under its slider: 31, 1k, 16k. */
	const bandLabel = (hz: number) => (hz >= 1000 ? `${hz / 1000}k` : String(hz));

	/*
	 * The headphone correction: a search of the AutoEq database where the
	 * server offers it (`data.autoeq`), and a ParametricEQ.txt read in this
	 * browser either way.
	 */
	interface HeadphoneMatch {
		id: string;
		name: string;
		source: string;
		rig: string | null;
	}
	let headphoneQuery = $state('');
	let headphoneMatches = $state<HeadphoneMatch[] | null>(null);
	let correctionError = $state<string | null>(null);
	let correctionBusy = $state(false);
	let searchSerial = 0;
	let searchTimer: ReturnType<typeof setTimeout> | undefined;

	/** Asks 250ms after the last key, and drops an answer that a later one has overtaken. */
	function searchHeadphones() {
		clearTimeout(searchTimer);
		const query = headphoneQuery.trim();
		const serial = ++searchSerial;
		correctionError = null;
		if (query.length < 2) {
			headphoneMatches = null;
			return;
		}
		searchTimer = setTimeout(async () => {
			const response = await fetch(`/api/autoeq?q=${encodeURIComponent(query)}`).catch(() => null);
			if (serial !== searchSerial) return;
			if (!response?.ok) {
				headphoneMatches = null;
				correctionError = 'The headphone database could not be reached. Try again later.';
				return;
			}
			headphoneMatches = (await response.json()).results as HeadphoneMatch[];
		}, 250);
	}

	async function chooseHeadphone(match: HeadphoneMatch) {
		correctionBusy = true;
		correctionError = null;
		const chosen = await processing.chooseCorrection(match.id);
		correctionBusy = false;
		if (!chosen) {
			correctionError = 'That correction could not be fetched. Try again later.';
			return;
		}
		headphoneQuery = '';
		headphoneMatches = null;
	}

	async function importCorrection(input: HTMLInputElement) {
		const file = input.files?.[0];
		// Emptied so that choosing the same file again is a change.
		input.value = '';
		if (!file) return;
		correctionError = (await processing.importCorrection(file))
			? null
			: 'That file holds no filters. It should be a ParametricEQ.txt, with lines such as "Filter 1: ON PK Fc 105 Hz Gain 6.4 dB Q 0.70".';
	}

	const signed = (db: number) => `${db > 0 ? '+' : ''}${db.toFixed(1)}`;
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	// A local editable copy; re-seeded whenever the server sends new values.
	let settings = $state(untrack(() => ({ ...data.settings })));
	let saving = $state(false);
	let clearing = $state(false);
	let clearingHistory = $state(false);
	let importingHistory = $state(false);
	/** How long the listening history is kept, saved on its own as it is changed. */
	let historyDays = $state(untrack(() => data.settings.historyDays));
	async function keepHistory(days: number) {
		if (days !== 0 && days !== 90 && days !== 365) return;
		historyDays = days;
		await fetch('/api/settings', {
			method: 'PATCH',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ historyDays: days })
		}).catch(() => undefined);
	}
	/** Whether what the account plays in other apps is shown to the other accounts, saved as it is changed. */
	let listeningOtherApps = $state(untrack(() => data.settings.listeningOtherApps));
	async function showOtherApps(on: boolean) {
		listeningOtherApps = on;
		await fetch('/api/settings', {
			method: 'PATCH',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ listeningOtherApps: on })
		}).catch(() => undefined);
	}
	/** Whether plays the Navidrome plugin reports from other apps are noted, saved as it is changed. */
	let historyOtherApps = $state(untrack(() => data.settings.historyOtherApps));
	async function keepOtherApps(on: boolean) {
		historyOtherApps = on;
		await fetch('/api/settings', {
			method: 'PATCH',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ historyOtherApps: on })
		}).catch(() => undefined);
	}
	/** The session lifetime in days where it is a whole number of them, and in hours otherwise. */
	const sessionLifetime = $derived(
		data.sessionMaxHours % 24 === 0
			? `${data.sessionMaxHours / 24} day${data.sessionMaxHours === 24 ? '' : 's'}`
			: `${data.sessionMaxHours} hour${data.sessionMaxHours === 1 ? '' : 's'}`
	);
	/*
	 * What this account shows the others on this server; see `ListeningNow.svelte`.
	 * Each control saves as it is used. The page's own copy stands until the
	 * event stream or a save has said what the profile is.
	 */
	const profile = $derived(listeners.you ?? data.profile);
	let profileName = $state(untrack(() => data.profile?.name ?? ''));
	let profileBusy = $state(false);
	let pictureInput = $state<HTMLInputElement | null>(null);

	async function saveProfile(work: () => Promise<boolean>) {
		profileBusy = true;
		await work();
		profileBusy = false;
	}

	async function saveName(event: SubmitEvent) {
		event.preventDefault();
		await saveProfile(() => listeners.save({ name: profileName.trim() || null }));
		// As the server keeps it: cut, and its white space collapsed.
		if (!listeners.error) profileName = listeners.you?.name ?? '';
	}

	async function choosePicture(input: HTMLInputElement) {
		const file = input.files?.[0];
		// Emptied, so choosing the same file again is a change.
		input.value = '';
		if (file) await saveProfile(() => listeners.setPicture(file));
	}

	let withdrawing = $state<string | null>(null);
	let ending = $state<string | null>(null);

	/*
	 * One group of settings at a time, chosen by tab. The tabs are links to
	 * `?tab=`, so a tab can be linked to and opens without JavaScript. With it,
	 * the switch happens here without asking the server for the page again.
	 *
	 * Sections on other tabs are hidden, not left out. The save form spans
	 * Appearance and Playback, and the server reads every field on each save,
	 * so a field missing from the post would be saved as its default.
	 */
	const TABS = [
		{ id: 'appearance', label: 'Appearance' },
		{ id: 'playback', label: 'Playback' },
		{ id: 'history', label: 'Listening history' },
		{ id: 'account', label: 'Account' },
		{ id: 'sharing', label: 'Shared links' },
		{ id: 'storage', label: 'Cover cache' }
	] as const;
	type Tab = (typeof TABS)[number]['id'];

	const sharingShown = $derived(data.sharing || data.shares.length > 0);
	const tabs = $derived(TABS.filter((entry) => entry.id !== 'sharing' || sharingShown));

	function tabFrom(url: URL): Tab {
		const requested = url.searchParams.get('tab');
		if (TABS.some((entry) => entry.id === requested)) return requested as Tab;
		// The way back from last.fm lands on the section that started it.
		return url.searchParams.has('lastfm') ? 'account' : 'appearance';
	}

	let tab = $state<Tab>(untrack(() => tabFrom(page.url)));
	// A link to the sharing tab where sharing is off and no links remain.
	const shown = $derived<Tab>(tab === 'sharing' && !sharingShown ? 'appearance' : tab);

	function selectTab(event: MouseEvent, next: Tab) {
		// A modified click opens the tab's link as a link would.
		if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
		event.preventDefault();
		tab = next;
		replaceState(`?tab=${next}`, page.state);
	}

	// A browser signs out only sessions that began before it did.
	const endableSessions = $derived(data.sessions.filter((entry) => entry.endable).length);

	const shortDate = (at: number) =>
		new Date(at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

	// The action returns fresh figures; before it runs, the loader's are current.
	const cache = $derived(
		form && 'coverCache' in form && form.coverCache ? form.coverCache : data.coverCache
	);

	/*
	 * Caching every cover: started here, done by the server (`coverfill.ts`).
	 * The loader gives where it stands when the page opens, and while it runs
	 * the page asks again every 1.5 seconds, with the Cover cache tab showing.
	 */
	let fill = $state(untrack(() => data.coverFill));
	let fillError = $state('');
	const filling = $derived(fill.state === 'listing' || fill.state === 'running');

	$effect(() => {
		fill = data.coverFill;
	});

	async function fillRequest(method: 'GET' | 'POST' | 'DELETE') {
		const response = await fetch('/api/cover-fill', { method }).catch(() => null);
		if (!response?.ok) {
			// A poll that fails is asked again; a start that fails is said.
			if (method !== 'GET') {
				const body = await response?.json().catch(() => null);
				fillError = body?.message ?? 'The server did not answer. Try again.';
			}
			return;
		}
		fillError = '';
		const was = filling;
		fill = await response.json();
		// The loader reports the held size, which the fill has changed.
		if (was && !filling) await invalidateAll();
	}

	$effect(() => {
		if (!filling || shown !== 'storage') return;
		const timer = setInterval(() => void fillRequest('GET'), 1500);
		return () => clearInterval(timer);
	});

	/** Whether the server repeats the fill daily; see `keepFilled` in `coverfill.ts`. */
	let daily = $state(untrack(() => data.coverFillDaily));

	$effect(() => {
		daily = data.coverFillDaily;
	});

	/** Sends the switch as it now stands, and puts it back where the server refused. */
	async function saveDaily() {
		const response = await fetch('/api/cover-fill', {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ daily })
		}).catch(() => null);
		if (!response?.ok) {
			const body = await response?.json().catch(() => null);
			fillError = body?.message ?? 'The server did not answer. Try again.';
			daily = !daily;
			return;
		}
		// Switching it on starts a fill.
		await fillRequest('GET');
	}

	const fillSummary = $derived.by(() => {
		const count = (n: number) => `${n.toLocaleString()} cover${n === 1 ? '' : 's'}`;
		const progress = `${fill.done.toLocaleString()} of ${count(fill.total)}`;
		if (fill.state === 'done') {
			const missing = fill.failed > 0 ? `, and ${fill.failed.toLocaleString()} could not be stored` : '';
			return `${count(fill.stored)} stored. ${(fill.done - fill.stored - fill.failed).toLocaleString()} were already held${missing}.`;
		}
		if (fill.state === 'full') return `Stopped at the limit after ${progress}. A higher HEDDOHON_COVER_CACHE_MB holds the rest.`;
		if (fill.state === 'stopped') return `Stopped after ${progress}. Starting again skips the covers already held.`;
		if (fill.state === 'failed') return `The music server stopped answering after ${progress}. Starting again skips the covers already held.`;
		return '';
	});

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

	/** Which service's form is waiting on the server. */
	let linking = $state<'lastfm' | 'listenbrainz' | null>(null);

	/** What the return from last.fm said, from the query `/settings/lastfm` redirects with. */
	const LASTFM_NOTICES: Record<string, string> = {
		linked: 'Last.fm is linked.',
		failed: 'The music server did not accept the approval from last.fm. Try linking again.',
		refused: 'That approval was not started from this session, or it took longer than 5 minutes. Try linking again.'
	};
	// Own keys only: an object literal also answers `constructor`, `toString`
	// and `__proto__`, and `?lastfm=constructor` printed a function's source.
	const lastfmNotice = $derived.by(() => {
		const key = page.url.searchParams.get('lastfm') ?? '';
		return Object.hasOwn(LASTFM_NOTICES, key) ? LASTFM_NOTICES[key] : null;
	});

	/** An enhanced form that re-reads the page, so the link state follows the change. */
	function refreshAfter(service: 'lastfm' | 'listenbrainz'): SubmitFunction {
		return () => {
			linking = service;
			return async ({ update }) => {
				await update({ reset: false });
				await invalidateAll();
				linking = null;
			};
		};
	}

	/** Which of the two forms under "Your plays, elsewhere" is waiting on the server. */
	let integrating = $state<'discord' | 'listenbrainz' | null>(null);

	function integrationSubmit(kind: 'discord' | 'listenbrainz'): SubmitFunction {
		return () => {
			integrating = kind;
			return async ({ update }) => {
				// Reset, so a webhook address or a token does not stay in the field.
				await update({ reset: true });
				await invalidateAll();
				integrating = null;
			};
		};
	}

	/**
	 * Sends the browser to last.fm. The action returns the URL: `form-action
	 * 'self'` refuses a redirect to another origin after a form post, and the
	 * enhanced form's `goto` refuses one too.
	 */
	const toLastfm: SubmitFunction = () => {
		linking = 'lastfm';
		return async ({ result, update }) => {
			if (result.type === 'success' && typeof result.data?.lastfmUrl === 'string') {
				window.location.assign(result.data.lastfmUrl);
				return;
			}
			await update({ reset: false });
			linking = null;
		};
	};

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

	<nav class="tabs" aria-label="Settings">
		{#each tabs as entry (entry.id)}
			<a
				class="tab"
				class:active={entry.id === shown}
				href="?tab={entry.id}"
				aria-current={entry.id === shown ? 'page' : undefined}
				data-sveltekit-noscroll
				data-sveltekit-preload-data="off"
				onclickcapture={(event) => selectTab(event, entry.id)}
			>
				{entry.label}
			</a>
		{/each}
	</nav>

	{#if form?.saved}
		<p class="saved" role="status">Settings saved.</p>
	{/if}

	<form
		method="POST"
		action="?/save"
		hidden={shown !== 'appearance' && shown !== 'playback'}
		use:enhance={() => {
			saving = true;
			return async ({ update }) => {
				await update({ reset: false });
				// The action returns only this page's data. Settings also drive the
				// layout (theme, grid density, player behaviour), so the layout load
				// re-runs.
				await invalidateAll();
				saving = false;
			};
		}}
	>
		<section class="hh-card hh-glass group" hidden={shown !== 'appearance'}>
			<div class="group-head">
				<h2>Appearance</h2>
				<p class="hh-muted">How the library is drawn.</p>
			</div>

			<label class="row">
				<span class="label">
					Theme
					<span class="hint hh-muted">
						Liquid is dark glass lit by the artwork. Paper is parchment and ink, tinted by it.
					</span>
				</span>
				<select class="hh-input control" name="theme" bind:value={settings.theme}>
					<option value="dark">Liquid</option>
					<option value="light">Paper</option>
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
					Font
					<span class="hint hh-muted">
						The typeface across the interface. Figures and labels stay in the mono face.
					</span>
					<!-- In the face chosen, before it is saved; see `[data-font]` in app.css. -->
					<span class="font-sample" data-font={settings.font} aria-hidden="true">
						Album of the year · 24 tracks
					</span>
				</span>
				<select class="hh-input control" name="font" bind:value={settings.font}>
					<option value="manrope">Manrope</option>
					<option value="inter">Inter</option>
					<option value="geist">Geist</option>
					<option value="plex">IBM Plex Sans</option>
					<option value="atkinson">Atkinson Hyperlegible</option>
					<option value="system">System</option>
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

			<label class="row">
				<span class="label">
					Aurora
					<span class="hint hh-muted">
						A glow in the artwork's colours behind the glass. Moving, it drifts slowly, and the glass
						redraws its blur as it does; still or off costs nothing, for older or low-powered
						hardware and for battery.
					</span>
				</span>
				<select class="hh-input control" name="aurora" bind:value={settings.aurora}>
					<option value="moving">Moving</option>
					<option value="still">Still</option>
					<option value="off">Off</option>
				</select>
			</label>
		</section>

		<section class="hh-card hh-glass group" hidden={shown !== 'playback'}>
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
					<span class="label">
						Crossfade length
						{#if !player.rampsVolume && !processing.enabled}
							<span class="hint hh-muted">
								On this device only its buttons set the volume, as on an iPhone or iPad, so tracks
								change with a tight handoff instead.
							</span>
						{/if}
					</span>
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

				<label class="row switch">
					<span class="label">
						Crossfade within an album
						<span class="hint hh-muted">
							Off, a track followed by the next one on its album gets the tight handoff, so a live
							album or a mix runs on as it was recorded.
						</span>
					</span>
					<input type="checkbox" name="crossfadeWithinAlbum" bind:checked={settings.crossfadeWithinAlbum} />
				</label>
			{:else}
				<input type="hidden" name="crossfadeSeconds" value={settings.crossfadeSeconds} />
				{#if settings.crossfadeWithinAlbum}
					<input type="hidden" name="crossfadeWithinAlbum" value="on" />
				{/if}
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
						Uses the ReplayGain data {data.serverLabel || 'the music server'} reports to bring loud
						tracks down to the level of quieter ones. Tracks without that data play unchanged. The
						file itself is not altered; only the playback level is.
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

			<!--
				Unlike the rows above, these are kept in this browser, for the
				headphones or speakers it plays through, and apply as they are
				changed. Their inputs have no names, so the save form does not post
				them.
			-->
			<h3 class="subhead">Equaliser</h3>
			<p class="hh-muted note">Kept in this browser only. Applied as you change it.</p>

			<label class="row switch">
				<span class="label">
					Process audio in this browser
					<span class="hint hh-muted">
						Plays through Web Audio at the output device's rate, which the equaliser needs. Volume
						normalisation can then raise quiet tracks as well as lower loud ones, and a crossfade works on
						an iPhone or iPad.
						{#if player.processing && !processing.enabled}
							Switched off; this page keeps processing until it is loaded again.
						{/if}
					</span>
				</span>
				<input
					type="checkbox"
					checked={processing.enabled}
					onchange={(event) => processing.setEnabled(event.currentTarget.checked)}
				/>
			</label>

			{#if processing.enabled}
				<label class="row" class:set-aside={processing.bandsOff}>
					<span class="label">
						Preset
						{#if processing.bandsOff}
							<span class="hint hh-muted">
								The bands are off while a headphone correction is in use, and come back as
								they were when it is removed.
							</span>
						{/if}
					</span>
					<select
						class="hh-input control"
						disabled={processing.bandsOff}
						value={processing.preset ?? ''}
						onchange={(event) => processing.applyPreset(event.currentTarget.value)}
					>
						{#if processing.preset === null}
							<option value="">Custom</option>
						{/if}
						{#each Object.entries(EQ_PRESETS) as [key, preset] (key)}
							<option value={key}>{preset.label}</option>
						{/each}
					</select>
				</label>

				<div class="eq" class:set-aside={processing.bandsOff} role="group" aria-label="Equaliser bands">
					{#each EQ_FREQUENCIES as frequency, band (frequency)}
						<label class="band">
							<span class="gain hh-numeric">{processing.gains[band] > 0 ? '+' : ''}{processing.gains[band]}</span>
							<input
								type="range"
								min={-EQ_RANGE_DB}
								max={EQ_RANGE_DB}
								step="1"
								value={processing.gains[band]}
								aria-label="{bandLabel(frequency)}Hz, in dB"
								disabled={processing.bandsOff}
								oninput={(event) => processing.setGain(band, Number(event.currentTarget.value))}
							/>
							<span class="hz hh-numeric">{bandLabel(frequency)}</span>
						</label>
					{/each}
				</div>

				<div class="correction">
					<div class="label">
						Headphone correction
						<span class="hint hh-muted">
							A preamp and filters measured for one headphone. While one is in use the bands above are off.
							{#if data.autoeq}
								Search the AutoEq database, or import a ParametricEQ.txt.
							{:else}
								Import a ParametricEQ.txt, the file AutoEq and Equalizer APO use.
							{/if}
						</span>
					</div>

					{#if processing.correction}
						{@const chosen = processing.correction}
						<p class="chosen">
							<span>
								<strong>{chosen.name}</strong>
								<span class="hh-muted">
									{chosen.source ? `${chosen.source} · ` : ''}{chosen.filters.length} filter{chosen.filters.length === 1 ? '' : 's'},
									preamp {signed(chosen.preamp)} dB
								</span>
							</span>
							<button class="hh-button" type="button" onclick={() => processing.setCorrection(null)}>Remove</button>
						</p>
					{/if}

					<div class="correction-actions">
						{#if data.autoeq}
							<!-- Enter would submit the settings form this sits in. -->
							<input
								class="hh-input"
								type="search"
								placeholder="Search headphones"
								aria-label="Search headphones"
								autocomplete="off"
								bind:value={headphoneQuery}
								oninput={searchHeadphones}
								onkeydown={(event) => event.key === 'Enter' && event.preventDefault()}
							/>
						{/if}
						<label class="hh-button import">
							<Icon name="plus" size={16} />
							Import ParametricEQ.txt
							<input
								class="hh-visually-hidden"
								type="file"
								accept=".txt,text/plain"
								onchange={(event) => void importCorrection(event.currentTarget)}
							/>
						</label>
					</div>

					{#if headphoneMatches}
						{#if headphoneMatches.length === 0}
							<p class="hh-muted note">No headphone by that name in the database.</p>
						{:else}
							<ul class="matches" aria-label="Headphones found">
								{#each headphoneMatches as match (match.id)}
									<li>
										<button type="button" disabled={correctionBusy} onclick={() => void chooseHeadphone(match)}>
											<span>{match.name}</span>
											<span class="hh-muted">{match.source}{match.rig ? ` on ${match.rig}` : ''}</span>
										</button>
									</li>
								{/each}
							</ul>
						{/if}
					{/if}
					{#if correctionError}<p class="note" role="alert">{correctionError}</p>{/if}
				</div>
			{/if}
		</section>

		<section class="hh-card hh-glass group" hidden={shown !== 'playback'}>
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

	<!-- Outside the save form: nothing here is posted with it. -->
	<section class="hh-card hh-glass group" id="install" hidden={shown !== 'appearance'}>
		<div class="group-head">
			<h2>Install the app</h2>
			<p class="hh-muted">A window of its own, with an icon in the dock, Start menu or home screen.</p>
		</div>

		{#if installer.installed}
			<p class="note">You are using the app.</p>
		{:else if appKind}
			<p class="note">
				{data.appName} for {appKind.system} is {appKind.files}, with the latest release. It opens this server
				in a window of its own.
			</p>
			<div class="install-ways">
				<!-- Another site: a new tab, told nothing about this one. -->
				<a class="hh-button" href={APP_RELEASES} target="_blank" rel="noopener noreferrer">
					<Icon name="download" size={16} />
					{appKind.action}
				</a>
				{#if installer.route === 'app-android' && installer.canPrompt}
					<button class="hh-button" type="button" disabled={installer.busy} onclick={() => void installer.install()}>
						Install from the browser
					</button>
				{/if}
			</div>
		{:else if installer.route === 'prompt'}
			<button class="hh-button" type="button" disabled={installer.busy} onclick={() => void installer.install()}>
				<Icon name="download" size={16} />
				Install {data.appName}
			</button>
		{:else if installer.route === 'safari-mac' || installer.route === 'safari-ios' || installer.route === 'edge'}
			<p class="note">{INSTALL_STEPS[installer.route]}</p>
		{:else}
			<p class="hh-muted note">
				This browser does not install web apps. On a Mac, Chrome and Edge do, and Safari 17 or later; on
				iPhone and iPad, Safari does.
			</p>
		{/if}
	</section>

	<section class="hh-card hh-glass group" hidden={shown !== 'account'}>
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
		</dl>

		<!--
			Every browser signed in to this account, the most recently used first,
			with this one marked. Another can be signed out from here. This one
			signs out with the button below, which also clears its cookie.
		-->
		<div class="sessions-head">
			<h3>Signed in on</h3>
			<span class="hh-numeric hh-muted">{data.sessions.length}</span>
		</div>

		{#if form && 'sessionError' in form && form.sessionError}
			<p class="hh-muted note-inline" role="alert">{form.sessionError}</p>
		{/if}

		<ul class="shares sessions">
			{#each data.sessions as entry (entry.handle)}
				<li class="session">
					<span class="share-text">
						<span class="share-title hh-truncate">
							{entry.device ?? 'Unknown browser'}
							{#if entry.current}<span class="this hh-eyebrow">This browser</span>{/if}
						</span>
						<span class="share-sub hh-truncate hh-muted">
							Signed in <span class="hh-numeric">{shortDate(entry.createdAt)}</span> · last used
							<span class="hh-numeric">{shortDate(entry.lastSeenAt)}</span>
						</span>
					</span>
					{#if !entry.current && !entry.endable}
						<!-- Signed in after this browser; see `endSessions` in auth.ts. A
						     greyed "Sign out from that browser" read as a button that did
						     not work, so this says why there is none and what to do. -->
						<span class="hh-muted later">
							Signed in after this browser.
							<span class="later-how">Sign it out there, or sign in again here.</span>
						</span>
					{:else if !entry.current}
						<form
							method="POST"
							action="?/endSession"
							use:enhance={() => {
								ending = entry.handle;
								return async ({ update }) => {
									await update({ reset: false });
									await invalidateAll();
									ending = null;
								};
							}}
						>
							<input type="hidden" name="handle" value={entry.handle} />
							<button
								class="hh-button danger withdraw"
								type="submit"
								disabled={ending === entry.handle}
								aria-label="Sign out {entry.device ?? 'the unknown browser'}, last used {shortDate(entry.lastSeenAt)}"
							>
								{ending === entry.handle ? 'Signing out…' : 'Sign out'}
							</button>
						</form>
					{/if}
				</li>
			{/each}
		</ul>

		<p class="hh-muted note">
			A sign-in lasts {sessionLifetime} and is not extended by activity: when the time is up,
			you sign in again. Your music server password is held
			encrypted on the server and is never sent to this browser. Signing out does not withdraw
			shared links; see below.
		</p>

		<div class="session-actions">
			<form method="POST" action="/logout">
				<button class="hh-button danger" type="submit">
					<Icon name="logout" size={16} />
					Sign out
				</button>
			</form>
			{#if endableSessions > 0}
				<form
					method="POST"
					action="?/endOtherSessions"
					use:enhance={() => {
						ending = 'others';
						return async ({ update }) => {
							await update({ reset: false });
							await invalidateAll();
							ending = null;
						};
					}}
				>
					<button class="hh-button danger" type="submit" disabled={ending === 'others'}>
						{ending === 'others'
							? 'Signing out…'
							: `Sign out everywhere else (${endableSessions})`}
					</button>
				</form>
			{/if}
		</div>
	</section>

	<!-- Only where the operator has left it on; see `HEDDOHON_LISTENERS`. -->
	{#if profile}
		<section class="hh-card hh-glass group" id="listening" hidden={shown !== 'account'}>
			<div class="group-head">
				<h2>Listening now</h2>
				<p class="hh-muted">
					Accounts on this server can show each other what they are playing. While you are shown,
					everyone signed in here sees your name, your picture and the track you are playing, for as
					long as it plays. You see the others whether or not you are shown.
				</p>
			</div>

			{#if listeners.error}
				<p class="hh-muted note-inline" role="alert">{listeners.error}</p>
			{/if}

			<label class="row switch">
				<span class="label">
					Show others what I play
					<span class="hint hh-muted">
						{profile.shown
							? `You are shown as ${profile.name ?? data.account.username}.`
							: 'Off, nothing you play is shown to anyone.'}
					</span>
				</span>
				<input
					type="checkbox"
					checked={profile.shown}
					disabled={profileBusy}
					onchange={(event) => {
						const shown = event.currentTarget.checked;
						void saveProfile(() => listeners.save({ shown }));
					}}
				/>
			</label>

			<!-- Only with the Navidrome plugin, which is what hears of the other apps. -->
			{#if data.plugin}
				<label class="row switch">
					<span class="label">
						Include what I play in other apps
						<span class="hint hh-muted">
							{data.serverLabel || 'Navidrome'} tells this server what you play in any other app signed in as
							you, and with this on the others see that too, with no browser of yours open here. Most apps
							do not say when they pause or stop, so a track is shown until it would have ended.
							{#if !profile.shown}
								It applies once you are shown.
							{/if}
						</span>
					</span>
					<input
						type="checkbox"
						checked={listeningOtherApps}
						onchange={(event) => void showOtherApps(event.currentTarget.checked)}
					/>
				</label>
			{/if}

			<div class="row">
				<label class="label" for="profile-name">
					Display name
					<span class="hint hh-muted">
						The name the others see, up to 32 characters. Left empty, it is your user name,
						{data.account.username}.
					</span>
				</label>
				<form class="profile-name" onsubmit={saveName}>
					<input
						id="profile-name"
						class="hh-input"
						type="text"
						bind:value={profileName}
						maxlength="32"
						autocomplete="nickname"
						spellcheck="false"
						placeholder={data.account.username}
					/>
					<button class="hh-button" type="submit" disabled={profileBusy || profileName.trim() === (profile.name ?? '')}>
						Save
					</button>
				</form>
			</div>

			<div class="row">
				<span class="label">
					Picture
					<span class="hint hh-muted">
						This browser cuts the middle of the image to a square and scales it to 256 pixels before
						it is sent.
					</span>
				</span>
				<div class="profile-picture">
					<Avatar
						name={profile.name ?? data.account.username}
						src={avatarUrl(profile.id, profile.avatar)}
						size={3.5}
					/>
					<input
						bind:this={pictureInput}
						type="file"
						accept="image/*"
						hidden
						aria-label="Picture file"
						onchange={(event) => choosePicture(event.currentTarget)}
					/>
					<button class="hh-button" type="button" disabled={profileBusy} onclick={() => pictureInput?.click()}>
						{profile.avatar ? 'Change' : 'Choose a picture'}
					</button>
					{#if profile.avatar}
						<button
							class="hh-button danger"
							type="button"
							disabled={profileBusy}
							onclick={() => saveProfile(() => listeners.removePicture())}
						>
							Remove
						</button>
					{/if}
				</div>
			</div>
		</section>
	{/if}

	<!-- Only where the music server can link at least one service: Navidrome,
	     with Last.fm or ListenBrainz turned on. -->
	{#await data.scrobblerLinks then links}
		{#if links && (links.lastfm.available || links.listenbrainz.available)}
			<section class="hh-card hh-glass group" id="scrobbling" hidden={shown !== 'account'}>
				<div class="group-head">
					<h2>Scrobbling</h2>
					<p class="hh-muted">
						Links your account on {data.serverLabel} to Last.fm or ListenBrainz. The music server sends
						what you play to them, from Heddohon or any other player, while “Report playback” above is on.
					</p>
				</div>

				{#if lastfmNotice}
					<p class="hh-muted note-inline" role="status">{lastfmNotice}</p>
				{/if}
				{#if form && 'scrobblerError' in form && form.scrobblerError}
					<p class="hh-muted note-inline" role="alert">{form.scrobblerError}</p>
				{/if}

				{#if links.lastfm.available}
					<div class="row switch">
						<span class="label">
							Last.fm
							<span class="hint hh-muted">
								{links.lastfm.linked
									? 'Linked.'
									: 'You approve access on last.fm, which brings you back here.'}
							</span>
						</span>
						{#if links.lastfm.linked}
							<form method="POST" action="?/unlinkScrobbler" use:enhance={refreshAfter('lastfm')}>
								<input type="hidden" name="service" value="lastfm" />
								<button class="hh-button danger" type="submit" disabled={linking === 'lastfm'}>
									{linking === 'lastfm' ? 'Unlinking…' : 'Unlink'}
								</button>
							</form>
						{:else}
							<form method="POST" action="?/startLastfm" use:enhance={toLastfm}>
								<button class="hh-button" type="submit" disabled={linking === 'lastfm'}>
									{linking === 'lastfm' ? 'Opening last.fm…' : 'Link on last.fm'}
								</button>
							</form>
						{/if}
					</div>
				{/if}

				{#if links.listenbrainz.available}
					<div class="row switch">
						<span class="label">
							ListenBrainz
							<span class="hint hh-muted">
								{links.listenbrainz.linked
									? 'Linked.'
									: 'Paste the user token from your ListenBrainz settings page.'}
							</span>
						</span>
						{#if links.listenbrainz.linked}
							<form method="POST" action="?/unlinkScrobbler" use:enhance={refreshAfter('listenbrainz')}>
								<input type="hidden" name="service" value="listenbrainz" />
								<button class="hh-button danger" type="submit" disabled={linking === 'listenbrainz'}>
									{linking === 'listenbrainz' ? 'Unlinking…' : 'Unlink'}
								</button>
							</form>
						{/if}
					</div>
					{#if !links.listenbrainz.linked}
						<form
							class="token-row"
							method="POST"
							action="?/linkListenBrainz"
							use:enhance={refreshAfter('listenbrainz')}
						>
							<input
								class="hh-input"
								type="password"
								name="token"
								required
								maxlength="128"
								autocomplete="off"
								spellcheck="false"
								aria-label="ListenBrainz user token"
								placeholder="ListenBrainz user token"
							/>
							<button class="hh-button" type="submit" disabled={linking === 'listenbrainz'}>
								{linking === 'listenbrainz' ? 'Linking…' : 'Link'}
							</button>
						</form>
					{/if}
				{/if}

				<p class="hh-muted note">
					Heddohon keeps neither. A ListenBrainz token is passed to the music server once, which checks
					it with ListenBrainz and stores it. Last.fm access is granted on last.fm to the music server.
					Unlinking here removes it from the music server.
				</p>
			</section>
		{/if}
	{/await}

	<!-- Only where the operator has turned one of them on; see `integrations.ts`. -->
	{#if data.integrations.offered.discord || data.integrations.offered.listenbrainz}
		<section class="hh-card hh-glass group" id="activity" hidden={shown !== 'account'}>
			<div class="group-head">
				<h2>Your plays, elsewhere</h2>
				<p class="hh-muted">
					Sends the title, artist and album of each track you play past half its length, or four
					minutes, from this server to what you link here, while “Report playback” under Playback is on.
					A Discord channel gets the cover too.
				</p>
			</div>

			{#if form && 'integrationError' in form && form.integrationError}
				<p class="hh-muted note-inline" role="alert">{form.integrationError}</p>
			{/if}

			{#if data.integrations.offered.discord}
				{@const name = data.integrations.linked.discord}
				<div class="row switch">
					<span class="label">
						Discord channel
						<span class="hint hh-muted">
							{name
								? `Posting each play through the webhook “${name}”.`
								: 'Paste a webhook address from the channel: Edit channel, Integrations, Webhooks.'}
						</span>
					</span>
					{#if name}
						<form method="POST" action="?/unlinkIntegration" use:enhance={integrationSubmit('discord')}>
							<input type="hidden" name="kind" value="discord" />
							<button class="hh-button danger" type="submit" disabled={integrating === 'discord'}>
								{integrating === 'discord' ? 'Unlinking…' : 'Unlink'}
							</button>
						</form>
					{/if}
				</div>
				{#if !name}
					<form class="token-row" method="POST" action="?/linkIntegration" use:enhance={integrationSubmit('discord')}>
						<input type="hidden" name="kind" value="discord" />
						<input
							class="hh-input"
							type="password"
							name="value"
							required
							maxlength="300"
							autocomplete="off"
							spellcheck="false"
							aria-label="Discord webhook address"
							placeholder="https://discord.com/api/webhooks/…"
						/>
						<button class="hh-button" type="submit" disabled={integrating === 'discord'}>
							{integrating === 'discord' ? 'Linking…' : 'Link'}
						</button>
					</form>
				{/if}
			{/if}

			{#if data.integrations.offered.listenbrainz}
				{@const user = data.integrations.linked.listenbrainz}
				<div class="row switch">
					<span class="label">
						ListenBrainz
						<span class="hint hh-muted">
							{user && data.integrations.viaMusicServer
								? `Scrobbling to ${user} from this server. ${data.serverLabel} links ListenBrainz itself, under Scrobbling: unlink it here to link it there.`
								: user
								? `Scrobbling to ${user}, and showing what is playing now.`
								: 'Paste the user token from your own ListenBrainz settings page. This server sends what you play here.'}
						</span>
					</span>
					{#if user}
						<form method="POST" action="?/unlinkIntegration" use:enhance={integrationSubmit('listenbrainz')}>
							<input type="hidden" name="kind" value="listenbrainz" />
							<button class="hh-button danger" type="submit" disabled={integrating === 'listenbrainz'}>
								{integrating === 'listenbrainz' ? 'Unlinking…' : 'Unlink'}
							</button>
						</form>
					{/if}
				</div>
				{#if !user}
					<form class="token-row" method="POST" action="?/linkIntegration" use:enhance={integrationSubmit('listenbrainz')}>
						<input type="hidden" name="kind" value="listenbrainz" />
						<input
							class="hh-input"
							type="password"
							name="value"
							required
							maxlength="128"
							autocomplete="off"
							spellcheck="false"
							aria-label="ListenBrainz user token"
							placeholder="ListenBrainz user token"
						/>
						<button class="hh-button" type="submit" disabled={integrating === 'listenbrainz'}>
							{integrating === 'listenbrainz' ? 'Linking…' : 'Link'}
						</button>
					</form>
				{/if}
			{/if}

			<p class="hh-muted note">
				A webhook address or a token is kept encrypted on this server and is not shown again. Unlinking
				removes it, and so does a changed password on {data.serverLabel || 'the music server'}.
			</p>
		</section>
	{/if}

	<!-- Kept while sharing is off if the account still has links, so they can
	     be withdrawn before the operator turns it back on. -->
	{#if data.sharing || data.shares.length > 0}
	<section class="hh-card hh-glass group" hidden={shown !== 'sharing'}>
		<div class="group-head">
			<h2>Shared links</h2>
			<p class="hh-muted">
				Links you have made to songs, albums and playlists. Anyone who has one can listen without an
				account, and it plays through your account on the music server.
			</p>
		</div>

		{#if !data.sharing}
			<p class="hh-muted note-inline">
				Sharing is turned off on this server, so these links do not open. They work again if it is
				turned back on, unless you withdraw them.
			</p>
		{/if}

		{#if form && 'shareError' in form && form.shareError}
			<p class="hh-muted note-inline" role="alert">{form.shareError}</p>
		{/if}

		{#if data.shares.length === 0}
			<p class="hh-muted empty">
				No live links. Use the share button in the player, on a track, or on an album or playlist
				page to make one.
			</p>
		{:else}
			<ul class="shares">
				{#each data.shares as share (share.id)}
					<li class="share">
						<span class="share-art">
							<Cover coverArt={share.item?.coverArt} size={96} alt="" radius="var(--r-sm)" />
						</span>
						<span class="share-text">
							<span class="share-title hh-truncate">
								{share.item?.title ?? `${share.kind === 'album' ? 'An album' : `A ${share.kind}`} your server no longer returns`}
							</span>
							<span class="share-sub hh-truncate hh-muted">
								{share.kind === 'song' ? 'Song' : share.kind === 'album' ? 'Album' : 'Playlist'} ·
								{#if share.item?.subtitle}{share.item.subtitle} · {/if}until
								<span class="hh-numeric">{shortDate(share.expiresAt)}</span>
							</span>
						</span>
						<form
							method="POST"
							action="?/revokeShare"
							use:enhance={() => {
								withdrawing = share.id;
								return async ({ update }) => {
									await update({ reset: false });
									await invalidateAll();
									withdrawing = null;
								};
							}}
						>
							<input type="hidden" name="id" value={share.id} />
							<button
								class="hh-button danger withdraw"
								type="submit"
								disabled={withdrawing === share.id}
								aria-label="Withdraw the link to {share.item?.title ?? `this ${share.kind}`}"
							>
								{withdrawing === share.id ? 'Withdrawing…' : 'Withdraw'}
							</button>
						</form>
					</li>
				{/each}
			</ul>
		{/if}

		<p class="hh-muted note">
			A link is shown once, when it is made. The server keeps a fingerprint of it rather than the
			link, so it cannot be shown again, and withdrawing it stops it working at once, including for
			anyone listening at the time. Links expire on their own after the period chosen when they were
			made. Signing out does not withdraw them.
		</p>

		{#if data.shares.length > 1}
			<form
				method="POST"
				action="?/revokeAllShares"
				use:enhance={() => {
					withdrawing = 'all';
					return async ({ update }) => {
						await update({ reset: false });
						await invalidateAll();
						withdrawing = null;
					};
				}}
			>
				<button class="hh-button danger" type="submit" disabled={withdrawing === 'all'}>
					<Icon name="trash" size={16} />
					{withdrawing === 'all' ? 'Withdrawing…' : `Withdraw all ${data.shares.length} links`}
				</button>
			</form>
		{/if}
	</section>
	{/if}

	<section class="hh-card hh-glass group" hidden={shown !== 'storage'}>
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
			may clear it: a clear costs each cover being fetched upstream once
			more.
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

		<!--
			Offered to an account the music server lists as an administrator, and
			refused to any other by the server: this has the music server render
			every cover in the library.
		-->
		{#if cache.limitBytes > 0 && data.isAdmin}
			<h3 class="subhead">Cache every cover</h3>
			<p class="hh-muted note">
				Reads the albums, artists and playlists of {data.serverLabel || 'the music server'} and
				stores each cover at the sizes the pages draw: 96, 384, 512 and 1024 pixels for an album,
				96 and 384 for an artist or a playlist. It runs on this server and carries on with the page
				closed. Covers already held are skipped, and it stops at the limit above. A track with
				artwork of its own is cached when it is played.
				{#if data.account.backend === 'jellyfin'}
					Jellyfin limits libraries per user, so these covers are held for your account only.
				{/if}
			</p>
			<label class="row switch">
				<span class="label">
					Keep it filled
					<span class="hint hh-muted">
						The server does this itself once a day, and after a restart, so covers added since
						are cached before anyone opens them. It uses your sign-in to
						{data.serverLabel || 'the music server'} as stored here, and stays on when you sign out.
					</span>
				</span>
				<input type="checkbox" bind:checked={daily} onchange={saveDaily} />
			</label>
			{#if filling}
				<div class="fill">
					<progress
						aria-label="Covers cached"
						max={fill.state === 'running' ? fill.total : undefined}
						value={fill.state === 'running' ? fill.done : undefined}
					></progress>
					<span class="hh-muted hh-numeric">
						{fill.state === 'listing'
							? 'Reading the library…'
							: `${fill.done.toLocaleString()} of ${fill.total.toLocaleString()}`}
					</span>
				</div>
				<button class="hh-button" type="button" onclick={() => fillRequest('DELETE')}>
					<Icon name="close" size={16} />
					Stop
				</button>
			{:else}
				<button class="hh-button" type="button" onclick={() => fillRequest('POST')}>
					<Icon name="download" size={16} />
					Cache every cover
				</button>
				{#if fillError}
					<p class="hh-muted note-inline" role="alert">{fillError}</p>
				{:else if fillSummary}
					<p class="hh-muted note-inline" role="status">{fillSummary}</p>
				{/if}
			{/if}
		{/if}
	</section>

	<section class="hh-card hh-glass group" hidden={shown !== 'history'}>
		<div class="group-head">
			<h2>Listening history</h2>
		</div>

		<p class="hh-muted note">
			Each track that plays past half its length, or four minutes, is noted on this server for
			<a href="/history">Recently played</a>, whether or not plays are reported to
			{data.serverLabel || 'the music server'}. How long it is kept is chosen below. It
			is yours alone: no other account can read it.
		</p>

		<label class="row">
			<span class="label">
				Keep
				<span class="hint hh-muted">
					How far back <a href="/stats?period=all">Your listening</a> can sum up. A shorter time drops
					older plays at the next play.
				</span>
			</span>
			<select
				class="hh-input"
				value={String(historyDays)}
				onchange={(event) => void keepHistory(Number(event.currentTarget.value))}
			>
				<option value="0">Forever</option>
				<option value="90">90 days, up to 5,000 plays</option>
				<option value="365">A year, up to 50,000 plays</option>
			</select>
		</label>

		{#if data.plugin}
			<label class="row switch">
				<span class="label">
					Plays from other apps
					<span class="hint hh-muted">
						{data.serverLabel || 'Navidrome'} tells this server of each track you finish in another app, and it
						is noted here with the rest.
						{#if !data.plugin.heard}
							Its Heddohon plugin has not been heard from in the last minute.
						{/if}
					</span>
				</span>
				<input
					type="checkbox"
					checked={historyOtherApps}
					onchange={(event) => void keepOtherApps(event.currentTarget.checked)}
				/>
			</label>
		{/if}

		<div class="history-links">
			<a class="hh-button" href="/history">
				<Icon name="history" size={16} />
				Recently played
			</a>
			<a class="hh-button" href="/stats">Your listening</a>
		</div>

		<h3 class="subhead">Import from {data.serverLabel || 'the music server'}</h3>
		{#if data.plugin?.heard}
			<p class="hh-muted note">
				Navidrome keeps every play in its scrobble history, and its Heddohon plugin sends it here. The import
				adds each play the history lacks, at its date, so the listening from before Heddohon and in other apps
				shows in the history and the stats. It starts within 15 seconds, and plays already here are skipped.
			</p>
		{:else}
			<p class="hh-muted note">
				{data.account.backend === 'jellyfin' ? 'Jellyfin' : 'Navidrome'} keeps the date each track was last
				played, and a count of plays without their dates. The import adds one play per track played, at that
				date, so the listening from before Heddohon shows in the history and the stats. Plays already here are
				skipped, and importing again adds only tracks played elsewhere since.
			</p>
		{/if}
		<form
			method="POST"
			action="?/importHistory"
			use:enhance={() => {
				importingHistory = true;
				return async ({ update }) => {
					await update({ reset: false });
					await invalidateAll();
					importingHistory = false;
				};
			}}
		>
			<button class="hh-button" type="submit" disabled={importingHistory}>
				<Icon name="history" size={16} />
				{importingHistory ? 'Importing…' : 'Import play history'}
			</button>
		</form>
		{#if form && 'historyImportPending' in form && form.historyImportPending}
			<p class="hh-muted note-inline" role="status">
				The import is still arriving from Navidrome. Its plays show in Recently played as they come in.
			</p>
		{:else if form && 'historyImportFull' in form && form.historyImportFull}
			<p class="hh-muted note-inline" role="status">
				{form.historyImported.imported === 0
					? `Nothing new to import. Navidrome keeps ${form.historyImported.found.toLocaleString()} play${form.historyImported.found === 1 ? '' : 's'}, each already in the history${historyDays === 0 ? '' : ', older than it keeps'} or of a track no longer in the library.`
					: `Imported ${form.historyImported.imported.toLocaleString()} of the ${form.historyImported.found.toLocaleString()} play${form.historyImported.found === 1 ? '' : 's'} Navidrome keeps.`}
			</p>
		{:else if form && 'historyImported' in form && form.historyImported}
			<p class="hh-muted note-inline" role="status">
				{form.historyImported.imported === 0
					? `Nothing new to import. ${form.historyImported.found.toLocaleString()} played track${form.historyImported.found === 1 ? ' was' : 's were'} already in the history${historyDays === 0 ? '' : ' or older than it keeps'}.`
					: `Imported ${form.historyImported.imported.toLocaleString()} play${form.historyImported.imported === 1 ? '' : 's'} of ${form.historyImported.found.toLocaleString()} played track${form.historyImported.found === 1 ? '' : 's'}.`}
			</p>
		{:else if form && 'historyImportError' in form && form.historyImportError}
			<p class="hh-muted note-inline" role="alert">{form.historyImportError}</p>
		{/if}

		<form
			method="POST"
			action="?/clearHistory"
			use:enhance={() => {
				clearingHistory = true;
				return async ({ update }) => {
					await update({ reset: false });
					await invalidateAll();
					clearingHistory = false;
				};
			}}
		>
			<button class="hh-button" type="submit" disabled={clearingHistory || data.historyCount === 0}>
				<Icon name="trash" size={16} />
				{clearingHistory
					? 'Clearing…'
					: data.historyCount === 0
						? 'No listening history'
						: `Clear listening history (${data.historyCount.toLocaleString()})`}
			</button>
		</form>
	</section>

	<footer class="about">
		<span>{data.appName}</span>
		<span class="hh-numeric">v{data.appVersion}</span>
	</footer>
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

	/* The same tabs as the favourites page. */
	.tabs {
		display: flex;
		gap: var(--space-1);
		border-bottom: 1px solid var(--border-hairline);
		padding-bottom: var(--space-2);
		overflow-x: auto;
		/* Five tabs are wider than a phone; the row scrolls sideways there. */
		scrollbar-width: none;
	}

	.tab {
		padding: 0.35rem 0.8rem;
		border-radius: var(--r-pill);
		color: var(--text-muted);
		font-size: 0.875rem;
		font-weight: 500;
		white-space: nowrap;
		transition:
			background var(--transition),
			color var(--transition);
	}

	.tab:hover,
	.tab.active {
		color: var(--glow-color);
		text-shadow: var(--glow-text);
	}

	/* `.group` and `form` set `display`, which the `hidden` attribute alone does not win against. */
	[hidden] {
		display: none !important;
	}

	.later {
		display: grid;
		justify-items: end;
		font-size: 0.75rem;
		text-align: right;
		max-width: 16rem;
	}

	.lede {
		margin: var(--space-2) 0 0;
		max-width: 54ch;
	}

	/* Fades in. Opacity only, on the notice itself: it is a pane of glass, and
	   transforms are kept off glass (see the design notes in the wiki). */
	@keyframes saved-in {
		from {
			opacity: 0;
		}
	}

	.saved {
		margin: 0;
		animation: saved-in var(--dur-state) var(--ease-out);
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

	.font-sample {
		margin-top: var(--space-1);
		font-family: var(--font-display);
		font-weight: 700;
		font-size: 1.125rem;
		letter-spacing: -0.02em;
		color: var(--text-strong);
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

	/* Ten upright sliders, the way an equaliser is read: low bands on the left. */
	.eq {
		display: grid;
		grid-template-columns: repeat(10, minmax(0, 1fr));
		gap: var(--space-1);
	}

	.install-ways {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
	}

	.install-ways a {
		text-decoration: none;
	}

	.correction {
		display: grid;
		gap: var(--space-3);
	}

	.chosen {
		margin: 0;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-3);
		font-size: 0.875rem;
	}

	.chosen > span {
		display: grid;
		gap: 0.15rem;
		min-width: 0;
	}

	.correction-actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
	}

	.correction-actions input[type='search'] {
		flex: 1 1 14rem;
		min-width: 0;
	}

	.import {
		cursor: pointer;
	}

	/* The file input is hidden, so its focus is drawn on the label. */
	.import:has(:focus-visible) {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}

	/* One measurement per row: the same headphone is listed once per measurer. */
	.matches {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		max-height: 16rem;
		overflow-y: auto;
		border: 1px solid var(--border-hairline);
		border-radius: var(--r-sm);
	}

	.matches button {
		width: 100%;
		display: flex;
		/* On a phone the measurer drops under the name. */
		flex-wrap: wrap;
		justify-content: space-between;
		gap: var(--space-3);
		padding: var(--space-2) var(--space-3);
		text-align: left;
		font-size: 0.875rem;
		color: var(--text-default);
	}

	.matches button:hover,
	.matches button:focus-visible {
		background: color-mix(in srgb, var(--accent) 10%, transparent);
	}

	.matches li + li {
		border-top: 1px solid var(--border-hairline);
	}

	/* Greyed while a headphone correction is in use; the controls are disabled as well. */
	.eq.set-aside,
	.row.set-aside select {
		opacity: 0.4;
	}

	.band {
		display: grid;
		justify-items: center;
		gap: var(--space-1);
		font-size: 0.75rem;
		color: var(--text-muted);
	}

	.band input[type='range'] {
		writing-mode: vertical-lr;
		direction: rtl;
		height: 8rem;
		width: 1.5rem;
		accent-color: var(--accent);
	}

	.band .gain {
		color: var(--text-strong);
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

	/* A second line under a fact: it is a sentence, and the eyebrow treatment
	   set it in tracked uppercase that wrapped. */
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

	.fill {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		font-size: 0.875rem;
	}

	.fill progress {
		flex: 1;
		max-width: 24rem;
		height: 0.375rem;
		accent-color: var(--accent);
	}

	.danger:hover {
		color: var(--danger);
		border-color: var(--danger);
	}

	.about {
		display: flex;
		justify-content: center;
		gap: var(--space-2);
		padding: var(--space-2) 0 var(--space-4);
		font-size: 0.75rem;
		color: var(--text-faint);
	}

	.empty,
	.note-inline {
		margin: 0;
		font-size: 0.875rem;
	}

	.shares {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: var(--space-2);
	}

	.share {
		display: grid;
		grid-template-columns: 2.5rem minmax(0, 1fr) auto;
		align-items: center;
		gap: var(--space-3);
	}

	/* The form around the button is a grid item here, not a settings block. */
	.share form,
	.row form {
		display: block;
	}

	.token-row {
		display: flex;
		gap: var(--space-2);
	}

	.token-row .hh-input {
		flex: 1;
		min-width: 0;
	}

	.share-text {
		display: grid;
		min-width: 0;
	}

	.share-title {
		color: var(--text-strong);
		font-weight: 500;
		font-size: 0.9375rem;
	}

	.share-sub {
		font-size: 0.8125rem;
	}

	.withdraw {
		padding: 0.4rem 0.8rem;
		font-size: 0.8125rem;
	}

	.withdraw:disabled {
		opacity: 0.6;
		cursor: progress;
	}

	/* More specific than `.row form` above, which makes a form a block. */
	.row .profile-name,
	.profile-picture {
		display: flex;
		align-items: center;
		gap: var(--space-2);
	}

	.profile-name .hh-input {
		flex: 1;
		min-width: 0;
	}

	.profile-picture {
		flex-wrap: wrap;
		gap: var(--space-3);
	}

	.sessions-head {
		display: flex;
		align-items: baseline;
		gap: var(--space-2);
	}

	.history-links {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
	}

	.subhead,
	.sessions-head h3 {
		margin: 0;
		font-size: 0.9375rem;
		font-weight: 600;
	}

	.session {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		align-items: center;
		gap: var(--space-3);
		min-height: 2.75rem;
	}

	.session form {
		display: contents;
	}

	.this {
		margin-left: var(--space-2);
		color: var(--accent);
	}

	.session-actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
	}

	@media (max-width: 40rem) {
		/* Less padding on a phone: at 1.5rem each side, inside the page's own, a
		   row had 303px of a 393px screen. */
		.group {
			padding: var(--space-4);
		}

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
