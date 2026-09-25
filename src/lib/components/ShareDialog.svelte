<script lang="ts">
	/**
	 * The share dialog. Mounted once in the root layout and opened with a song.
	 *
	 * Drawn as a small copy of the player panel: the cover runs to the dialog's
	 * top corners and dissolves into the controls, with the title block under
	 * it. The controls below borrow the login panel's: options as bordered rows
	 * the accent fills when chosen, one primary button, and the same sweep along
	 * its bottom edge while the server answers.
	 */
	import { shareComposer, SHARE_LIFETIMES } from '$lib/client/share.svelte';
	import Cover from './Cover.svelte';
	import Icon from './Icon.svelte';

	let dialog = $state<HTMLDialogElement | null>(null);
	let field = $state<HTMLInputElement | null>(null);

	const song = $derived(shareComposer.song);
	const link = $derived(shareComposer.link);

	$effect(() => {
		if (!dialog) return;
		if (shareComposer.visible && !dialog.open) dialog.showModal();
		else if (!shareComposer.visible && dialog.open) dialog.close();
	});

	// The link arrives selected, so a copy the clipboard refused is one keystroke.
	$effect(() => {
		if (link && field) {
			field.focus();
			field.select();
		}
	});

	const expires = $derived(
		link
			? new Date(link.expiresAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
			: ''
	);
</script>

<dialog
	bind:this={dialog}
	onclose={() => shareComposer.close()}
	class="share hh-glass hh-glass--deep"
	aria-labelledby="share-title"
>
	{#if song}
		<div class="art" aria-hidden="true">
			<Cover coverArt={song.coverArt} size={384} alt="" radius="var(--r-xl) var(--r-xl) 0 0" hidpi fill />
		</div>

		<button class="close" onclick={() => shareComposer.close()} aria-label="Close" title="Close">
			<Icon name="close" size={18} />
		</button>

		<div class="chrome">
			<header>
				<span class="hh-eyebrow">Share a song</span>
				<h2 id="share-title" class="title hh-clamp-2">{song.title}</h2>
				<p class="artist hh-truncate hh-muted">{song.artist ?? 'Unknown artist'}</p>
			</header>

			{#if shareComposer.error}
				<p class="alert" role="alert">{shareComposer.error}</p>
			{/if}

			{#if !link}
				<form
					onsubmit={(event) => {
						event.preventDefault();
						void shareComposer.create();
					}}
				>
					<fieldset class="lifetimes">
						<legend class="hh-eyebrow">The link works for</legend>
						{#each SHARE_LIFETIMES as option (option.days)}
							<label class="lifetime" class:selected={shareComposer.days === option.days}>
								<input
									type="radio"
									name="days"
									value={option.days}
									bind:group={shareComposer.days}
									class="hh-visually-hidden"
								/>
								<span>{option.label}</span>
							</label>
						{/each}
					</fieldset>

					<p class="note hh-muted">
						Anyone who has the link can listen, without an account. It plays through your account on
						the music server, and opens this song and nothing else in your library.
					</p>

					<p class="rights">
						<Icon name="info" size={15} />
						<span>
							Only share music you have the right to share. Sending a song to a friend is not the same
							as posting it publicly, and a link anyone can open may infringe the artist's copyright.
						</span>
					</p>

					<button
						class="hh-button hh-button--primary submit"
						class:busy={shareComposer.busy}
						type="submit"
						disabled={shareComposer.busy}
					>
						<Icon name="link" size={16} />
						{shareComposer.busy ? 'Making the link…' : 'Create link'}
					</button>
				</form>
			{:else}
				<div class="made">
					<label class="field">
						<span class="hh-eyebrow label">Link</span>
						<span class="link-row">
							<input
								bind:this={field}
								class="hh-input url"
								readonly
								value={link.url}
								onfocus={(event) => event.currentTarget.select()}
								spellcheck="false"
							/>
							<button
								class="copy"
								class:done={shareComposer.copied}
								type="button"
								onclick={() => void shareComposer.copy()}
								aria-label={shareComposer.copied ? 'Copied' : 'Copy link'}
								title={shareComposer.copied ? 'Copied' : 'Copy link'}
							>
								<Icon name={shareComposer.copied ? 'check' : 'copy'} size={17} />
							</button>
						</span>
					</label>

					<p class="status" role="status">
						{shareComposer.copied ? 'Copied to the clipboard.' : 'Select the link above to copy it.'}
					</p>

					<p class="note hh-muted">
						Works until {expires}. This is the only time the link is shown: the server keeps a
						fingerprint of it, not the link. Withdraw it at any time from Settings.
					</p>

					<button class="hh-button submit" type="button" onclick={() => shareComposer.close()}>
						Done
					</button>
				</div>
			{/if}
		</div>
	{/if}
</dialog>

<style>
	.share {
		width: min(24rem, calc(100vw - 2rem));
		max-height: calc(100dvh - 2rem);
		padding: 0;
		border: 1px solid var(--glass-edge);
		border-radius: var(--r-xl);
		color: var(--text-default);
		box-shadow: var(--shadow-high);
		overflow-y: auto;
		overflow-x: hidden;
	}

	.share::backdrop {
		background: rgb(0 0 0 / 0.45);
		backdrop-filter: blur(2px);
	}

	/*
	 * The player panel's artwork, shortened. The cover is square and this box is
	 * wider than tall, so it shows the middle band of the sleeve, and it fades
	 * into the controls by taking the artwork away rather than painting over it,
	 * which is what the panel does and for the same reason: the dialog's own
	 * ground changes with the room behind it.
	 */
	/* Dither over the artwork so its fade does not step; see `--grain` in app.css. */
	.art::after {
		content: '';
		position: absolute;
		inset: 0;
		background: var(--grain) 0 0 / var(--grain-size) var(--grain-size) repeat;
		pointer-events: none;
	}

	.art {
		position: relative;
		height: 11rem;
		-webkit-mask-image: linear-gradient(to bottom, #000 0%, #000 55%, transparent 100%);
		mask-image: linear-gradient(to bottom, #000 0%, #000 55%, transparent 100%);
	}

	/* The panel's round control, over the artwork's corner. */
	.close {
		position: absolute;
		top: var(--space-3);
		right: var(--space-3);
		width: 2.25rem;
		height: 2.25rem;
		border-radius: 50%;
		display: grid;
		place-items: center;
		background: var(--control-face);
		-webkit-backdrop-filter: var(--control-blur);
		backdrop-filter: var(--control-blur);
		border: 1px solid var(--border-strong);
		color: var(--text-muted);
		transition:
			color var(--transition),
			filter var(--transition);
	}

	.close:hover {
		color: var(--glow-color);
		filter: var(--glow-icon);
	}

	.chrome {
		display: grid;
		gap: var(--space-4);
		padding: 0 var(--space-5) var(--space-5);
		/* Up into the fade, so the title sits where the artwork is dissolving,
		   as it does in the panel. */
		margin-top: calc(var(--space-6) * -1);
		position: relative;
	}

	header {
		display: grid;
		gap: 0.15rem;
	}

	.title {
		margin: 0.2rem 0 0;
		font-size: 1.375rem;
		line-height: 1.15;
		letter-spacing: -0.015em;
		color: var(--text-strong);
		text-shadow: var(--text-shade);
	}

	.artist {
		margin: 0;
		font-size: 0.9375rem;
	}

	.alert {
		margin: 0;
		background: color-mix(in srgb, var(--danger) 14%, var(--bg-sunken));
		border: 1px solid color-mix(in srgb, var(--danger) 45%, transparent);
		border-radius: var(--r-sm);
		padding: var(--space-3) var(--space-4);
		font-size: 0.875rem;
		color: var(--text-strong);
	}

	form,
	.made {
		display: grid;
		gap: var(--space-4);
	}

	/* The login page's server choice, laid out as a row of three. */
	.lifetimes {
		border: none;
		padding: 0;
		margin: 0;
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: var(--space-2);
	}

	.lifetimes legend {
		margin-bottom: var(--space-2);
		padding: 0;
	}

	.lifetime {
		display: grid;
		place-items: center;
		padding: 0.55rem 0.5rem;
		border: 1px solid var(--field-edge);
		border-radius: var(--r-sm);
		background: var(--field-face);
		-webkit-backdrop-filter: var(--field-blur);
		backdrop-filter: var(--field-blur);
		font-size: 0.875rem;
		font-weight: 600;
		color: var(--text-strong);
		cursor: pointer;
		transition:
			border-color var(--transition),
			background var(--transition);
	}

	.lifetime:hover {
		border-color: var(--border-strong);
	}

	.lifetime.selected {
		border-color: var(--accent);
		background: color-mix(in srgb, var(--accent) 10%, var(--bg-sunken));
	}

	/* The radio is hidden, so the keyboard focus has to be drawn on its label. */
	.lifetime:has(:focus-visible) {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}

	.note {
		margin: 0;
		font-size: 0.8125rem;
	}

	/* Set apart from the note above it without raising its voice: the warning
	   tone, at the size of the rest of the small print. */
	.rights {
		margin: 0;
		display: grid;
		grid-template-columns: auto minmax(0, 1fr);
		gap: var(--space-2);
		align-items: start;
		padding: var(--space-2) var(--space-3);
		border-radius: var(--r-sm);
		border: 1px solid color-mix(in srgb, var(--warning) 35%, transparent);
		background: color-mix(in srgb, var(--warning) 8%, transparent);
		font-size: 0.75rem;
		line-height: 1.45;
		color: var(--text-default);
	}

	.rights :global(svg) {
		margin-top: 0.1rem;
		color: var(--warning);
	}

	.field {
		display: grid;
		gap: var(--space-2);
	}

	.field .label {
		color: var(--accent);
	}

	.link-row {
		display: flex;
		gap: var(--space-2);
	}

	/* The login page's focus ring, on a field that holds the focus from the
	   moment it appears. */
	.url {
		flex: 1;
		min-width: 0;
		font-family: var(--font-mono);
		font-size: 0.8125rem;
		box-shadow: 0 0 0 0 color-mix(in srgb, var(--accent) 20%, transparent);
		transition:
			border-color var(--transition),
			box-shadow var(--transition);
	}

	.url:focus {
		box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 20%, transparent);
	}

	.copy {
		flex: none;
		width: 2.75rem;
		border-radius: var(--r-sm);
		display: grid;
		place-items: center;
		background: var(--control-face);
		-webkit-backdrop-filter: var(--control-blur);
		backdrop-filter: var(--control-blur);
		border: 1px solid var(--border-strong);
		color: var(--text-muted);
		transition:
			color var(--transition),
			filter var(--transition),
			border-color var(--transition);
	}

	.copy:hover {
		color: var(--glow-color);
		filter: var(--glow-icon);
	}

	.copy.done {
		color: var(--positive);
		border-color: color-mix(in srgb, var(--positive) 50%, transparent);
	}

	.status {
		margin: calc(var(--space-2) * -1) 0 0;
		font-size: 0.8125rem;
		color: var(--text-default);
	}

	.submit {
		padding: 0.7rem 1rem;
		border-radius: var(--r-md);
		gap: var(--space-2);
	}

	.submit:disabled {
		opacity: 0.65;
		cursor: progress;
	}

	/* The login page's indeterminate bar. Drawn on a pseudo-element so that the
	   thing moving is an opaque bar, not a button with a backdrop-filter. */
	.busy {
		position: relative;
		overflow: hidden;
	}

	.busy::after {
		content: '';
		position: absolute;
		left: 0;
		bottom: 0;
		width: 40%;
		height: 2px;
		background: var(--accent-contrast);
		opacity: 0.6;
		animation: sweep 1.15s cubic-bezier(0.65, 0, 0.35, 1) infinite;
	}

	/* A phone: a shorter band of artwork, so the button stays on screen under
	   Safari's toolbars, which leave 659px of an iPhone 16's 852. */
	@media (max-width: 36rem) {
		.art {
			height: 8rem;
		}

		.chrome {
			padding: 0 var(--space-4) var(--space-4);
			gap: var(--space-3);
		}
	}

	@keyframes sweep {
		from {
			transform: translateX(-100%);
		}
		to {
			transform: translateX(350%);
		}
	}
</style>
