<script lang="ts">
	import type { AudioQuality } from '#lib/types.ts';
	import { formatQuality, qualityDetail } from '#lib/client/format.ts';

	let {
		quality,
		compact = false,
		transcode = null,
		processed = null,
		ontoggle = null
	}: {
		quality: AudioQuality;
		compact?: boolean;
		/** What the music server is converting to, when it is. */
		transcode?: { codec: string; bitrateKbps: number } | null;
		/** The rate this page's audio graph runs at, and what it applies, while the audio goes through it. */
		processed?: { rateHz: number; by: 'equaliser' | 'correction' } | null;
		/** Given, the badge opens the signal path, which holds the switch that turns transcoding on and off. */
		ontoggle?: ((next: boolean) => void) | null;
	} = $props();

	const khz = (hz: number) => {
		const value = hz / 1000;
		return Number.isInteger(value) ? String(value) : value.toFixed(1);
	};

	/*
	 * What reaches the speakers, not only what is in the library. The part the
	 * file had and the audio lost is struck through, and what is played follows
	 * the arrow: the server's conversion, or the graph's rate where processing
	 * resamples (`audiochain.ts` opens at the output's rate).
	 */
	const own = $derived(formatQuality(quality));
	const resampled = $derived(!!processed && !!quality.sampleRateHz && quality.sampleRateHz !== processed.rateHz);
	const changed = $derived(!!transcode || !!processed);
	const from = $derived(
		transcode ? (quality.format?.toUpperCase() ?? '') : resampled ? own.replace(/^\S+\s+/, '') : ''
	);
	const to = $derived(
		transcode
			? `${transcode.codec.toUpperCase()} ${transcode.bitrateKbps}`
			: processed
				? resampled
					? `${khz(processed.rateHz)} kHz · EQ`
					: `${own} · EQ`
				: own
	);
	const label = $derived(from ? `${from} → ${to}` : to);

	const detail = $derived(
		transcode
			? `Transcoded by the music server to ${transcode.codec.toUpperCase()} at ${transcode.bitrateKbps} kbps. The file is ${qualityDetail(quality).join(' · ')}.`
			: qualityDetail(quality).join(' · ')
	);

	// The file as the path's first step: the format, depth and rate alone.
	const file = $derived(
		[quality.format?.toUpperCase(), quality.bitDepth ? `${quality.bitDepth}-bit` : null, quality.sampleRateHz ? `${khz(quality.sampleRateHz)} kHz` : null]
			.filter(Boolean)
			.join(' · ') || own
	);
	const server = $derived(
		transcode ? `Converts to ${transcode.codec.toUpperCase()} at ${transcode.bitrateKbps} kbps` : 'Sends the file as it is'
	);
	const here = $derived.by(() => {
		if (!processed) return 'Plays it as received';
		const what = processed.by === 'correction' ? 'Headphone correction' : 'Equaliser';
		return resampled ? `${what} on: resampled to ${khz(processed.rateHz)} kHz, your output's rate` : `${what} on, at the file's own rate`;
	});

	/*
	 * The path opens in the top layer (the `popover` attribute), so the player
	 * panel's and the sheet's clipping leave it whole, and Escape and a press
	 * outside close it. Placed under the badge, or above it where the screen
	 * ends first.
	 */
	const id = $props.id();
	let button = $state<HTMLButtonElement | null>(null);
	let path = $state<HTMLElement | null>(null);

	function place(event: ToggleEvent) {
		if (event.newState !== 'open' || !button || !path) return;
		const anchor = button.getBoundingClientRect();
		const width = path.offsetWidth;
		const height = path.offsetHeight;
		const gap = 8;
		const left = Math.min(Math.max(gap, anchor.left + anchor.width / 2 - width / 2), window.innerWidth - width - gap);
		const below = anchor.bottom + gap;
		const top = below + height <= window.innerHeight - gap ? below : Math.max(gap, anchor.top - gap - height);
		path.style.left = `${left}px`;
		path.style.top = `${top}px`;
	}

	function choose(next: boolean) {
		path?.hidePopover();
		ontoggle?.(next);
	}
</script>

