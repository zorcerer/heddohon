<script lang="ts">
	/**
	 * Who else on this server is playing something, and what.
	 *
	 * Two parts. The heads: a pill of pictures over the foot of the content
	 * column, on a phone above the dock, which is on screen only while someone
	 * else who chose to be shown is playing. And the popup it opens, which grows
	 * out of the pill's corner: each listener with their track, a ring around
	 * the picture for how far in it is, and the switch that shows this account
	 * to the others.
	 *
	 * Mounted once in the root layout. `client/listeners.svelte.ts` holds the
	 * state, and the name and the picture are set under Settings, Account.
	 */
	import { avatarUrl, listeners } from '$lib/client/listeners.svelte';
	import { player } from '$lib/client/player.svelte';
	import type { Listener } from '$lib/server/listening';
	import type { BackendKind } from '$lib/types';
	import Avatar from './Avatar.svelte';
	import Cover from './Cover.svelte';
	import Icon from './Icon.svelte';

	let { backend, username }: { backend: BackendKind; username: string } = $props();

	/** The pictures the pill has room for. The rest are a number beside them. */
	const HEADS = 3;

	let dialog = $state<HTMLDialogElement | null>(null);
	let pill = $state<HTMLButtonElement | null>(null);
	/** The pill's corner as the popup opened, from the right and the foot of the screen, in pixels. */
	let anchor = $state({ right: 12, bottom: 12 });
	/** Ticks once a second while open, so each ring moves. */
	let now = $state(Date.now());
	/** The listener whose track is being fetched to play here. */
	let tuning = $state<string | null>(null);
	let saving = $state(false);

	const others = $derived(listeners.others);
	// The most recent to start are the ones pictured, the newest last and on top.
	const heads = $derived(others.slice(-HEADS));
	const you = $derived(listeners.you);

	const summary = $derived.by(() => {
		const names = heads.map((listener) => listener.name);
		const rest = others.length - names.length;
		const list = rest > 0 ? `${names.join(', ')} and ${rest} more` : names.join(', ');
		return `Listening now: ${list}`;
	});

	function show() {
		const rect = pill?.getBoundingClientRect();
		if (rect) anchor = { right: Math.max(0, innerWidth - rect.right), bottom: Math.max(0, innerHeight - rect.bottom) };
		listeners.error = null;
		listeners.open = true;
	}

	$effect(() => {
		if (!dialog) return;
		if (listeners.open && !dialog.open) dialog.showModal();
		else if (!listeners.open && dialog.open) dialog.close();
	});

	$effect(() => {
		if (!listeners.open) return;
		now = Date.now();
		const timer = setInterval(() => (now = Date.now()), 1000);
		return () => clearInterval(timer);
	});

	const progress = (listener: Listener) =>
		listener.duration > 0 ? Math.min(1, listeners.positionOf(listener, now) / listener.duration) : 0;

	async function tune(listener: Listener, how: 'play' | 'queue') {
		tuning = listener.id;
		const done = await listeners.tune(listener, how);
		tuning = null;
		if (done && how === 'play') listeners.open = false;
	}

	async function setShown(shown: boolean) {
		saving = true;
		await listeners.save({ shown });
		saving = false;
	}
</script>

