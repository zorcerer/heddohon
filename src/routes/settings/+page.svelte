<script lang="ts">
	import { enhance } from '$app/forms';
	import { invalidateAll, replaceState } from '$app/navigation';
	import { page } from '$app/state';
	import type { SubmitFunction } from '@sveltejs/kit';
	import { untrack } from 'svelte';
	import Cover from '$lib/components/Cover.svelte';
	import Avatar from '$lib/components/Avatar.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import SecuritySettings from '$lib/components/SecuritySettings.svelte';
	import { avatarUrl, listeners } from '$lib/client/listeners.svelte';
	import { player } from '$lib/client/player.svelte';
	import { EQ_FREQUENCIES, EQ_RANGE_DB } from '$lib/client/audiochain';
	import { EQ_PRESETS, processing } from '$lib/client/processing.svelte';
	import { APP_KINDS, APP_RELEASES, installer, INSTALL_STEPS } from '$lib/client/install.svelte';
	import { formatBytes, formatLongDuration } from '$lib/client/format';
	import type { ReportStatus } from '$lib/server/libraryreport';

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

	let backingUp = $state(false);
	let backupError = $state('');
	let backupDone = $state('');

	/**
	 * Asks for the database as a ZIP (`/api/backup`) and hands it to the
	 * browser as a download. Fetched, not a form posted to the address: a
	 * refusal then shows here, and the page with the music playing stays.
	 */
	async function downloadBackup() {
		backingUp = true;
		backupError = '';
		backupDone = '';
		try {
			const response = await fetch('/api/backup', { method: 'POST' });
			if (!response.ok) {
				const body = await response.json().catch(() => null);
				backupError = body?.message ?? 'The server did not answer. Try again.';
				return;
			}
			const name =
				/filename="([^"]+)"/.exec(response.headers.get('content-disposition') ?? '')?.[1] ?? 'heddohon-backup.zip';
			const archive = await response.blob();
			const url = URL.createObjectURL(archive);
			const link = document.createElement('a');
			link.href = url;
			link.download = name;
			document.body.append(link);
			link.click();
			link.remove();
			// Held until the browser has taken the download up.
			setTimeout(() => URL.revokeObjectURL(url), 60_000);
			backupDone = `${name}, ${formatSize(archive.size)}`;
		} catch {
			backupError = 'The server did not answer. Try again.';
		} finally {
			backingUp = false;
		}
	}
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
	/*
	 * The history as a file. The dates are days in this browser's time zone,
	 * the start from its first moment and the end to its last, sent as the
	 * epoch millis the server reads (`/api/history/export`).
	 */
	let exportFormat = $state<'csv' | 'json'>('csv');
	let exportFrom = $state('');
	let exportTo = $state('');
	const exportRange = $derived.by(() => {
		const from = exportFrom ? new Date(`${exportFrom}T00:00`).getTime() : null;
		let to: number | null = null;
		if (exportTo) {
			const end = new Date(`${exportTo}T00:00`);
			end.setDate(end.getDate() + 1);
			to = end.getTime();
		}
		return { from, to, wrong: from !== null && to !== null && from >= to };
	});
	const exportHref = $derived.by(() => {
		const query = new URLSearchParams({ format: exportFormat });
		if (exportRange.from !== null) query.set('from', String(exportRange.from));
		if (exportRange.to !== null) query.set('to', String(exportRange.to));
		return `/api/history/export?${query}`;
	});
	/** Whether the home page has the "New releases" shelf, saved as it is changed. */
	let newReleases = $state(untrack(() => data.settings.newReleases));
	async function showNewReleases(on: boolean) {
		newReleases = on;
		await fetch('/api/settings', {
			method: 'PATCH',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ newReleases: on })
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
		{ id: 'security', label: 'Security' },
		{ id: 'ai', label: 'AI' },
		{ id: 'sharing', label: 'Shared links' },
		{ id: 'storage', label: 'Cover cache' },
		{ id: 'features', label: 'Features' }
	] as const;
	type Tab = (typeof TABS)[number]['id'];

	const sharingShown = $derived(data.sharing || data.shares.length > 0);
	const tabs = $derived(
		TABS.filter(
			(entry) =>
				(entry.id !== 'sharing' || sharingShown) &&
				(entry.id !== 'ai' || data.mcp !== null) &&
				(entry.id !== 'features' || data.features !== null)
		)
	);

	function tabFrom(url: URL): Tab {
		const requested = url.searchParams.get('tab');
		if (TABS.some((entry) => entry.id === requested)) return requested as Tab;
		// The way back from last.fm lands on the section that started it.
		return url.searchParams.has('lastfm') ? 'account' : 'appearance';
	}

	let tab = $state<Tab>(untrack(() => tabFrom(page.url)));
	// A link to a tab that is not offered: sharing off with no links left, or AI with nothing to show.
	const shown = $derived<Tab>(
		(tab === 'sharing' && !sharingShown) || (tab === 'ai' && data.mcp === null) || (tab === 'features' && data.features === null)
			? 'appearance'
			: tab
	);

	// On a phone the row scrolls sideways; the chosen tab is brought into it.
	let tabRow = $state<HTMLElement | null>(null);
	$effect(() => {
		void shown;
		tabRow?.querySelector<HTMLElement>('.tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
	});

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


	/*
	 * The library report: started here, made by the server (`libraryreport.ts`).
	 * Asked for again every 1.5 seconds while it is made and the Cover cache
	 * tab is showing, as the cover fill is.
	 */
	let report = $state<ReportStatus | null>(untrack(() => data.libraryReport));
	let reportError = $state('');

	async function reportRequest(method: 'GET' | 'POST') {
		const response = await fetch('/api/library-report', { method }).catch(() => null);
		if (!response?.ok) {
			const body = (await response?.json().catch(() => null)) as { message?: string } | null;
			reportError = body?.message ?? 'The report could not be asked for.';
			return;
		}
		reportError = '';
		report = await response.json();
	}

	$effect(() => {
		if (report?.state !== 'running' || shown !== 'storage') return;
		const timer = setInterval(() => void reportRequest('GET'), 1500);
		return () => clearInterval(timer);
	});

	const percent = (part: number, whole: number) => (whole > 0 ? `${Math.round((part / whole) * 100)}%` : '0%');
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

	/** The MCP token form waiting on the server: `make`, or the id of one being withdrawn. */
	let mcpBusy = $state<string | null>(null);
	let featuresBusy = $state(false);

	function mcpSubmit(busy: string): SubmitFunction {
		return () => {
			mcpBusy = busy;
			return async ({ update }) => {
				await update({ reset: true });
				await invalidateAll();
				mcpBusy = null;
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
</script>

<svelte:head>
	<title>Settings · Heddohon</title>
</svelte:head>

<div class="page">
	<header>
		<h1>Settings</h1>
	</header>

	<nav class="tabs" aria-label="Settings" bind:this={tabRow}>
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
			</div>

			<label class="row">
				<span class="label">Theme</span>
				<select class="hh-input control" name="theme" bind:value={settings.theme}>
					<option value="terminal">Terminal</option>
					<option value="dark">Liquid</option>
					<option value="light">Paper</option>
					<option value="phosphor">Phosphor</option>
				</select>
			</label>

			<!-- Terminal's own four, of which Phosphor has the accent. Liquid and
			     Paper take every colour from the artwork, have no grid, and fade
			     the player's artwork one way. -->
			{#if settings.theme === 'terminal'}
				<label class="row">
					<span class="label">Colour scheme</span>
					<select class="hh-input control" name="scheme" bind:value={settings.scheme}>
						<option value="heddohon">Heddohon</option>
						<option value="nord">Nord</option>
						<option value="dracula">Dracula</option>
						<option value="gruvbox">Gruvbox</option>
						<option value="catppuccin">Catppuccin</option>
						<option value="tokyo-night">Tokyo Night</option>
						<option value="solarized">Solarized</option>
						<option value="one-dark">One Dark</option>
						<option value="monokai">Monokai</option>
						<option value="everforest">Everforest</option>
						{#each data.customSchemes as scheme (scheme.id)}
							<option value={scheme.id}>{scheme.name}</option>
						{/each}
					</select>
				</label>
			{/if}

			{#if settings.theme === 'terminal' || settings.theme === 'phosphor'}
				<label class="row">
					<span class="label">Accent</span>
					<select class="hh-input control" name="accent" bind:value={settings.accent}>
						<option value="artwork">From the artwork</option>
						<option value="green">Green</option>
						<option value="amber">Amber</option>
						<option value="cyan">Cyan</option>
						<option value="violet">Violet</option>
						<option value="rose">Rose</option>
						<option value="white">White</option>
					</select>
				</label>
			{/if}

			{#if settings.theme === 'terminal'}
				<label class="row">
					<span class="label">Background dots</span>
					<select class="hh-input control" name="dots" bind:value={settings.dots}>
						<option value="off">Off</option>
						<option value="faint">Faint</option>
						<option value="medium">Medium</option>
						<option value="strong">Strong</option>
					</select>
				</label>

				<label class="row">
					<span class="label">Player artwork</span>
					<select class="hh-input control" name="playerArt" bind:value={settings.playerArt}>
						<option value="dither">Dots</option>
						<option value="plain">Plain</option>
						<option value="scanlines">Scanlines</option>
						<option value="duotone">Duotone</option>
					</select>
				</label>
			{/if}

			<label class="row">
				<span class="label">Interface scale</span>
				<select class="hh-input control" name="uiScale" bind:value={settings.uiScale}>
					<option value="100">100%</option>
					<option value="110">110%</option>
					<option value="125">125%</option>
					<option value="150">150%</option>
					<option value="175">175%</option>
				</select>
			</label>

			<label class="row">
				<span class="label">Font</span>
				<!-- In the face chosen, before it is saved; see `[data-font]` in app.css. -->
				<select class="hh-input control font" name="font" data-font={settings.font} bind:value={settings.font}>
					<option value="manrope">
						{settings.theme === 'terminal' ? 'JetBrains Mono' : settings.theme === 'phosphor' ? 'Barlow' : 'Manrope'}
					</option>
					<option value="inter">Inter</option>
					<option value="geist">Geist</option>
					<option value="plex">IBM Plex Sans</option>
					<option value="atkinson">Atkinson Hyperlegible</option>
					<option value="system">System</option>
				</select>
			</label>

			<label class="row">
				<span class="label">Grid density</span>
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
				<span class="label">Show quality badge</span>
				<input type="checkbox" name="showQualityBadge" bind:checked={settings.showQualityBadge} />
			</label>

			<!-- Terminal and Phosphor have no glass and no room behind it for a glow. -->
			{#if settings.theme !== 'terminal' && settings.theme !== 'phosphor'}
				<label class="row">
					<span class="label">Aurora</span>
					<select class="hh-input control" name="aurora" bind:value={settings.aurora}>
						<option value="moving">Moving</option>
						<option value="still">Still</option>
						<option value="off">Off</option>
					</select>
				</label>
			{/if}
		</section>

		<section class="hh-card hh-glass group" hidden={shown !== 'playback'}>
			<div class="group-head">
				<h2>Playback</h2>
			</div>

			<label class="row">
				<span class="label">Track transitions</span>
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
							<span class="hint hh-muted">Not on this device: it changes tracks with a tight handoff.</span>
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
					<span class="label">Crossfade within an album</span>
					<input type="checkbox" name="crossfadeWithinAlbum" bind:checked={settings.crossfadeWithinAlbum} />
				</label>
			{:else}
				<input type="hidden" name="crossfadeSeconds" value={settings.crossfadeSeconds} />
				{#if settings.crossfadeWithinAlbum}
					<input type="hidden" name="crossfadeWithinAlbum" value="on" />
				{/if}
			{/if}

			<label class="row switch">
				<span class="label">Preload the next track</span>
				<input type="checkbox" name="preloadNext" bind:checked={settings.preloadNext} />
			</label>

			<label class="row switch">
				<span class="label">Volume normalisation</span>
				<input type="checkbox" name="normalizeVolume" bind:checked={settings.normalizeVolume} />
			</label>

			<label class="row switch">
				<span class="label">
					Report playback to {data.serverLabel}
				</span>
				<input type="checkbox" name="reportPlayback" bind:checked={settings.reportPlayback} />
			</label>
		</section>

		<section class="hh-card hh-glass group" hidden={shown !== 'playback'}>
			<div class="group-head">
				<h2>Transcoding</h2>
			</div>

			<label class="row switch">
				<span class="label">Transcode audio</span>
				<input type="checkbox" name="transcode" bind:checked={settings.transcode} />
			</label>

			<label class="row">
				<span class="label">Codec</span>
				<select class="hh-input control" name="transcodeCodec" bind:value={settings.transcodeCodec}>
					<option value="mp3">MP3</option>
					<option value="opus">Opus</option>
					<option value="aac">AAC</option>
				</select>
			</label>

			<label class="row">
				<span class="label">Bitrate</span>
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

	<!--
		Kept in this browser, for the headphones or speakers it plays through, and
		applied as they are changed. Below the save button, outside its form, so
		where it stands says it is not saved with the rest. Its inputs have no
		names either way.
	-->
	<section class="hh-card hh-glass group" id="this-browser" hidden={shown !== 'playback'}>
		<div class="group-head">
			<h2>This browser</h2>
		</div>

		<label class="row switch">
			<span class="label">
				Process audio
				{#if player.processing && !processing.enabled}
					<span class="hint hh-muted">Switched off; this page keeps processing until it is loaded again.</span>
				{/if}
			</span>
			<input
				type="checkbox"
				checked={processing.enabled}
				onchange={(event) => processing.setEnabled(event.currentTarget.checked)}
			/>
		</label>

		{#if processing.enabled}
			<label class="row switch">
				<span class="label">Visualiser</span>
				<input
					type="checkbox"
					checked={processing.visualiser}
					onchange={(event) => processing.setVisualiser(event.currentTarget.checked)}
				/>
			</label>

			<label class="row" class:set-aside={processing.bandsOff}>
				<span class="label">Equaliser</span>
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
						<!-- Enter in a search field would submit a form around it. -->
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

	<!-- Outside the save form: nothing here is posted with it. -->
	<section class="hh-card hh-glass group" id="install" hidden={shown !== 'appearance'}>
		<div class="group-head">
			<h2>Install the app</h2>
		</div>

		{#if installer.installed}
			<p class="note">You are using the app.</p>
		{:else if appKind}
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
			<p class="hh-muted note-inline">This browser does not install web apps.</p>
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
				<dd>{data.serverLabel}</dd>
			</div>
			<div>
				<dt>This session expires</dt>
				<dd>{expiry}</dd>
			</div>
		</dl>

		<!--
			Every browser signed in to this account, the most recently used first,
			with this one marked. Another can be signed out from here. This one
			signs out with the button below, which also clears its cookie.
		-->
		<h3 class="subhead">Signed in on</h3>

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
						     not work, so this says why there is none. -->
						<span class="hh-muted later">Signed in after this browser.</span>
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

	<!-- The account's second factors; see `twofactor.ts`. Mounted while shown,
	     since it reads them from the server when it starts. -->
	<section class="hh-card hh-glass group" id="security" hidden={shown !== 'security'}>
		<div class="group-head">
			<h2>Two-step sign-in</h2>
		</div>
		{#if shown === 'security'}
			<SecuritySettings serverLabel={data.serverLabel} admin={data.twoFactorAdmin} />
		{/if}
	</section>

	<!-- Only where the operator has left it on; see `HEDDOHON_LISTENERS`. -->
	{#if profile}
		<section class="hh-card hh-glass group" id="listening" hidden={shown !== 'account'}>
			<div class="group-head">
				<h2>Listening now</h2>
			</div>

			{#if listeners.error}
				<p class="hh-muted note-inline" role="alert">{listeners.error}</p>
			{/if}

			<label class="row switch">
				<span class="label">Show others what I play</span>
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
					<span class="label">Include what I play in other apps</span>
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
				<span class="label">Picture</span>
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
				</div>

				{#if lastfmNotice}
					<p class="hh-muted note-inline" role="status">{lastfmNotice}</p>
				{/if}
				{#if form && 'scrobblerError' in form && form.scrobblerError}
					<p class="hh-muted note-inline" role="alert">{form.scrobblerError}</p>
				{/if}

				{#if links.lastfm.available}
					<div class="row switch">
						<span class="label">Last.fm</span>
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
						<span class="label">ListenBrainz</span>
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

			</section>
		{/if}
	{/await}

	<!-- Only where the operator has turned one of them on; see `integrations.ts`. -->
	{#if data.integrations.offered.discord || data.integrations.offered.listenbrainz}
		<section class="hh-card hh-glass group" id="activity" hidden={shown !== 'account'}>
			<div class="group-head">
				<h2>Your plays, elsewhere</h2>
			</div>

			{#if form && 'integrationError' in form && form.integrationError}
				<p class="hh-muted note-inline" role="alert">{form.integrationError}</p>
			{/if}

			{#if data.integrations.offered.discord}
				{@const name = data.integrations.linked.discord}
				<div class="row switch">
					<span class="label">
						Discord channel
						{#if name}<span class="hint hh-muted">{name}</span>{/if}
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
						{#if user}<span class="hint hh-muted">{user}</span>{/if}
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

		</section>
	{/if}

	{#if data.nowPlaying}
		{@const madeLink = form && 'nowPlayingToken' in form ? form.nowPlayingToken : null}
		<section class="hh-card hh-glass group" id="now-playing" hidden={shown !== 'account'}>
			<div class="group-head">
				<h2>Now-playing link</h2>
			</div>
			{#if madeLink}
				<div class="made-token" role="status">
					<p>Shown this once.</p>
					<input
						class="hh-input secret"
						readonly
						value={`${page.url.origin}/now/${madeLink}`}
						aria-label="The now-playing page"
						onfocus={(event) => event.currentTarget.select()}
					/>
					<input
						class="hh-input secret"
						readonly
						value={`${page.url.origin}/api/now-playing/${madeLink}`}
						aria-label="The now-playing JSON"
						onfocus={(event) => event.currentTarget.select()}
					/>
				</div>
			{:else if data.nowPlaying.madeAt}
				<p class="hh-muted note-inline">Link made {new Date(data.nowPlaying.madeAt).toLocaleDateString()}.</p>
			{/if}
			<div class="history-links">
				<form method="POST" action="?/makeNowPlaying" use:enhance={() => async ({ update }) => update({ reset: false })}>
					<button class="hh-button" type="submit">
						<Icon name="link" size={16} />
						{data.nowPlaying.madeAt || madeLink ? 'Make a new link' : 'Make a link'}
					</button>
				</form>
				{#if data.nowPlaying.madeAt || madeLink}
					<form method="POST" action="?/withdrawNowPlaying" use:enhance={() => async ({ update }) => update({ reset: false })}>
						<button class="hh-button danger" type="submit">Withdraw the link</button>
					</form>
				{/if}
			</div>
			{#if form && 'nowPlayingError' in form && form.nowPlayingError}
				<p class="hh-muted note-inline" role="alert">{form.nowPlayingError}</p>
			{:else if form && 'nowPlayingWithdrawn' in form && form.nowPlayingWithdrawn}
				<p class="hh-muted note-inline" role="status">Withdrawn. The link no longer works.</p>
			{/if}
		</section>
	{/if}

	{#if data.mcp}
		{@const mcp = data.mcp}
		{@const made = form && 'mcpToken' in form ? form.mcpToken : null}
		{#if mcp.admin}
			<section class="hh-card hh-glass group" id="assistants-server" hidden={shown !== 'ai'}>
				<div class="group-head">
					<h2>AI assistants on this server</h2>
				</div>
				<form
					method="POST"
					action="?/saveMcp"
					use:enhance={() => {
						mcpBusy = 'switch';
						return async ({ update }) => {
							await update({ reset: false });
							await invalidateAll();
							mcpBusy = null;
						};
					}}
				>
					<label class="row switch">
						<span class="label">
							Allow AI assistants (MCP)
							{#if mcp.admin.fromEnvironment}
								<span class="hint hh-muted">Set by HEDDOHON_MCP in the environment.</span>
							{/if}
						</span>
						<input type="checkbox" name="mcp" checked={mcp.on} disabled={mcp.admin.fromEnvironment} />
					</label>
					{#if form && 'mcpSwitchError' in form && form.mcpSwitchError}
						<p class="hh-muted note-inline" role="alert">{form.mcpSwitchError}</p>
					{:else if form && 'mcpSaved' in form && form.mcpSaved}
						<p class="hh-muted note-inline" role="status">Saved.</p>
					{/if}
					{#if !mcp.admin.fromEnvironment}
						<button class="hh-button" type="submit" disabled={mcpBusy === 'switch'}>
							{mcpBusy === 'switch' ? 'Saving…' : 'Save'}
						</button>
					{/if}
				</form>
			</section>
		{/if}

		{#if mcp.on || mcp.tokens.length > 0}
			<section class="hh-card hh-glass group" id="assistants" hidden={shown !== 'ai'}>
				<div class="group-head">
					<h2>AI assistants</h2>
				</div>
	
				{#if !mcp.on}
					<p class="hh-muted note-inline">
						AI assistants are turned off on this server.
					</p>
				{/if}
	
				{#if form && 'mcpError' in form && form.mcpError}
					<p class="hh-muted note-inline" role="alert">{form.mcpError}</p>
				{/if}
	
				{#if made}
					<div class="made-token" role="status">
						<p>“{made.name}”, shown this once.</p>
						<input
							class="hh-input secret"
							readonly
							value={made.token}
							aria-label="The new token"
							onfocus={(event) => event.currentTarget.select()}
						/>
						<textarea
							class="hh-input secret"
							readonly
							rows="3"
							aria-label="The command that adds it to Claude Code"
							onfocus={(event) => event.currentTarget.select()}
							value={`claude mcp add --transport http heddohon ${mcp.endpoint} --header "Authorization: Bearer ${made.token}"`}
						></textarea>
						<!-- The address, for a client other than Claude Code. -->
						<input
							class="hh-input secret"
							readonly
							value={mcp.endpoint}
							aria-label="The endpoint"
							onfocus={(event) => event.currentTarget.select()}
						/>
					</div>
				{/if}
	
				{#if mcp.on && mcp.tokens.length < mcp.max}
					<form method="POST" action="?/makeMcpToken" use:enhance={mcpSubmit('make')}>
						<div class="token-row">
							<input
								class="hh-input"
								name="name"
								maxlength={mcp.maxName}
								autocomplete="off"
								aria-label="What the token is for"
								placeholder="Claude Code on my laptop"
							/>
							<button class="hh-button" type="submit" disabled={mcpBusy === 'make'}>
								{mcpBusy === 'make' ? 'Making…' : 'Make a token'}
							</button>
						</div>
						<label class="row switch">
							<span class="label">May change the library</span>
							<input type="checkbox" name="writes" checked />
						</label>
					</form>
				{/if}
	
				{#if mcp.tokens.length > 0}
					<ul class="shares">
						{#each mcp.tokens as token (token.id)}
							<li class="share assistant">
								<span class="share-text">
									<span class="share-title hh-truncate">{token.name}</span>
									<span class="share-sub hh-truncate hh-muted">
										{token.writes ? 'Reads and changes' : 'Reads only'} · made
										<span class="hh-numeric">{shortDate(token.createdAt)}</span> ·
										{#if token.lastUsedAt}last used <span class="hh-numeric">{shortDate(token.lastUsedAt)}</span>{:else}not used yet{/if}
									</span>
								</span>
								<form method="POST" action="?/withdrawMcpToken" use:enhance={mcpSubmit(token.id)}>
									<input type="hidden" name="id" value={token.id} />
									<button
										class="hh-button danger withdraw"
										type="submit"
										disabled={mcpBusy === token.id}
										aria-label="Withdraw the token {token.name}"
									>
										{mcpBusy === token.id ? 'Withdrawing…' : 'Withdraw'}
									</button>
								</form>
							</li>
						{/each}
					</ul>
				{/if}
	
			</section>
		{/if}
	{/if}

	<!-- Kept while sharing is off if the account still has links, so they can
	     be withdrawn before the operator turns it back on. -->
	{#if data.sharing || data.shares.length > 0}
	<section class="hh-card hh-glass group" hidden={shown !== 'sharing'}>
		<div class="group-head">
			<h2>Shared links</h2>
		</div>

		{#if !data.sharing}
			<p class="hh-muted note-inline">
				Sharing is turned off on this server.
			</p>
		{/if}

		{#if form && 'shareError' in form && form.shareError}
			<p class="hh-muted note-inline" role="alert">{form.shareError}</p>
		{/if}

		{#if data.shares.length === 0}
			<p class="hh-muted empty">No live links.</p>
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
				<dd>Everyone signed in to {data.serverLabel || 'the music server'}</dd>
			</div>
		</dl>

		<!--
			The cache is keyed by the music server's cover id, with no account in
			the key, so there is one copy of each cover for everyone. Any account
			may clear it: a clear costs each cover being fetched upstream once
			more.
		-->

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
			<label class="row switch">
				<span class="label">Keep it filled</span>
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

	<!--
		Offered to an account the music server lists as an administrator, and
		refused to any other by the server: the archive holds every account's
		rows.
	-->
	{#if data.isAdmin}
		<section class="hh-card hh-glass group" id="backup" hidden={shown !== 'storage'}>
			<div class="group-head">
				<h2>Database backup</h2>
			</div>

			<p class="hh-muted note-inline">Opens only with this server's HEDDOHON_SECRET, which is not in it.</p>
			<button class="hh-button" type="button" onclick={downloadBackup} disabled={backingUp}>
				<Icon name="download" size={16} />
				{backingUp ? 'Making the backup…' : 'Download a backup'}
			</button>
			{#if backupError}
				<p class="hh-muted note-inline" role="alert">{backupError}</p>
			{:else if backupDone}
				<p class="hh-muted note-inline" role="status">{backupDone}</p>
			{/if}
		</section>
	{/if}

	{#if report}
		<section class="hh-card hh-glass group" id="library-report" hidden={shown !== 'storage'}>
			<div class="group-head">
				<h2>Library report</h2>
			</div>

			{#if report.state === 'running'}
				<p class="hh-muted note-inline" role="status">Reading the library: {report.tracks.toLocaleString()} tracks so far.</p>
			{:else}
				<button class="hh-button" type="button" onclick={() => reportRequest('POST')}>
					{report.state === 'done' ? 'Make it again' : 'Make a report'}
				</button>
			{/if}
			{#if reportError}
				<p class="hh-muted note-inline" role="alert">{reportError}</p>
			{:else if report.state === 'failed'}
				<p class="hh-muted note-inline" role="alert">{report.detail}</p>
			{/if}

			{#if report.state === 'done'}
				{@const r = report.report}
				{#if r.tracks === 0}
					<p class="hh-muted note-inline">The music server listed no tracks.</p>
				{:else}
					<dl class="report-figures hh-numeric">
						<div><dt>Tracks</dt><dd>{r.tracks.toLocaleString()}</dd></div>
						<div><dt>Albums</dt><dd>{r.albums.toLocaleString()}</dd></div>
						<div><dt>Artists</dt><dd>{r.artists.toLocaleString()}</dd></div>
						<div><dt>Length</dt><dd>{formatLongDuration(r.seconds)}</dd></div>
						<div><dt>Size</dt><dd>{formatBytes(r.bytes)}</dd></div>
						<div><dt>Lossless</dt><dd>{percent(r.lossless, r.tracks)}</dd></div>
						<div><dt>Hi-res</dt><dd>{percent(r.hiRes, r.tracks)}</dd></div>
					</dl>

					<div class="report-tables">
						<table>
							<caption>Formats</caption>
							<thead><tr><th scope="col">Format</th><th scope="col">Tracks</th><th scope="col">Size</th></tr></thead>
							<tbody>
								{#each r.formats as entry (entry.format)}
									<tr><td>{entry.format}</td><td class="hh-numeric">{entry.tracks.toLocaleString()}</td><td class="hh-numeric">{formatBytes(entry.bytes)}</td></tr>
								{/each}
							</tbody>
						</table>
						{#if r.resolutions.length > 0}
							<table>
								<caption>Lossless, by resolution</caption>
								<thead><tr><th scope="col">Resolution</th><th scope="col">Tracks</th></tr></thead>
								<tbody>
									{#each r.resolutions as entry (entry.label)}
										<tr><td>{entry.label}</td><td class="hh-numeric">{entry.tracks.toLocaleString()}</td></tr>
									{/each}
								</tbody>
							</table>
						{/if}
					</div>

					<ul class="report-lacks hh-numeric">
						<li>{r.withoutReplayGain.toLocaleString()} tracks without ReplayGain</li>
						<li>{r.withoutGenre.toLocaleString()} without a genre</li>
						<li>{r.withoutYear.toLocaleString()} without a year</li>
					</ul>

					{#if r.mixedCount > 0}
						<details>
							<summary>{r.mixedCount === 1 ? "1 album" : `${r.mixedCount.toLocaleString()} albums`} in more than one format{r.mixedCount > r.mixed.length ? `, the first ${r.mixed.length}` : ''}</summary>
							<ul class="report-list">
								{#each r.mixed as album (album.id)}
									<li><a href="/albums/{album.id}">{album.name}</a><span class="hh-muted"> · {album.artist ?? 'Unknown artist'} · {album.formats.join(', ')}</span></li>
								{/each}
							</ul>
						</details>
					{/if}
					{#if r.duplicateCount > 0}
						<details>
							<summary>{r.duplicateCount === 1 ? "1 album" : `${r.duplicateCount.toLocaleString()} albums`} held more than once{r.duplicateCount > r.duplicates.length ? `, the first ${r.duplicates.length}` : ''}</summary>
							<ul class="report-list">
								{#each r.duplicates as group, index (index)}
									<li>
										{group.name}<span class="hh-muted"> · {group.artist ?? 'Unknown artist'}:</span>
										{#each group.albums as album, i (album.id)}{i > 0 ? ', ' : ' '}<a href="/albums/{album.id}">{album.formats.join('/')} ({album.tracks})</a>{/each}
									</li>
								{/each}
							</ul>
						</details>
					{/if}
					{#if r.withoutReplayGainAlbums.length > 0}
						<details>
							<summary>Albums with tracks without ReplayGain{r.withoutReplayGainAlbums.length >= 50 ? ', the first 50' : ''}</summary>
							<ul class="report-list">
								{#each r.withoutReplayGainAlbums as album (album.id)}
									<li><a href="/albums/{album.id}">{album.name}</a><span class="hh-muted"> · {album.artist ?? 'Unknown artist'}</span></li>
								{/each}
							</ul>
						</details>
					{/if}
				{/if}
			{/if}
		</section>
	{/if}

	<!--
		The two values of the deployment an administrator can change from here.
		Everything else about it is in its environment.
	-->
	{#if data.server}
		{@const server = data.server}
		<section class="hh-card hh-glass group" id="server" hidden={shown !== 'storage'}>
			<div class="group-head">
				<h2>This server</h2>
			</div>

			<form
				method="POST"
				action="?/saveServer"
				use:enhance={() =>
					async ({ update }) => {
						await update({ reset: false });
					}}
			>
				<label class="row">
					<span class="label">Addresses</span>
					{#if server.fromEnvironment.origin}
						<span class="hh-muted control">Set by ORIGIN in the environment.</span>
					{:else}
						<textarea
							class="hh-input control addresses"
							name="origins"
							rows={Math.max(2, server.origins.length + 1)}
							spellcheck="false"
							autocomplete="off"
							placeholder="http://192.168.1.10:3000">{server.origins.join('\n')}</textarea>
					{/if}
				</label>

				{#if server.withoutSecure.length > 0}
					<div class="plain-http" role="note">
						<strong>Sign-in on plain http.</strong>
						On {server.withoutSecure.join(' and ')} the sign-in cookie is sent without
						<code>Secure</code>, since a browser does not send a <code>Secure</code> cookie back over
						<code>http://</code>. Anyone who can read that network's traffic can read the cookie, and the
						password as it is typed. Use an <code>https://</code> address where there is one. Setting
						<code>HEDDOHON_COOKIE_SECURE=true</code> in the environment ends this, and sign-in on
						{server.withoutSecure.length === 1 ? 'that address' : 'those addresses'} with it.
					</div>
				{/if}

				<label class="row">
					<span class="label">Cover cache size (MB)</span>
					{#if server.fromEnvironment.coverCache}
						<span class="hh-muted control">
							{server.coverCacheMb.toLocaleString()} MB, set by HEDDOHON_COVER_CACHE_MB in the environment.
						</span>
					{:else}
						<input
							class="hh-input control"
							name="coverCacheMb"
							type="number"
							min="0"
							max={server.maxCoverCacheMb}
							step="1"
							inputmode="numeric"
							value={server.coverCacheMb}
						/>
					{/if}
				</label>

				{#if form && 'serverError' in form && form.serverError}
					<p class="hh-muted note-inline" role="alert">{form.serverError}</p>
				{:else if form && 'serverSaved' in form && form.serverSaved}
					<p class="hh-muted note-inline" role="status">Saved.</p>
				{/if}
				{#if !(server.fromEnvironment.origin && server.fromEnvironment.coverCache)}
					<button class="hh-button" type="submit">Save</button>
				{/if}
			</form>
		</section>
	{/if}

	{#if data.features}
		<section class="hh-card hh-glass group" id="features" hidden={shown !== 'features'}>
			<div class="group-head">
				<h2>Features</h2>
			</div>
			<form
				method="POST"
				action="?/saveFeatures"
				use:enhance={() => {
					featuresBusy = true;
					return async ({ update }) => {
						await update({ reset: false });
						await invalidateAll();
						featuresBusy = false;
					};
				}}
			>
				{#each data.features as feature (feature.id)}
					<label class="row switch">
						<span class="label">
							{feature.title}
							{#if feature.fromEnvironment}
								<span class="hint hh-muted">Set by {feature.variable} in the environment.</span>
							{/if}
						</span>
						<input type="checkbox" name={feature.id} checked={feature.on} disabled={feature.fromEnvironment} />
					</label>
				{/each}
				{#if form && 'featuresError' in form && form.featuresError}
					<p class="hh-muted note-inline" role="alert">{form.featuresError}</p>
				{:else if form && 'featuresSaved' in form && form.featuresSaved}
					<p class="hh-muted note-inline" role="status">Saved.</p>
				{/if}
				<button class="hh-button" type="submit" disabled={featuresBusy}>{featuresBusy ? 'Saving…' : 'Save'}</button>
			</form>
		</section>
	{/if}

	<section class="hh-card hh-glass group" hidden={shown !== 'history'}>
		<div class="group-head">
			<h2>Listening history</h2>
		</div>

		<label class="row">
			<span class="label">Keep</span>
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
					{#if !data.plugin.heard}
						<span class="hint hh-muted">Its Heddohon plugin has not been heard from in the last minute.</span>
					{/if}
				</span>
				<input
					type="checkbox"
					checked={historyOtherApps}
					onchange={(event) => void keepOtherApps(event.currentTarget.checked)}
				/>
			</label>
		{/if}

		{#if data.newReleasesOffered}
			<label class="row switch">
				<span class="label">New releases on the home page</span>
				<input type="checkbox" checked={newReleases} onchange={(event) => void showNewReleases(event.currentTarget.checked)} />
			</label>
		{/if}

		<div class="history-links">
			<a class="hh-button" href="/history">
				<Icon name="history" size={16} />
				Recently played
			</a>
			<a class="hh-button" href="/stats">Your listening</a>
		</div>

		<h3 class="subhead">Export</h3>
		<label class="row">
			<span class="label">Format</span>
			<select class="hh-input control" bind:value={exportFormat}>
				<option value="csv">CSV</option>
				<option value="json">JSON (ListenBrainz)</option>
			</select>
		</label>
		<label class="row">
			<span class="label">From</span>
			<input class="hh-input control" type="date" bind:value={exportFrom} max={exportTo || undefined} />
		</label>
		<label class="row">
			<span class="label">To</span>
			<input class="hh-input control" type="date" bind:value={exportTo} min={exportFrom || undefined} />
		</label>
		<div class="history-links">
			{#if data.historyCount === 0}
				<button class="hh-button" type="button" disabled>No listening history</button>
			{:else if exportRange.wrong}
				<button class="hh-button" type="button" disabled>The start is after the end</button>
			{:else}
				<a class="hh-button" href={exportHref} download>
					<Icon name="download" size={16} />
					Download listening history
				</a>
			{/if}
		</div>

		<h3 class="subhead">Import from {data.serverLabel || 'the music server'}</h3>
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

	/* Eight tabs are wider than the column too: there they wrap to a second line. */
	@media (min-width: 40rem) {
		.tabs {
			flex-wrap: wrap;
			overflow-x: visible;
		}
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
		font-size: 0.75rem;
		text-align: right;
		max-width: 16rem;
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

	.font {
		font-family: var(--font-ui);
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

	/* What an administrator has to know of a saved http address: set off by an
	   edge in the accent, and said in words, not by a colour. */
	.plain-http {
		margin: var(--space-3) 0;
		padding: var(--space-3) var(--space-4);
		border: 1px solid var(--border-strong);
		border-left: 3px solid var(--accent);
		border-radius: var(--r-sm);
		background: var(--bg-sunken);
		color: var(--text-default);
		font-size: 0.875rem;
		line-height: 1.55;
	}

	.plain-http strong {
		color: var(--text-strong);
	}

	.addresses {
		font-family: var(--font-mono);
		font-size: 0.8125rem;
		resize: vertical;
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

	.report-figures {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(8rem, 1fr));
		gap: var(--space-3);
		margin: var(--space-4) 0;
	}

	.report-figures div {
		display: grid;
		gap: 0.15rem;
	}

	.report-figures dt {
		color: var(--text-muted);
		font-size: 0.75rem;
	}

	.report-figures dd {
		margin: 0;
		color: var(--text-strong);
		font-size: 1.125rem;
	}

	.report-tables {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-5);
		margin-bottom: var(--space-4);
	}

	.report-tables table {
		border-collapse: collapse;
		font-size: 0.8125rem;
	}

	.report-tables caption {
		text-align: left;
		padding-bottom: var(--space-2);
		color: var(--text-muted);
	}

	.report-tables th,
	.report-tables td {
		padding: 0.25rem var(--space-4) 0.25rem 0;
		text-align: left;
		border-bottom: 1px solid var(--border-hairline);
	}

	.report-tables th {
		color: var(--text-muted);
		font-weight: 500;
	}

	.report-lacks {
		margin: 0 0 var(--space-3);
		padding-left: 1.2rem;
		font-size: 0.875rem;
	}

	.report-list {
		margin: var(--space-2) 0 var(--space-3);
		padding-left: 1.2rem;
		font-size: 0.8125rem;
		max-height: 18rem;
		overflow-y: auto;
	}

	details summary {
		cursor: pointer;
		font-size: 0.875rem;
		padding: 0.25rem 0;
	}

	/* A token has no cover. */
	.share.assistant {
		grid-template-columns: minmax(0, 1fr) auto;
	}

	.made-token {
		display: grid;
		gap: var(--space-2);
		margin: var(--space-3) 0;
		padding: var(--space-3) var(--space-4);
		border: 1px solid var(--border-strong);
		border-left: 3px solid var(--accent);
		border-radius: var(--r-sm);
		background: var(--bg-sunken);
		font-size: 0.875rem;
	}

	.made-token p {
		margin: 0;
	}

	.secret {
		font-family: var(--font-mono);
		font-size: 0.8125rem;
		resize: none;
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

	.history-links {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
	}

	.subhead {
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

	/* ── Terminal ────────────────────────────────────────────────────────────── */

	/* The tab that is open: the accent, on a rule of it. The other themes light
	   the label, and this one has no glow to do it with. */
	:global([data-theme='terminal']) .tab.active {
		border-radius: 0;
		color: var(--accent);
		box-shadow: inset 0 -2px 0 var(--accent);
	}
</style>