{#snippet face()}
	{#if quality.highResolution && !compact && !changed}
		<span class="dot" aria-hidden="true"></span>
	{/if}
	<!-- Keyed: a change of what is played swaps the words, and the new ones rise into place. -->
	{#key label}
		<span class="swap">
			{#if from}<s class="from">{from}</s><span class="arrow" aria-hidden="true">→</span>{/if}{to}
		</span>
	{/key}
{/snippet}

{#if own || transcode}
	{#if ontoggle}
		<button
			bind:this={button}
			class="badge hh-numeric"
			class:hires={quality.highResolution && !changed}
			class:lossless={quality.lossless && !quality.highResolution && !changed}
			class:changed
			class:compact
			type="button"
			popovertarget="{id}-path"
			aria-label="{label}. What you're hearing"
		>
			{@render face()}
		</button>
		<div bind:this={path} id="{id}-path" class="path" popover="auto" ontoggle={place} role="dialog" aria-label="What you're hearing">
			<p class="heading">What you're hearing</p>
			<ol>
				<li><span class="where">File</span><span class="what">{file}</span></li>
				<li class:changed={!!transcode}><span class="where">Music server</span><span class="what">{server}</span></li>
				<li class:changed={!!processed}><span class="where">This browser</span><span class="what">{here}</span></li>
			</ol>
			<div class="acts">
				{#if transcode}
					{#if !processed}<span class="why">Uses less data, loses detail</span>{/if}
					<button class="act" type="button" onclick={() => choose(false)}>Send the original</button>
				{:else if !processed}
					<button class="act" type="button" onclick={() => choose(true)}>Transcode to save data</button>
				{/if}
				{#if processed}
					{#if !transcode}<span class="why">{resampled ? 'Shapes the sound, changes the rate' : 'Shapes the sound'}</span>{/if}
					<a class="act" href="/settings?tab=playback#this-browser" onclick={() => path?.hidePopover()}>Audio processing</a>
				{/if}
			</div>
		</div>
	{:else}
		<span
			class="badge hh-numeric"
			class:hires={quality.highResolution && !transcode}
			class:lossless={quality.lossless && !quality.highResolution && !transcode}
			class:changed={!!transcode}
			class:compact
			title={detail}
		>
			{@render face()}
		</span>
	{/if}
{/if}

<style>
	.badge {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		padding: 0.1rem 0.45rem;
		border-radius: var(--r-sm);
		border: 1px solid var(--border-strong);
		color: var(--text-muted);
		font-size: 0.6875rem;
		font-weight: 500;
		letter-spacing: 0.01em;
		white-space: nowrap;
		line-height: 1.5;
	}

	.badge.compact {
		padding: 0 0.3rem;
		font-size: 0.6875rem;
	}

	/* A new label rises into place: the switch to a conversion and back, and a
	   track change that brings a different format. */
	.swap {
		display: inline-block;
		animation: badge-swap var(--dur-state) var(--ease-out);
	}

	@keyframes badge-swap {
		from {
			opacity: 0;
			translate: 0 0.4em;
		}
	}

	/* Both from the artwork: lossless as an outline in the accent, hi-res as a
	   filled badge in the stronger accent. */
	.lossless {
		border-color: color-mix(in srgb, var(--accent) 45%, transparent);
		color: var(--accent);
	}

	.hires {
		border-color: color-mix(in srgb, var(--highres) 55%, transparent);
		background: color-mix(in srgb, var(--highres) 10%, transparent);
		color: var(--highres);
		font-weight: 600;
	}

	.dot {
		width: 0.3rem;
		height: 0.3rem;
		border-radius: 50%;
		background: currentColor;
	}

	/*
	 * Something between the file and the speakers changed the audio: the
	 * server's conversion or this page's graph. Amber, the one colour not from
	 * the artwork, so it reads the same on every cover; a darker one on a light
	 * ground. At least 10.1:1 on Liquid's and Terminal's grounds and 5.2:1 on
	 * Paper's (measured 2026-11-12).
	 */
	.badge.changed,
	.path li.changed .what {
		--changed: light-dark(#7a5000, #e6c07a);
	}

	.badge.changed {
		border-style: dashed;
		border-color: color-mix(in srgb, var(--changed) 60%, transparent);
		background: color-mix(in srgb, var(--changed) 10%, transparent);
		color: var(--changed);
	}

	.from {
		opacity: 0.7;
		text-decoration-color: color-mix(in srgb, currentColor 70%, transparent);
	}

	.arrow {
		margin-inline: 0.3em;
		color: var(--text-faint);
	}

	/* ── The signal path ── */

	.path {
		position: fixed;
		inset: auto;
		margin: 0;
		width: min(20rem, calc(100vw - 1rem));
		padding: var(--space-3) var(--space-4);
		border: 1px solid var(--border-strong);
		border-radius: var(--r-md);
		/* Solid: as glass, the title and the heart under it read through the steps. */
		background: var(--bg-raised);
		box-shadow: 0 0.75rem 2rem rgb(0 0 0 / 0.35);
		color: var(--text-default);
		font-size: 0.8125rem;
		line-height: 1.4;
		text-align: left;
	}

	.heading {
		margin: 0 0 var(--space-2);
		color: var(--text-strong);
		font-weight: 600;
	}

	ol {
		display: grid;
		gap: var(--space-2);
		margin: 0;
		padding: 0;
		list-style: none;
	}

	/* A ring per step on a line down the left; a changed step's ring is filled. */
	li {
		position: relative;
		display: grid;
		padding-left: 1.4rem;
	}

	li::before {
		content: '';
		position: absolute;
		left: 0;
		top: 0.2rem;
		width: 0.6rem;
		height: 0.6rem;
		border: 2px solid var(--accent);
		border-radius: 50%;
	}

	li:not(:last-child)::after {
		content: '';
		position: absolute;
		left: calc(0.3rem + 1px);
		top: 1.1rem;
		bottom: calc(var(--space-2) * -1);
		width: 1px;
		background: var(--border-strong);
	}

	li.changed::before {
		--changed: light-dark(#7a5000, #e6c07a);
		border-color: var(--changed);
		background: var(--changed);
	}

	.where {
		color: var(--text-muted);
		font-size: 0.75rem;
	}

	.what {
		color: var(--text-strong);
	}

	li.changed .what {
		color: var(--changed);
	}

	.acts {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-2);
		margin-top: var(--space-3);
		padding-top: var(--space-3);
		border-top: 1px solid var(--border-hairline);
	}

	.acts:empty {
		display: none;
	}

	.why {
		color: var(--text-muted);
		font-size: 0.75rem;
	}

	.act {
		padding: 0.2rem 0.6rem;
		border: 1px solid color-mix(in srgb, var(--accent) 45%, transparent);
		border-radius: var(--r-sm);
		color: var(--accent);
		font-size: 0.75rem;
		white-space: nowrap;
	}

	.act:hover {
		border-color: var(--accent);
	}

	button.badge {
		cursor: pointer;
		transition:
			border-color var(--transition),
			color var(--transition);
	}

	button.badge:hover {
		color: var(--glow-color);
		border-color: var(--text-muted);
	}
</style>
