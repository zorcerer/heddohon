<script lang="ts">
	import { goto } from '$app/navigation';
	import Cover from './Cover.svelte';
	import Icon from './Icon.svelte';
	import Sleeve from './Sleeve.svelte';
	import { LAUNCH_MS, sleeveToken, sleeveTransition } from '$lib/client/sleeve-transition.svelte';
	import { ambience } from '$lib/client/ambience.svelte';
	import { warmAlbumCover } from '$lib/client/format';

	let {
		href,
		title,
		subtitle = null,
		coverArt,
		/** Artists are people, not records: they get a plain round portrait. */
		rounded = false,
		transitionId = null,
		onplay = null
	}: {
		href: string;
		title: string;
		subtitle?: string | null;
		coverArt: string | null | undefined;
		rounded?: boolean;
		/** Album id, if this card should carry its sleeve into the next page. */
		transitionId?: string | null;
		/** May return a promise; the button shows it is busy until it settles. */
		onplay?: (() => unknown) | null;
	} = $props();

	let launching = $state(false);

	/*
	 * Play resolves the album or artist to its tracks before anything sounds:
	 * one upstream call for an album, one per album for an artist. Nothing on
	 * screen said the click had landed, and a second click started a second
	 * fetch and a second `playNow`. While it is out the button stays up, ignores
	 * clicks and, past 150ms, turns its icon into a spinner (the delay is in the
	 * CSS, so a fast answer does not flash one).
	 */
	let pending = $state(false);

	async function play() {
		if (pending || !onplay) return;
		pending = true;
		try {
			await onplay();
		} finally {
			pending = false;
		}
	}
	/*
	 * The sleeve tilts a few degrees toward the pointer while it is lifted, as
	 * a record held up to the light would, and settles flat when the pointer
	 * leaves. Written as two numbers on the art; the transform is in CSS, so a
	 * card in flight (`launching`) can drop it before the sleeve is captured.
	 */
	let art = $state<HTMLDivElement | null>(null);
	function tilt(event: PointerEvent) {
		if (!art || event.pointerType !== 'mouse' || rounded) return;
		const box = art.getBoundingClientRect();
		const x = (event.clientX - box.left) / box.width - 0.5;
		const y = (event.clientY - box.top) / box.height - 0.5;
		art.style.setProperty('--tilt-x', (x * 10).toFixed(2));
		art.style.setProperty('--tilt-y', (y * -10).toFixed(2));
	}
	function untilt() {
		art?.style.removeProperty('--tilt-x');
		art?.style.removeProperty('--tilt-y');
	}

	/** Only for a card that opens an album page, which is one carrying a sleeve. */
	function warm() {
		if (transitionId) warmAlbumCover(coverArt);
	}

	// Stable for this card's lifetime, so a duplicate album in another shelf
	// cannot claim the same view-transition-name at the same moment.
	const token = sleeveToken();

	/**
	 * Takes over the anchor's own navigation so the record has time to leave the
	 * sleeve before the page changes. Modified clicks are left alone — opening in
	 * a new tab must keep working, and an animation is no reason to break it.
	 */
	function open(event: MouseEvent) {
		if (!transitionId) return;
		if (event.defaultPrevented) return;
		if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

		event.preventDefault();
		launching = true;
		sleeveTransition.begin(transitionId, token, location.pathname + location.search);
		// This cover is on screen and decoded, so the room can start moving to its
		// colour now rather than when the page it belongs to finishes loading.
		ambience.arriving(coverArt, href);
		setTimeout(() => void goto(href), LAUNCH_MS);
	}
</script>

<!-- Album cards fetch the album page's cover size on the way in; see
     `warmAlbumCover`. -->
<a
	class="card"
	class:portrait={rounded}
	class:launching
	{href}
	onclick={open}
	onpointerenter={warm}
	onfocusin={warm}
	onpointerdown={warm}
	onpointermove={tilt}
	onpointerleave={untilt}
