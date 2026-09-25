<script lang="ts">
	import type { AudioQuality } from '$lib/types';
	import { formatQuality, qualityDetail } from '$lib/client/format';

	let {
		quality,
		compact = false,
		transcode = null,
		ontoggle = null
	}: {
		quality: AudioQuality;
		compact?: boolean;
		/** What the music server is converting to, when it is. */
		transcode?: { codec: string; bitrateKbps: number } | null;
		/** Given, the badge becomes the control that turns transcoding on and off. */
		ontoggle?: ((next: boolean) => void) | null;
	} = $props();

	/*
	 * What is being delivered, not what is in the library.
	 *
	 * While the music server is converting, the file's own depth and rate are
	 * not what is coming down the wire, and a badge that kept saying FLAC 24/96
	 * over a 192kbps MP3 would be the one piece of the interface that lies.
	 */
	const label = $derived(
		transcode ? `${transcode.codec.toUpperCase()} ${transcode.bitrateKbps}` : formatQuality(quality)
	);
	const detail = $derived(
		transcode
			? `Transcoded by the music server to ${transcode.codec.toUpperCase()} at ${transcode.bitrateKbps} kbps. The file is ${qualityDetail(quality).join(' · ')}.`
			: qualityDetail(quality).join(' · ')
	);
	const action = $derived(
		transcode ? 'Send the original file instead' : 'Ask the music server to transcode'
	);
</script>

{#if label}
	{#if ontoggle}
		<button
			class="badge hh-numeric"
			class:hires={quality.highResolution && !transcode}
			class:lossless={quality.lossless && !quality.highResolution && !transcode}
			class:transcoded={!!transcode}
			class:compact
			type="button"
			title="{detail}&#10;{action}"
			aria-pressed={!!transcode}
			onclick={() => ontoggle(!transcode)}
		>
			{#if quality.highResolution && !compact && !transcode}
				<span class="dot" aria-hidden="true"></span>
			{/if}
			{label}
			<span class="hh-visually-hidden">. {action}</span>
		</button>
	{:else}
		<span
			class="badge hh-numeric"
			class:hires={quality.highResolution && !transcode}
			class:lossless={quality.lossless && !quality.highResolution && !transcode}
			class:transcoded={!!transcode}
			class:compact
			title={detail}
		>
			{#if quality.highResolution && !compact && !transcode}
				<span class="dot" aria-hidden="true"></span>
			{/if}
			{label}
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
		font-size: 0.625rem;
	}

	/* Both from the artwork: lossless as an outline in the accent, hi-res as a
	   filled badge in the stronger accent. Both stay well short of a glow. */
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
	 * Neither of the two quality treatments: a converted stream is not lossless
	 * and certainly not high resolution, and dressing it in either would undo
	 * the point of the badge. A dashed edge says the same thing the label does.
	 */
	.transcoded {
		border-style: dashed;
		border-color: var(--text-faint);
		color: var(--text-muted);
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