{#if others.length > 0}
	<button
		bind:this={pill}
		class="heads hh-glass hh-glass--deep hh-float"
		class:covered={player.sheetLayout && player.panelOpen}
		class:opened={listeners.open}
		type="button"
		aria-haspopup="dialog"
		aria-label={summary}
		title="Listening now"
		onclick={show}
	>
		<span class="bars" aria-hidden="true"><i></i><i></i><i></i></span>
		<span class="stack">
			{#each heads as listener (listener.id)}
				<span class="head"><Avatar name={listener.name} src={avatarUrl(listener.id, listener.avatar)} size={1.75} /></span>
			{/each}
		</span>
		{#if others.length > heads.length}
			<span class="more hh-numeric">+{others.length - heads.length}</span>
		{/if}
	</button>
{/if}

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
<dialog
	bind:this={dialog}
	class="listening hh-glass"
	aria-labelledby="listening-title"
	style:--anchor-right="{anchor.right}px"
	style:--anchor-bottom="{anchor.bottom}px"
	onclose={() => (listeners.open = false)}
	onclick={(event) => {
		// The pane fills the dialog, so a press that lands on the dialog itself is on the backdrop.
		if (event.target === dialog) listeners.open = false;
	}}
>
	<div class="pane">
		<header>
			<div>
				<span class="hh-eyebrow">On this server</span>
				<h2 id="listening-title">Listening now</h2>
			</div>
			<button class="close" onclick={() => (listeners.open = false)} aria-label="Close">
				<Icon name="close" size={18} />
			</button>
		</header>

		{#if listeners.error}
			<p class="alert" role="alert">{listeners.error}</p>
		{/if}

		{#if others.length === 0}
			<p class="hh-muted empty">Nobody else is playing anything right now.</p>
		{:else}
			<ul class="list">
				{#each others as listener (listener.id)}
					{@const here = listener.backend === backend}
					<li class="listener">
						<span class="who" style:--progress={progress(listener)}>
							<svg class="ring" viewBox="0 0 36 36" aria-hidden="true">
								<circle class="track" cx="18" cy="18" r="17" />
								<circle class="played" cx="18" cy="18" r="17" pathLength="1" />
							</svg>
							<Avatar name={listener.name} src={avatarUrl(listener.id, listener.avatar)} size={2.5} />
						</span>

						<div class="text">
							<span class="name hh-truncate">{listener.name}</span>
							<span class="title hh-truncate">{listener.title}</span>
							<span class="artist hh-truncate hh-muted">
								{listener.artist ?? 'Unknown artist'}{here ? '' : ' · on the other music server'}
							</span>
						</div>

						{#if here && listener.albumId}
							<a
								class="art"
								href="/albums/{encodeURIComponent(listener.albumId)}"
								aria-label="Open {listener.album ?? 'the album'}"
								title={listener.album ?? undefined}
								onclick={() => (listeners.open = false)}
							>
								<Cover coverArt={listener.coverArt} size={96} alt="" radius="var(--r-sm)" fill />
							</a>
						{:else if here}
							<span class="art"><Cover coverArt={listener.coverArt} size={96} alt="" radius="var(--r-sm)" fill /></span>
						{/if}

						{#if here}
							<div class="moves">
								<button class="hh-button" type="button" disabled={tuning !== null} onclick={() => tune(listener, 'play')}>
									<Icon name="play" size={13} />
									Play it here
								</button>
								<button class="hh-button" type="button" disabled={tuning !== null} onclick={() => tune(listener, 'queue')}>
									<Icon name="plus" size={13} />
									Add to queue
								</button>
							</div>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}

		{#if you}
			<footer>
				<Avatar name={you.name ?? username} src={avatarUrl(you.id, you.avatar)} size={2} />
				<label class="mine">
					<span class="label">
						Show others what I play
						<span class="hint hh-muted">
							{you.shown ? `Shown as ${you.name ?? username}.` : 'You are not shown.'}
							<a href="/settings?tab=account#listening" onclick={() => (listeners.open = false)}>Name and picture</a>
						</span>
					</span>
					<input
						type="checkbox"
						checked={you.shown}
						disabled={saving}
						onchange={(event) => setShown(event.currentTarget.checked)}
					/>
				</label>
			</footer>
		{/if}
	</div>
</dialog>

<style>
	/*
	 * Over the foot of the content column, in its grid cell, at the corner the
	 * player is on: it moves with the column as the player opens and closes and
	 * covers neither the rail nor the player. The content scrolls inside its
	 * cell, so the pill stays put.
	 */
	.heads {
		grid-area: content;
		align-self: end;
		justify-self: end;
		z-index: 2;
		margin: 0 var(--space-4) var(--space-4) 0;
		display: flex;
		align-items: center;
		gap: var(--space-2);
		min-height: 2.75rem;
		padding: 0.375rem 0.5rem 0.375rem 0.75rem;
		border-radius: var(--r-pill);
		color: var(--text-muted);
		/* Opacity on the glass element itself keeps its blur through the fade. */
		animation: heads-in var(--dur-state) var(--ease-out) both;
		transition:
			color var(--transition),
			opacity var(--dur-hover) var(--ease-out);
	}

	/*
	 * Under the open popup, whose glass it showed through at the corner they
	 * share. Faded and not hidden, so it can take the focus back as the popup
	 * closes.
	 */
	.heads.opened {
		opacity: 0;
	}

	.heads:hover,
	.heads:focus-visible {
		color: var(--glow-color);
	}

	.heads:active {
		background-color: var(--bg-hover);
	}

	@keyframes heads-in {
		from {
			opacity: 0;
		}
	}

	/* Three bars rising and falling, as beside a playing track: these are playing now. */
	.bars {
		display: flex;
		align-items: flex-end;
		gap: 2px;
		height: 0.875rem;
		color: var(--accent);
	}

	.bars i {
		width: 2px;
		height: 100%;
		border-radius: 1px;
		background: currentColor;
		transform-origin: bottom;
		animation: heads-bar 0.9s var(--ease-colour) infinite alternate;
	}

	.bars i:nth-child(2) {
		animation-delay: -0.3s;
	}

	.bars i:nth-child(3) {
		animation-delay: -0.6s;
	}

	@keyframes heads-bar {
		from {
			scale: 1 0.3;
		}
		to {
			scale: 1 1;
		}
	}

	.stack {
		display: flex;
	}

	/*
	 * Each picture laps over the one before it, and arrives on the spring. The
	 * edge is the pill's own ground, so a picture reads as cut out of its
	 * neighbour. The pictures hold no glass, so they can move.
	 */
	.head {
		display: grid;
		border-radius: 50%;
		box-shadow: 0 0 0 2px var(--bg-surface);
		animation: head-in var(--dur-state) var(--ease-spring) both;
	}

	.head + .head {
		margin-left: -0.5rem;
	}

	@keyframes head-in {
		from {
			scale: 0.4;
			opacity: 0;
		}
	}

	.more {
		padding-right: 0.25rem;
		font-size: 0.75rem;
		font-weight: 600;
	}

	@media (max-width: 60rem) {
		/* A phone: the page scrolls as a whole, so the pill is fixed above the
		   dock, under it (40) and the player sheet (45) in the stack. */
		.heads {
			position: fixed;
			right: var(--edge-right);
			bottom: var(--dock-space);
			margin: 0;
			z-index: 39;
		}

		/* Gone under the open sheet, as the dock is. */
		.heads.covered {
			visibility: hidden;
		}
	}

	/*
	 * The popup. Its corner is the pill's corner, so it opens out of the pill,
	 * over the page and beside the player. Placed by its insets, not a transform,
	 * which is kept off glass.
	 */
	.listening {
		position: fixed;
		inset: auto var(--anchor-right) var(--anchor-bottom) auto;
		margin: 0;
		width: min(23rem, calc(100vw - 2 * var(--float-gap)));
		max-width: calc(100vw - var(--anchor-right) - var(--edge-left));
		max-height: calc(100dvh - var(--anchor-bottom) - var(--edge-top));
		padding: 0;
		border: 1px solid var(--glass-edge);
		border-radius: var(--r-lg);
		color: var(--text-default);
		box-shadow: var(--shadow-high);
		overflow: hidden;
	}

	/* The page stays in view behind it: this is a popup over the page, not a step away from it. */
	.listening::backdrop {
		background: rgb(0 0 0 / 0.28);
	}

	.pane {
		display: flex;
		flex-direction: column;
		max-height: inherit;
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
		padding: var(--space-3) var(--space-4);
		display: grid;
		gap: var(--space-3);
		min-height: 0;
		overflow-y: auto;
	}

	.listener {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr) auto;
		align-items: center;
		gap: var(--space-3);
		padding: var(--space-3);
		border-radius: var(--r-md);
		border: 1px solid var(--border-hairline);
		background: var(--bg-sunken);
	}

	/* The picture inside its ring: how far into the track the listener is. */
	.who {
		position: relative;
		display: grid;
		place-items: center;
		width: 3rem;
		height: 3rem;
	}

	.ring {
		position: absolute;
		inset: 0;
		rotate: -90deg;
		fill: none;
		stroke-width: 2;
	}

	.track {
		stroke: var(--border-strong);
	}

	.played {
		stroke: var(--accent);
		stroke-linecap: round;
		stroke-dasharray: 1;
		stroke-dashoffset: calc(1 - var(--progress));
		/* A second long, the length of a tick, so the ring turns without stepping. */
		transition: stroke-dashoffset 1s linear;
	}

	.text {
		display: grid;
		min-width: 0;
	}

	.name {
		font-weight: 650;
		color: var(--text-strong);
	}

	.title {
		font-size: 0.875rem;
	}

	.artist {
		font-size: 0.8125rem;
	}

	.art {
		display: block;
		width: 2.75rem;
		height: 2.75rem;
		border-radius: var(--r-sm);
	}

	.moves {
		grid-column: 1 / -1;
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

	footer {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		padding: var(--space-3) var(--space-4) var(--space-4);
		border-top: 1px solid var(--border-hairline);
	}

	.mine {
		flex: 1;
		min-width: 0;
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		align-items: center;
		gap: var(--space-3);
		cursor: pointer;
	}

	.label {
		display: grid;
		gap: 0.1rem;
		font-size: 0.875rem;
		font-weight: 500;
		color: var(--text-strong);
	}

	.hint {
		font-size: 0.8125rem;
		font-weight: 400;
	}

	.hint a {
		color: inherit;
		text-decoration: underline;
		text-underline-offset: 2px;
	}

	.hint a:hover {
		color: var(--glow-color);
	}

	input[type='checkbox'] {
		width: 1.15rem;
		height: 1.15rem;
		accent-color: var(--accent);
		cursor: pointer;
	}

	@media (prefers-reduced-motion: reduce) {
		.heads,
		.head,
		.bars i {
			animation: none;
		}

		.played {
			transition: none;
		}
	}
</style>
