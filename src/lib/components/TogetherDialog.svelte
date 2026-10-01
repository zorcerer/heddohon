<script lang="ts">
	/**
	 * The listen-together link and who is listening, for the host. Mounted once
	 * in the root layout; `client/together.svelte.ts` holds the state.
	 */
	import { together } from '$lib/client/together.svelte';
	import Icon from './Icon.svelte';

	let dialog = $state<HTMLDialogElement | null>(null);
	let copied = $state(false);

	$effect(() => {
		if (!dialog) return;
		if (together.open && together.party && !dialog.open) {
			copied = false;
			dialog.showModal();
		} else if ((!together.open || !together.party) && dialog.open) dialog.close();
	});

	const ends = $derived(
		together.party ? new Date(together.party.expiresAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : ''
	);

	async function copy() {
		try {
			await navigator.clipboard.writeText(together.link);
			copied = true;
		} catch {
			copied = false;
		}
	}
</script>

<dialog bind:this={dialog} onclose={() => (together.open = false)} class="together hh-glass" aria-labelledby="together-title">
	{#if together.party}
		<header>
			<div>
				<span class="hh-eyebrow">Live</span>
				<h2 id="together-title">Listening together</h2>
			</div>
			<button class="close" onclick={() => (together.open = false)} aria-label="Close">
				<Icon name="close" size={18} />
			</button>
		</header>

		<div class="body">
			<p class="hh-muted note">
				Anyone with this link hears what you play, as you play it: the same track, paused and skipped when
				you do. They need no account, and can send a reaction. It ends at {ends}, when you end it, or when you
				sign out.
			</p>
			<p class="hh-muted note">Only share music you have the right to share.</p>

			<span class="link-row">
				<input class="hh-input url" readonly value={together.link} onfocus={(event) => event.currentTarget.select()} spellcheck="false" aria-label="Listen-together link" />
				<button class="hh-button" type="button" onclick={copy}>
					<Icon name={copied ? 'check' : 'copy'} size={15} />
					{copied ? 'Copied' : 'Copy'}
				</button>
			</span>

			<p class="count" role="status">
				<span class="dot" aria-hidden="true"></span>
				{together.listeners === 0
					? 'Nobody else is listening yet'
					: `${together.listeners} listening with you`}
			</p>

			<button class="hh-button end" type="button" onclick={() => void together.end()}>End listening together</button>
		</div>
	{/if}
</dialog>

<style>
	.together {
		width: min(28rem, calc(100vw - 2rem));
		padding: 0;
		border: 1px solid var(--glass-edge);
		border-radius: var(--r-lg);
		color: var(--text-default);
		box-shadow: var(--shadow-high);
	}

	.together::backdrop {
		background: rgb(0 0 0 / 0.45);
		backdrop-filter: blur(2px);
	}

	header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
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
	}

	.close:hover {
		color: var(--glow-color);
	}

	.body {
		display: grid;
		gap: var(--space-3);
		padding: var(--space-4);
	}

	.note {
		margin: 0;
		font-size: 0.8125rem;
		line-height: 1.5;
	}

	.link-row {
		display: flex;
		gap: var(--space-2);
	}

	.url {
		flex: 1;
		min-width: 0;
		font-size: 0.8125rem;
	}

	.link-row .hh-button {
		flex: none;
		padding: 0.45rem 0.8rem;
		border-radius: var(--r-md);
		font-size: 0.8125rem;
	}

	.count {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		margin: 0;
		font-size: 0.875rem;
		color: var(--text-strong);
	}

	.dot {
		width: 0.5rem;
		height: 0.5rem;
		border-radius: 50%;
		background: var(--danger);
	}

	.end {
		justify-self: start;
		padding: 0.45rem 0.9rem;
		border-radius: var(--r-md);
		font-size: 0.8125rem;
	}
</style>
