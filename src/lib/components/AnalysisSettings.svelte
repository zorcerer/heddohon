<script lang="ts">
	import { onMount } from 'svelte';
	import { invalidateAll } from '$app/navigation';
	import Select from './Select.svelte';
	import Switch from './Switch.svelte';

	/**
	 * Settings, Server, Sound analysis (issue #319): what the job is doing and
	 * its controls, for an administrator. Everything goes through
	 * `/api/analysis`, asked every 5 seconds while this is mounted, which the
	 * page does only while the section is shown. Each control saves as it
	 * changes, as the rest of Settings does.
	 */
	let { on: initialOn, fromEnvironment: initialFromEnvironment }: { on: boolean; fromEnvironment: boolean } = $props();

	type State = 'off' | 'no-account' | 'listing' | 'running' | 'paused' | 'throttled' | 'outside-hours' | 'done' | 'stopped';
	interface Overview {
		on: boolean;
		fromEnvironment: boolean;
		status: {
			state: State;
			total: number;
			measured: number;
			failed: number;
			current: { title: string; artist: string | null } | null;
			lastHour: number;
			finishInMs: number | null;
			lastError: { title: string; message: string; at: number } | null;
		} | null;
		settings: {
			paused: boolean;
			pace: 'full' | 'gentle' | 'background';
			whileListening: 'pause' | 'continue';
			hours: { from: number; to: number } | null;
		};
	}

	const POLL_MS = 5000;

	let overview = $state<Overview | null>(null);
	let problem = $state<string | null>(null);
	let busy = $state(false);
	let confirmingReset = $state(false);

	const on = $derived(overview?.on ?? initialOn);
	const fromEnvironment = $derived(overview?.fromEnvironment ?? initialFromEnvironment);
	const status = $derived(overview?.status ?? null);
	const shownState = $derived<State>(on ? (status?.state ?? 'listing') : 'off');

	const WORDS: Record<State, string> = {
		off: 'Off',
		'no-account': 'No account',
		listing: 'Reading the library',
		running: 'Running',
		paused: 'Paused',
		throttled: 'Waiting for quiet',
		'outside-hours': 'Waiting for its hours',
		done: 'Done',
		stopped: 'Stopped'
	};
	// Until the first answer, the state is not known yet.
	const word = $derived(on && !overview ? '…' : shownState === 'off' && fromEnvironment ? 'Off for the server' : WORDS[shownState]);

	async function ask(method: 'GET' | 'PATCH' | 'POST', body?: unknown): Promise<void> {
		try {
			const response = await fetch('/api/analysis', {
				method,
				headers: body === undefined ? undefined : { 'content-type': 'application/json' },
				body: body === undefined ? undefined : JSON.stringify(body)
			});
			if (!response.ok) {
				const answer = (await response.json().catch(() => null)) as { message?: string } | null;
				problem = answer?.message ?? `The server answered ${response.status}.`;
				return;
			}
			overview = (await response.json()) as Overview;
			problem = null;
		} catch {
			problem = 'The server could not be reached.';
		}
	}

	async function change(body: Record<string, unknown>): Promise<void> {
		busy = true;
		await ask('PATCH', body);
		busy = false;
	}

	async function switchOn(next: boolean): Promise<void> {
		await change({ on: next });
		// The account's card below comes from the page's loader.
		await invalidateAll();
	}

	async function act(action: 'retry' | 'reset'): Promise<void> {
		busy = true;
		await ask('POST', { action });
		busy = false;
		confirmingReset = false;
	}

	onMount(() => {
		void ask('GET');
		const timer = setInterval(() => {
			if (document.visibilityState === 'visible') void ask('GET');
		}, POLL_MS);
		return () => clearInterval(timer);
	});

	const count = (n: number) => n.toLocaleString();

	/** 3 h 20 min, 12 min, under a minute. */
	function duration(ms: number): string {
		const minutes = Math.round(ms / 60_000);
		if (minutes < 1) return 'under a minute';
		const hours = Math.floor(minutes / 60);
		if (hours === 0) return `${minutes} min`;
		if (hours >= 48) return `${Math.round(hours / 24)} days`;
		return minutes % 60 === 0 ? `${hours} h` : `${hours} h ${minutes % 60} min`;
	}

	const pad = (n: number) => String(n).padStart(2, '0');
	const toTime = (minute: number) => `${pad(Math.floor(minute / 60))}:${pad(minute % 60)}`;
	const fromTime = (text: string) => {
		const [h, m] = text.split(':').map(Number);
		return Number.isInteger(h) && Number.isInteger(m) ? h * 60 + m : null;
	};

	/** Default hours when they are switched on: the night, 01:00 to 07:00. */
	const NIGHT = { from: 60, to: 420 };

	function setHour(which: 'from' | 'to', text: string): void {
		const hours = overview?.settings.hours;
		const minute = fromTime(text);
		if (!hours || minute === null) return;
		void change({ hours: { ...hours, [which]: minute } });
	}

	const done = $derived(status ? status.measured + status.failed : 0);
