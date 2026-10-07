<script lang="ts">
	/**
	 * Starts an instant mix: the queue replaced with what the music server
	 * finds like a song, an album or an artist.
	 *
	 * The button reports the outcome itself: the interface has no other place
	 * for a passing message. On Navidrome without an external agent every mix
	 * is empty, and the button says so for four seconds, with the queue left as
	 * it was. The label is a live region, for a screen reader.
	 */
	import { playInstantMix } from '$lib/client/actions';
	import type { MixSeed } from '$lib/types';
	import Icon from './Icon.svelte';

	let {
		of,
		id,
		label = 'Instant mix',
		variant = 'button'
	}: {
		of: MixSeed;
		id: string;
		label?: string;
		/** A glass button among the page's actions, or a line of text among the player's track facts. */
		variant?: 'button' | 'inline';
	} = $props();

	let status = $state<'idle' | 'busy' | 'empty' | 'failed'>('idle');
	let timer: ReturnType<typeof setTimeout> | undefined;

	async function start() {
		if (status === 'busy') return;
		clearTimeout(timer);
		status = 'busy';
		try {
			status = (await playInstantMix(of, id)) ? 'idle' : 'empty';
		} catch {
			status = 'failed';
		}
		if (status !== 'idle') timer = setTimeout(() => (status = 'idle'), 4000);
	}

	$effect(() => () => clearTimeout(timer));

	const text = $derived(
		status === 'busy'
			? 'Finding similar music…'
			: status === 'empty'
				? 'Nothing similar on your music server'
				: status === 'failed'
					? 'The music server did not answer'
					: label
	);
</script>

<button
	class={variant === 'button' ? 'hh-button mix' : 'mix inline'}
	class:quiet={status === 'empty' || status === 'failed'}
	class:talking={status !== 'idle'}
	type="button"
	onclick={start}
	aria-busy={status === 'busy'}
	title={label}
>
	<Icon name="radio" size={16} />
	<span class="label" aria-live="polite">{text}</span>
</button>

<style>
	.mix {
		white-space: nowrap;
	}

	/* The same size and corners as the actions it sits among on the album and
	   artist pages, which size theirs in their own scoped styles. */
	.hh-button.mix {
		padding: 0.55rem 1.05rem;
		border-radius: var(--r-md);
	}

	/* An icon among icons on a phone, as the album page's other actions are,
	   until it has something to say: then the words show for their four
	   seconds, and the row makes room. */
	@media (max-width: 36rem) {
		.hh-button.mix:not(.talking) {
			width: 2.75rem;
			height: 2.75rem;
			padding: 0;
			justify-content: center;
		}

		.hh-button.mix:not(.talking) .label {
			position: absolute;
			width: 1px;
			height: 1px;
			overflow: hidden;
			clip-path: inset(50%);
			white-space: nowrap;
		}

		.hh-button.mix :global(svg) {
			width: 1.25rem !important;
			height: 1.25rem !important;
		}
	}

	.mix[aria-busy='true'] {
		cursor: progress;
	}

	.mix.quiet {
		color: var(--text-muted);
	}

	/* Beside the download link in the player's track facts, and styled as it is. */
	.inline {
		display: inline-flex;
		align-items: center;
		gap: var(--space-2);
		padding: 0;
		font-size: 0.75rem;
		color: var(--text-muted);
		transition:
			color var(--transition),
			text-shadow var(--transition);
	}

	.inline:hover {
		color: var(--glow-color);
		text-shadow: var(--glow-text);
	}
</style>