>
	<div class="art" bind:this={art}>
		{#if rounded}
			<Cover {coverArt} rounded size={384} alt="" />
		{:else}
			<Sleeve
				{coverArt}
				size={384}
				alt=""
				{transitionId}
				transitionToken={token}
				{launching}
				radius="var(--r-md)"
			/>
		{/if}
		{#if onplay}
			<button
				class="play"
				class:pending
				onclick={(event) => {
					event.preventDefault();
					event.stopPropagation();
					void play();
				}}
				aria-label="Play {title}"
				aria-busy={pending}
			>
				<span class="glyph"><Icon name="play" size={16} /></span>
				{#if pending}<span class="spinner" aria-hidden="true"></span>{/if}
			</button>
		{/if}
	</div>
	<div class="text">
		<span class="title hh-clamp-2">{title}</span>
		{#if subtitle}
			<span class="subtitle hh-truncate hh-muted">{subtitle}</span>
		{/if}
	</div>
</a>

<style>
	.card {
		display: grid;
		gap: var(--space-3);
		padding: var(--space-2) var(--space-2) var(--space-3);
		border-radius: var(--r-md);
	}

	/* The record slides out past the card's own box, so hovering has to raise the
	   whole card above its neighbours or the disc is clipped by the next one.
	   This changes nothing visible on its own — it is purely stacking. */
	.card:hover,
	.card.launching {
		position: relative;
		z-index: 3;
	}

	/* The lift and the settle back are on the spring: the sleeve is picked up a
	   little past where it rests, and put down the same way. */
	.art {
		position: relative;
		transition:
			transform var(--dur-state) var(--ease-spring),
			scale var(--dur-state) var(--ease-spring),
			filter var(--dur-state) var(--ease-out);
	}

	/* Pressed, the sleeve gives a little under the pointer before the launch
	   takes it. Touch screens get the opacity cue in `app.css`. */
	@media (hover: hover) {
		.card:active:not(.launching) .art {
			scale: 0.97;
			transition-duration: var(--dur-press);
		}
	}

	/*
	 * The hover cue is the sleeve lifting a couple of pixels, not a grey wash
	 * behind the card. A tinted panel under one card fights the single coloured
	 * field the rest of the interface is lit by; moving the thing you are
	 * pointing at does not.
	 */
	.card:hover .art {
		transform: perspective(40rem) rotateY(calc(var(--tilt-x, 0) * 1deg)) rotateX(calc(var(--tilt-y, 0) * 1deg))
			translateY(-0.25rem);
		filter: drop-shadow(0 0.75rem 1.5rem color-mix(in srgb, var(--accent) 38%, transparent));
	}

	/*
	 * Sleek (the light theme): a ring of the pale accent around the cover and
	 * a shade in the page's grey below it, in place of the coloured glow, which
	 * on a pale ground read as a stain. See "Sleek finish" in app.css.
	 */
	:global([data-theme='light']) .card:hover .art {
		filter: drop-shadow(0 0.6rem 0.9rem rgb(54 64 80 / 0.2));
	}

	:global([data-theme='light']) .card:hover .art :global(.cover) {
		box-shadow:
			0 0 0 3px color-mix(in srgb, var(--accent-quiet) 85%, transparent),
			0 0 14px 2px color-mix(in srgb, var(--accent-quiet) 60%, transparent);
	}

	/*
	 * A band of light crosses the cover as it lifts: from off its left edge to
	 * off its right, once per hover. At rest it waits off the left edge with no
	 * transition, so leaving and coming back sweeps again. The cover clips it.
	 */
	.art :global(.cover::after) {
		content: '';
		position: absolute;
		inset: 0;
		border-radius: inherit;
		background: linear-gradient(
			105deg,
			transparent 30%,
			rgb(255 255 255 / 0.2) 48%,
			rgb(255 255 255 / 0.06) 55%,
			transparent 70%
		);
		translate: -130% 0;
		pointer-events: none;
	}

	.card:hover .art :global(.cover::after) {
		translate: 130% 0;
		/* Steady across, on the colour curve: on the out curve the band had
		   crossed most of the cover in the first 130ms. */
		transition: translate 1.1s var(--ease-colour);
	}

	/* A card in flight is handing its sleeve to the next page; leaving an offset
	   on the ancestor would shift the geometry the morph is captured from. */
	.card.launching .art {
		transform: none;
	}

	/* The offset stays — three pixels is a position, not an animation. What goes
	   is the travel between the two positions. */
	@media (prefers-reduced-motion: reduce) {
		.art {
			transition: none;
		}
	}

	.play {
		position: absolute;
		left: 0.55rem;
		bottom: 0.55rem;
		z-index: 2;
		display: grid;
		place-items: center;
		width: 2.25rem;
		height: 2.25rem;
		border-radius: 50%;
		background: var(--text-strong);
		color: var(--bg-base);
		box-shadow: var(--shadow-mid);
		opacity: 0;
		transform: translateY(0.3rem);
		transition:
			opacity var(--dur-hover) var(--ease-out),
			transform var(--dur-state) var(--ease-spring);
		padding-left: 2px;
	}

	/*
	 * The quick-play button shows for the keyboard, and while it is busy, and
	 * not under the pointer: the cover's light and lift are the hover now, and
	 * a click on the card opens the album, whose own Play is one press away.
	 * Hidden, it takes no clicks, so a press on that corner of the cover opens
	 * the album like the rest of it.
	 */
	.play {
		pointer-events: none;
	}

	.play:focus-visible,
	.play.pending {
		opacity: 1;
		transform: translateY(0);
		pointer-events: auto;
	}

	.glyph,
	.spinner {
		grid-area: 1 / 1;
	}

	.glyph {
		display: grid;
	}

	/*
	 * Both halves wait 150ms before they move, so an answer inside that shows
	 * the play icon throughout. The spinner is the one the now-playing panel
	 * uses, at the button's scale.
	 */
	.pending .glyph {
		animation: pending-hide 0s 150ms forwards;
	}

	.spinner {
		width: 1rem;
		height: 1rem;
		margin-left: -2px;
		border-radius: 50%;
		border: 2px solid color-mix(in srgb, currentColor 30%, transparent);
		border-top-color: currentColor;
		opacity: 0;
		animation:
			pending-show 0s 150ms forwards,
			pending-spin 0.7s linear 150ms infinite;
	}

	@keyframes pending-hide {
		to {
			opacity: 0;
		}
	}

	@keyframes pending-show {
		to {
			opacity: 1;
		}
	}

	@keyframes pending-spin {
		to {
			transform: rotate(360deg);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.spinner {
			animation-duration: 0s, 2.4s;
		}
	}

	.text {
		display: grid;
		gap: 0.1rem;
		min-width: 0;
	}

	.portrait .text {
		text-align: center;
	}

	.title {
		color: var(--text-strong);
		font-weight: 550;
		font-size: 0.9375rem;
		line-height: 1.25;
		letter-spacing: -0.01em;
	}

	.subtitle {
		font-size: 0.8125rem;
	}

	/* Three to a row on a phone leaves each card about 110px, where the desktop
	   padding and type took a third of that for margin and two words of title. */
	@media (max-width: 36rem) {
		.card {
			gap: var(--space-2);
			padding: var(--space-1) var(--space-1) var(--space-2);
		}

		.title {
			font-size: 0.8125rem;
		}

		.subtitle {
			font-size: 0.75rem;
		}

		/* No hover on a phone, and at this size the button covered a third of
		   the sleeve. Tapping the card opens the album. */
		.play {
			display: none;
		}
	}
</style>