</script>

<label class="row switch">
	<span class="label">
		On
		{#if fromEnvironment}
			<span class="hint hh-muted">Set by HEDDOHON_ANALYSIS in the environment.</span>
		{/if}
	</span>
	<Switch name="analysisOn" label="Sound analysis on" checked={on} disabled={fromEnvironment || busy} onchange={(next) => void switchOn(next)} />
</label>

<div class="row switch">
	<span class="label">State</span>
	<span class="state" data-state={shownState} role="status">{word}</span>
</div>

{#if on && status && status.total > 0}
	<div class="progress">
		<progress aria-label="Songs analysed" max={status.total} value={done}></progress>
		<span class="hh-numeric">{count(done)} of {count(status.total)}</span>
	</div>
	<dl class="figures">
		{#if status.current}
			<div class="wide">
				<dt>Now</dt>
				<dd>{status.current.title}{status.current.artist ? ` · ${status.current.artist}` : ''}</dd>
			</div>
		{/if}
		<div>
			<dt>Last hour</dt>
			<dd class="hh-numeric">{count(status.lastHour)}</dd>
		</div>
		<div>
			<dt>Left</dt>
			<dd class="hh-numeric">{status.finishInMs === null ? '–' : duration(status.finishInMs)}</dd>
		</div>
		<div>
			<dt>Failed</dt>
			<dd class="hh-numeric">{count(status.failed)}</dd>
		</div>
	</dl>
{/if}

{#if on && status?.lastError}
	<div class="error" role="note">
		<p>
			{#if status.lastError.title}<strong>{status.lastError.title}</strong>{/if}
			{status.lastError.message}
		</p>
		{#if status.failed > 0}
			<button class="hh-button" type="button" disabled={busy} onclick={() => void act('retry')}>Retry failed songs</button>
		{/if}
	</div>
{:else if on && status && status.failed > 0}
	<button class="hh-button retry" type="button" disabled={busy} onclick={() => void act('retry')}>Retry failed songs</button>
{/if}

{#if on && overview}
	<h3 class="subhead">Pace</h3>
	<label class="row switch">
		<span class="label">Paused</span>
		<Switch name="analysisPaused" label="Paused" checked={overview.settings.paused} disabled={busy} onchange={(paused) => void change({ paused })} />
	</label>
	<label class="row">
		<span class="label">Speed</span>
		<Select
			label="Speed"
			value={overview.settings.pace}
			options={[
				{ value: 'full', label: 'Full' },
				{ value: 'gentle', label: 'Gentle' },
				{ value: 'background', label: 'Background' }
			]}
			onchange={(pace) => void change({ pace })}
		/>
	</label>
	<label class="row">
		<span class="label">While someone listens</span>
		<Select
			label="While someone listens"
			value={overview.settings.whileListening}
			options={[
				{ value: 'pause', label: 'Wait' },
				{ value: 'continue', label: 'Carry on' }
			]}
			onchange={(whileListening) => void change({ whileListening })}
		/>
	</label>
	<label class="row switch">
		<span class="label">Only at set hours</span>
		<Switch
			name="analysisHours"
			label="Only at set hours"
			checked={overview.settings.hours !== null}
			disabled={busy}
			onchange={(limited) => void change({ hours: limited ? NIGHT : null })}
		/>
	</label>
	{#if overview.settings.hours}
		<div class="row">
			<span class="label">Between</span>
			<span class="hours">
				<input
					class="hh-input"
					type="time"
					aria-label="From"
					value={toTime(overview.settings.hours.from)}
					onchange={(event) => setHour('from', event.currentTarget.value)}
				/>
				<input
					class="hh-input"
					type="time"
					aria-label="To"
					value={toTime(overview.settings.hours.to)}
					onchange={(event) => setHour('to', event.currentTarget.value)}
				/>
			</span>
		</div>
	{/if}

	{#if confirmingReset}
		<div class="confirm" role="alertdialog" aria-label="Confirm reset">
			<p>Remove every result and analyse the whole library again?</p>
			<div class="actions">
				<button class="hh-button danger" type="button" disabled={busy} onclick={() => void act('reset')}>Reset</button>
				<button class="hh-button" type="button" disabled={busy} onclick={() => (confirmingReset = false)}>Keep them</button>
			</div>
		</div>
	{:else}
		<button class="hh-button danger reset" type="button" disabled={busy} onclick={() => (confirmingReset = true)}>Reset…</button>
	{/if}
{/if}

{#if problem}
	<p class="hh-muted small" role="alert">{problem}</p>
{/if}

<style>
	.row {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(0, 16rem);
		gap: var(--space-4);
		align-items: center;
	}

	.row.switch {
		grid-template-columns: minmax(0, 1fr) auto;
	}

	.row > :global(.hh-select) {
		justify-self: end;
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
	}

	.state {
		justify-self: end;
		font-weight: 600;
		color: var(--text-strong);
	}

	.state[data-state='stopped'] {
		color: var(--danger);
	}

	.state[data-state='running'] {
		color: var(--accent);
	}

	.progress {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		font-size: 0.875rem;
	}

	.progress progress {
		flex: 1;
		height: 0.375rem;
		accent-color: var(--accent);
	}

	.figures {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: var(--space-3);
		margin: 0;
	}

	.figures .wide {
		grid-column: 1 / -1;
	}

	.figures dt {
		font-size: 0.8125rem;
		color: var(--text-muted);
	}

	.figures dd {
		margin: 0;
		color: var(--text-strong);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.subhead {
		margin: var(--space-2) 0 0;
		font-size: 0.95rem;
	}

	.hours {
		display: flex;
		gap: var(--space-2);
		justify-self: end;
	}

	.hours input {
		width: 7rem;
	}

	.error,
	.confirm {
		padding: var(--space-3) var(--space-4);
		border-radius: var(--r-md);
		border: 1px solid color-mix(in srgb, var(--danger) 40%, transparent);
		background: color-mix(in srgb, var(--danger) 8%, var(--bg-surface));
		display: grid;
		gap: var(--space-3);
		justify-items: start;
	}

	.error p,
	.confirm p {
		margin: 0;
		font-size: 0.875rem;
		overflow-wrap: anywhere;
	}

	.error strong {
		color: var(--text-strong);
		margin-right: 0.35em;
	}

	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
	}

	.retry,
	.reset {
		justify-self: start;
	}

	.danger:hover {
		color: var(--danger);
		border-color: var(--danger);
	}

	.small {
		font-size: 0.8125rem;
		margin: 0;
	}

	@media (max-width: 40rem) {
		.row {
			grid-template-columns: minmax(0, 1fr);
			gap: var(--space-2);
		}

		.row.switch {
			grid-template-columns: minmax(0, 1fr) auto;
		}

		.hours,
		.row > :global(.hh-select) {
			justify-self: start;
		}
	}
</style>
