<script lang="ts">
	/**
	 * The account's other browsers with the player open, each with what it is
	 * playing and a remote for it. Mounted once in the root layout and opened
	 * from the player's tool row; `client/remote.svelte.ts` holds the state.
	 */
	import { remote } from '$lib/client/remote.svelte';
	import { player } from '$lib/client/player.svelte';
	import { formatDuration } from '$lib/client/format';
	import Cover from './Cover.svelte';
	import Icon from './Icon.svelte';
	import Seekbar from './Seekbar.svelte';

	let dialog = $state<HTMLDialogElement | null>(null);
	/** Ticks once a second while open, so a playing peer's position moves. */
	let now = $state(Date.now());

	$effect(() => {
		if (!dialog) return;
		if (remote.open && !dialog.open) {
			remote.error = null;
			dialog.showModal();
		} else if (!remote.open && dialog.open) {
			dialog.close();
		}
	});

	$effect(() => {
		if (!remote.open) return;
		now = Date.now();
		const timer = setInterval(() => (now = Date.now()), 1000);
		return () => clearInterval(timer);
	});

	const since = (at: number) =>
		new Date(at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
</script>

<dialog bind:this={dialog} onclose={() => (remote.open = false)} class="devices hh-glass" aria-labelledby="devices-title">
	<header>
		<div>
			<span class="hh-eyebrow">Your other browsers</span>
			<h2 id="devices-title">Devices</h2>
		</div>
		<button class="close" onclick={() => (remote.open = false)} aria-label="Close">
			<Icon name="close" size={18} />
		</button>
	</header>

	{#if remote.error}
		<p class="alert" role="alert">{remote.error}</p>
	{/if}

	{#if remote.peers.length === 0}
		<p class="hh-muted empty">
			Heddohon is not open in another browser signed in as you. Open it on another device and it shows here.
		</p>
	{:else}
		<ul class="list">
			{#each remote.peers as peer (peer.id)}
				{@const state = peer.state}
				<li class="peer">
					<div class="who">
						<Icon name="devices" size={16} />
						<span class="device">{peer.device ?? 'Unknown browser'}</span>
						<span class="hh-muted hh-numeric opened">since {since(peer.since)}</span>
					</div>

					{#if state}
						{@const position = remote.positionOf(state, now)}
						<div class="now">
							<span class="art"><Cover coverArt={state.coverArt} size={96} alt="" radius="var(--r-sm)" fill /></span>
							<div class="text">
								<span class="title hh-truncate">{state.title}</span>
								<span class="artist hh-truncate hh-muted">{state.artist ?? ''}</span>
							</div>
							<span class="hh-muted status">{state.playing ? 'Playing' : 'Paused'}</span>
						</div>

						<div class="transport">
							<button class="step" onclick={() => remote.send(peer.id, { type: 'previous' })} aria-label="Previous on {peer.device ?? 'that browser'}">
								<Icon name="previous" size={16} />
							</button>
							<button
								class="toggle"
								onclick={() => remote.send(peer.id, { type: 'toggle' })}
								aria-label="{state.playing ? 'Pause' : 'Play'} on {peer.device ?? 'that browser'}"
							>
								<Icon name={state.playing ? 'pause' : 'play'} size={16} />
							</button>
							<button class="step" onclick={() => remote.send(peer.id, { type: 'next' })} aria-label="Next on {peer.device ?? 'that browser'}">
								<Icon name="next" size={16} />
							</button>
							<span class="hh-numeric hh-muted time">{formatDuration(position)}</span>
							<span class="bar">
								<Seekbar
									value={position}
									max={state.duration}
									onseek={(seconds) => remote.send(peer.id, { type: 'seek', position: seconds })}
									ariaLabel="Position on {peer.device ?? 'that browser'}"
									formatValue={(value) => formatDuration(value)}
									unit={1}
								/>
							</span>
						</div>

						<div class="volume">
							<Icon name="volume" size={14} />
							<span class="bar">
								<Seekbar
									value={state.volume}
									max={1}
									onseek={(value) => remote.send(peer.id, { type: 'volume', volume: value })}
									ariaLabel="Volume on {peer.device ?? 'that browser'}"
									formatValue={(value) => `${Math.round(value * 100)} percent`}
								/>
							</span>
						</div>
					{:else}
						<p class="hh-muted idle">Nothing playing</p>
					{/if}

					<div class="moves">
						{#if state}
							<button class="hh-button" onclick={() => remote.playHere(peer.id)}>
								Play here
							</button>
						{/if}
						<button class="hh-button" onclick={() => remote.playOn(peer.id)} disabled={player.queue.length === 0}>
							Play this queue there
						</button>
					</div>
				</li>
			{/each}
		</ul>
	{/if}
</dialog>

<style>
	.devices {
		width: min(28rem, calc(100vw - 2rem));
		padding: 0;
		border: 1px solid var(--glass-edge);
		border-radius: var(--r-lg);
		color: var(--text-default);
		box-shadow: var(--shadow-high);
	}

	.devices::backdrop {
		background: rgb(0 0 0 / 0.45);
		backdrop-filter: blur(2px);
	}

	header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: var(--space-3);
		padding: var(--space-4) var(--space-4) var(--space-3);
		border-bottom: 1px solid var(--border-hairline);
	}

	h2 {
		font-size: 1.15rem;
		margin: 0.15rem 0 0;
	}

	.close {
		display: grid;
		place-items: center;
		padding: 0.3rem;
		border-radius: var(--r-sm);
		color: var(--text-faint);
		transition: color var(--transition);
	}

	.close:hover {
		color: var(--glow-color);
		filter: var(--glow-icon);
	}

	.alert {
		margin: var(--space-3) var(--space-4) 0;
		padding: var(--space-2) var(--space-3);
		border-radius: var(--r-sm);
		font-size: 0.8125rem;
		background: color-mix(in srgb, var(--danger) 14%, var(--bg-sunken));
		border: 1px solid color-mix(in srgb, var(--danger) 40%, transparent);
		color: var(--text-strong);
	}

	.empty {
		padding: var(--space-5);
		text-align: center;
		font-size: 0.875rem;
		margin: 0;
	}

	.list {
		list-style: none;
		margin: 0;
		padding: var(--space-2) var(--space-4) var(--space-4);
		display: grid;
		gap: var(--space-3);
		max-height: min(34rem, 70vh);
		overflow-y: auto;
	}

	.peer {
		display: grid;
		gap: var(--space-3);
		padding: var(--space-3);
		border-radius: var(--r-md);
		border: 1px solid var(--border-hairline);
		background: var(--bg-sunken);
	}

	.who {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		color: var(--text-muted);
	}

	.device {
		font-weight: 600;
		color: var(--text-strong);
	}

	.opened {
		margin-left: auto;
		font-size: 0.6875rem;
	}

	.now {
		display: grid;
		grid-template-columns: 2.75rem minmax(0, 1fr) auto;
		align-items: center;
		gap: var(--space-3);
	}

	.art {
		display: block;
		width: 2.75rem;
		height: 2.75rem;
	}

	.text {
		display: grid;
		min-width: 0;
	}

	.title {
		font-weight: 500;
	}

	.artist,
	.status,
	.idle {
		font-size: 0.8125rem;
	}

	.idle {
		margin: 0;
	}

	.transport,
	.volume {
		display: flex;
		align-items: center;
		gap: var(--space-2);
	}

	.volume {
		color: var(--text-faint);
	}

	.bar {
		flex: 1;
		min-width: 0;
	}

	.time {
		font-size: 0.75rem;
		min-width: 2.75rem;
		text-align: right;
	}

	.step,
	.toggle {
		display: grid;
		place-items: center;
		width: 2rem;
		height: 2rem;
		border-radius: 50%;
		color: var(--text-default);
		transition: color var(--transition);
	}

	.toggle {
		border: 1px solid var(--border-strong);
	}

	.step:hover,
	.toggle:hover {
		color: var(--glow-color);
		filter: var(--glow-icon);
	}

	.moves {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
	}

	.moves .hh-button {
		padding: 0.4rem 0.8rem;
		border-radius: var(--r-md);
		font-size: 0.8125rem;
	}

	.moves .hh-button:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
</style>
