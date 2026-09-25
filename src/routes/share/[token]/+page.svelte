<script lang="ts">
	/**
	 * A shared song, opened from a link, with or without an account.
	 *
	 * Laid out as the login page is: what this is on the left, one pane of glass
	 * on the right, the crest behind it and the ambient field behind that. The
	 * pane is the player panel at card size, with the artwork running to its top
	 * corners and dissolving into the title, the scrubber and the transport.
	 *
	 * It plays through an audio element of its own. The app's player belongs to
	 * a signed-in account, keeps a queue on the server and reports plays to the
	 * music server, and a visitor here may have no account at all. The audio and
	 * the cover come from this link's own routes, which serve this one song.
	 */
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import {
		applyArtworkColor,
		colorOfImage,
		DEFAULT_ARTWORK_COLOR,
		holdArtworkColor,
		randomArtworkColor
	} from '$lib/client/artwork';
	import { formatDuration } from '$lib/client/format';
	import { prefersReducedMotion } from '$lib/client/sleeve-transition.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import Logo from '$lib/components/Logo.svelte';
	import QualityBadge from '$lib/components/QualityBadge.svelte';
	import Seekbar from '$lib/components/Seekbar.svelte';
	import type { PageData } from './$types';

	const SOURCE_URL = 'https://github.com/zorcerer/heddohon';

	let { data }: { data: PageData } = $props();

	const ready = $derived(data.state === 'ready' ? data : null);
	const song = $derived(ready?.song ?? null);
	const signedIn = $derived(Boolean(data.account));
	const expires = $derived(
		ready
			? new Date(ready.expiresAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
			: null
	);
	const coverSrc = $derived(ready && song?.hasCover ? `${ready.media}/cover?size=512` : null);
	const coverSrcset = $derived(
		ready && song?.hasCover ? `${ready.media}/cover?size=512 1x, ${ready.media}/cover?size=1024 2x` : undefined
	);

	/*
	 * The room's colour. A playable link takes it from its own cover once that
	 * has decoded; anything else draws a hue, as the login page does. It is
	 * held rather than applied so that the layout's own tint, which resolves a
	 * null cover a microtask later, does not put the room back to frost.
	 */
	let heldHue = '';

	function tint(image: HTMLImageElement) {
		const root = document.documentElement;
		holdArtworkColor(root, colorOfImage(image) ?? DEFAULT_ARTWORK_COLOR);
		heldHue = root.style.getPropertyValue('--art-h');
	}

	let coverImage = $state<HTMLImageElement | null>(null);

	onMount(() => {
		const root = document.documentElement;
		/*
		 * A frame late, on purpose. The layout's own tint effect runs after this
		 * page mounts and claims the room for "nothing playing"; held any sooner,
		 * the colour was taken straight back to frost, which is what the first
		 * iPhone 16 capture showed. The cover may also have loaded before the
		 * page hydrated, when its `onload` could not yet run, so it is read here
		 * rather than left to the event.
		 */
		/*
		 * Listened for here rather than with `onload`: Svelte renders `onload` on
		 * an image as an inline handler attribute, which the Content-Security-
		 * Policy refuses.
		 */
		const image = coverImage;
		const onLoad = () => image && tint(image);
		image?.addEventListener('load', onLoad);
		const frame = requestAnimationFrame(() => {
			if (!coverSrc) {
				holdArtworkColor(root, randomArtworkColor());
				heldHue = root.style.getPropertyValue('--art-h');
			} else if (image?.complete && image.naturalWidth > 0) {
				tint(image);
			}
		});
		return () => {
			cancelAnimationFrame(frame);
			image?.removeEventListener('load', onLoad);
			if (root.style.getPropertyValue('--art-h') === heldHue) applyArtworkColor(root, null);
		};
	});

	/*
	 * The login page's coming and going, for the same reasons. The page starts
	 * covered and fades up; leaving it blurs what is behind the glass and lays
	 * the veil back over the top before the navigation is applied.
	 */
	let phase = $state<'arriving' | 'idle' | 'leaving'>('arriving');
	const leaving = $derived(phase === 'leaving');
	const LEAVE_MS = 380;

	async function go(event: MouseEvent, href: string): Promise<void> {
		if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
		event.preventDefault();
		audio?.pause();
		phase = 'leaving';
		if (!prefersReducedMotion()) await new Promise((resolve) => setTimeout(resolve, LEAVE_MS));
		await goto(href);
	}

	// ── Playback ──────────────────────────────────────────────────────────

	let audio = $state<HTMLAudioElement | null>(null);
	let paused = $state(true);
	let time = $state(0);
	let length = $state(0);
	let muted = $state(false);
	let waiting = $state(false);
	let failed = $state(false);
	let bufferedTo = $state(0);

	const total = $derived(length > 0 ? length : (song?.duration ?? 0));

	async function toggle() {
		if (!audio) return;
		failed = false;
		if (audio.paused) {
			try {
				await audio.play();
			} catch {
				// A refused play() leaves the element paused, which the button shows.
			}
		} else {
			audio.pause();
		}
	}

	function seek(seconds: number) {
		if (!audio) return;
		try {
			audio.currentTime = seconds;
		} catch {
			// Before metadata has loaded there is nothing to seek within.
		}
		if (audio.paused) void toggle();
	}

	function restart() {
		seek(0);
	}

	/* An attachment and not `onerror`, for the reason given on the cover. */
	function watchFailure(element: HTMLAudioElement) {
		const fail = () => {
			failed = true;
			waiting = false;
		};
		element.addEventListener('error', fail);
		return () => element.removeEventListener('error', fail);
	}

	function readBuffered() {
		if (!audio || audio.buffered.length === 0) return;
		bufferedTo = audio.buffered.end(audio.buffered.length - 1);
	}

	/*
	 * The lock screen and the headset buttons. A phone pausing a song shared in
	 * a message and picking it up from the lock screen is the ordinary case for
	 * this page, and without metadata the lock screen names the tab instead.
	 */
	$effect(() => {
		if (!song || !('mediaSession' in navigator)) return;
		navigator.mediaSession.metadata = new MediaMetadata({
			title: song.title,
			artist: song.artist ?? '',
			album: song.album ?? '',
			artwork: coverSrc ? [{ src: coverSrc, sizes: '512x512' }] : []
		});
		navigator.mediaSession.setActionHandler('play', () => void toggle());
		navigator.mediaSession.setActionHandler('pause', () => audio?.pause());
		return () => {
			navigator.mediaSession.metadata = null;
			navigator.mediaSession.setActionHandler('play', null);
			navigator.mediaSession.setActionHandler('pause', null);
		};
	});

	function onKeydown(event: KeyboardEvent) {
		if (!song || event.code !== 'Space') return;
		const target = event.target as HTMLElement | null;
		if (target?.closest('button, a, input, [role="slider"]')) return;
		event.preventDefault();
		void toggle();
	}
</script>

<svelte:window onkeydown={onKeydown} />

<svelte:head>
	<title>{song ? `${song.title}${song.artist ? ` · ${song.artist}` : ''}` : 'Shared link'} · {data.appName}</title>
	<meta name="robots" content="noindex, nofollow" />
</svelte:head>

<div class="hh-ambience" aria-hidden="true"></div>

{#if phase !== 'idle'}
	<div
		class="veil hh-ambience"
		class:closing={leaving}
		aria-hidden="true"
		onanimationend={() => {
			if (phase === 'arriving') phase = 'idle';
		}}
	></div>
{/if}

<div class="crest-field" class:leaving aria-hidden="true">
	<Logo size={640} />
</div>

<main class="stage">
	<aside class="intro" class:leaving>
		<div class="lockup">
			<Logo size={52} />
			<p class="wordmark">{data.appName}</p>
		</div>

		<h1 class="lede">
			{#if ready?.ownLink}
				A song you shared.
			{:else if ready?.sharedBy}
				<strong>{ready.sharedBy}</strong> shared a song with you.
			{:else if song}
				A song, shared with you.
			{:else}
				A shared link.
			{/if}
		</h1>

		{#if expires}
			<p class="assurance">
				<span class="hh-eyebrow">Shared link</span>
				<span class="hh-muted">Anyone with this link can listen here until {expires}.</span>
			</p>
		{/if}
	</aside>

	{#if ready && song}
		<article class="card hh-glass hh-glass--deep hh-float" aria-label="Shared song">
			<div class="art" aria-hidden="true">
				{#if coverSrc}
					<img bind:this={coverImage} src={coverSrc} srcset={coverSrcset} alt="" decoding="async" />
				{:else}
					<span class="placeholder"><Icon name="album" size={72} strokeWidth={1.2} /></span>
				{/if}
			</div>

			<div class="chrome">
				<div class="text">
					<h2 class="title hh-clamp-2">{song.title}</h2>
					<p class="artist hh-truncate">{song.artist ?? 'Unknown artist'}</p>
					{#if song.album}
						<p class="album hh-truncate hh-muted">{song.album}{song.year ? ` · ${song.year}` : ''}</p>
					{/if}
				</div>

				<div class="scrub">
					<Seekbar
						value={time}
						max={total}
						buffered={bufferedTo}
						onseek={seek}
						ariaLabel="Seek within track"
						formatValue={(value) => formatDuration(value)}
					/>
					<div class="times">
						<span class="hh-numeric">{formatDuration(time)}</span>
						<QualityBadge quality={song.quality} compact />
						<span class="hh-numeric right">−{formatDuration(Math.max(0, total - time))}</span>
					</div>
				</div>

				<div class="transport">
					<button class="edge" onclick={restart} aria-label="Back to the start" title="Back to the start">
						<Icon name="previous" size={22} />
					</button>

					<button
						class="play"
						onclick={() => void toggle()}
						aria-label={paused ? 'Play' : 'Pause'}
						title={paused ? 'Play' : 'Pause'}
					>
						{#if waiting && !paused}
							<span class="spinner" aria-hidden="true"></span>
						{:else}
							<Icon name={paused ? 'play' : 'pause'} size={30} strokeWidth={3.4} />
						{/if}
					</button>

					<button
						class="edge"
						class:on={muted}
						onclick={() => (muted = !muted)}
						aria-pressed={muted}
						aria-label={muted ? 'Unmute' : 'Mute'}
						title={muted ? 'Unmute' : 'Mute'}
					>
						<Icon name={muted ? 'mute' : 'volume'} size={20} />
					</button>
				</div>

				{#if failed}
					<p class="error" role="alert">
						This song could not be played. The link may have expired or been withdrawn.
					</p>
				{/if}
			</div>

			<!--
				Nothing loads until play is pressed: the file can be a hundred
				megabytes of FLAC, and a link opened to see what it is should not cost
				that. `crossorigin` is unset on purpose, as it is on the app's own
				elements; the stream is same-origin.
			-->
			<audio
				bind:this={audio}
				src="{ready.media}/stream"
				preload="none"
				bind:paused
				bind:currentTime={time}
				bind:duration={length}
				bind:muted
				onwaiting={() => (waiting = true)}
				onplaying={() => (waiting = false)}
				onprogress={readBuffered}
				{@attach watchFailure}
			></audio>
		</article>
		<p class="expiry hh-muted">Anyone with this link can listen until {expires}.</p>
	{:else}
		<div class="panel hh-glass hh-float">
			<header>
				{#if data.state === 'disabled'}
					<h2>Sharing is turned off</h2>
					<p class="hh-muted sub">This server does not open shared links at the moment.</p>
				{:else if data.state === 'unavailable'}
					<h2>This song is not available</h2>
					<p class="hh-muted sub">
						The music server no longer returns it for this link. It may have been removed.
					</p>
				{:else}
					<h2>This link no longer works</h2>
					<p class="hh-muted sub">It has expired or been withdrawn. Ask whoever sent it for a new one.</p>
				{/if}
			</header>
		</div>
	{/if}

	<footer class="colophon">
		{#if signedIn}
			<a class="onward" href="/" onclick={(event) => void go(event, '/')}>
				<span>Continue to your library</span>
				<Icon name="chevron-right" size={16} />
			</a>
		{:else}
			<!-- `noreferrer`, so this page's address, which holds the token, is not
			     sent along. The referrer policy would already hold it back. -->
			<a class="onward" href={SOURCE_URL} target="_blank" rel="noopener noreferrer">
				<Icon name="github" size={16} />
				<span>Shared with Heddohon</span>
			</a>
		{/if}
	</footer>
</main>

<style>
	/* ── The room: the login page's stage, veil and crest ────────────── */

	.stage {
		position: relative;
		z-index: 1;
		min-height: 100vh;
		min-height: 100dvh;
		display: grid;
		align-content: center;
		justify-content: center;
		gap: var(--space-6) var(--space-7);
		padding: var(--space-6) var(--space-5);
		grid-template-columns: minmax(0, 23rem) minmax(0, 23rem);
		grid-template-areas:
			'intro card'
			'colophon colophon';
	}

	/* Rests at 0 and is animated from 1, so a browser that never runs the
	   animation is not left behind an opaque sheet. */
	.veil.hh-ambience {
		z-index: 60;
		opacity: 0;
		animation: veil-out var(--dur-travel) var(--ease-out) forwards;
	}

	.veil.closing {
		animation: veil-in var(--dur-state) var(--ease-out) forwards;
	}

	@keyframes veil-out {
		from {
			opacity: 1;
		}
		to {
			opacity: 0;
		}
	}

	@keyframes veil-in {
		to {
			opacity: 1;
		}
	}

	/* The blur goes on what is behind the glass and never on an ancestor of it,
	   which would make that ancestor the card's backdrop root. */
	.crest-field.leaving,
	.intro.leaving {
		animation: soften var(--dur-state) var(--ease-out) both;
	}

	@keyframes soften {
		to {
			filter: blur(16px);
		}
	}

	.crest-field {
		position: fixed;
		inset: 0;
		z-index: 0;
		overflow: hidden;
		pointer-events: none;
		color: var(--accent);
		opacity: 0.14;
		-webkit-mask-image: linear-gradient(to right, transparent 0%, #000 38%);
		mask-image: linear-gradient(to right, transparent 0%, #000 38%);
	}

	.crest-field :global(svg) {
		position: absolute;
		top: 50%;
		left: 68%;
		translate: -50% -50%;
		width: clamp(28rem, 62vw, 50rem) !important;
		height: auto !important;
	}

	:global([data-theme='light']) .crest-field {
		opacity: 0.09;
	}

	/* ── Left column ──────────────────────────────────────────────────── */

	.intro {
		grid-area: intro;
		align-self: center;
		display: grid;
		justify-items: start;
		gap: var(--space-4);
	}

	.lockup {
		display: flex;
		align-items: center;
		gap: var(--space-4);
		color: var(--accent);
	}

	.wordmark {
		margin: 0;
		font-family: var(--font-display);
		font-weight: var(--display-weight);
		letter-spacing: var(--display-tracking);
		font-size: clamp(2.5rem, 6vw, 3.5rem);
		line-height: 1;
		color: var(--text-strong);
	}

	/* The sentence the page exists to say, so it is the heading. */
	.lede {
		margin: 0;
		max-width: 22rem;
		font-size: 1.125rem;
		font-weight: 500;
		line-height: 1.4;
		color: var(--text-muted);
	}

	.lede strong {
		color: var(--text-strong);
		font-weight: 700;
	}

	.assurance {
		margin: var(--space-2) 0 0;
		max-width: 22rem;
		display: grid;
		gap: var(--space-1);
		font-size: 0.8125rem;
		padding-left: var(--space-4);
		border-left: 1px solid var(--border-hairline);
	}

	/* ── The card: the player panel at card size ──────────────────────── */

	.card {
		grid-area: card;
		display: flex;
		flex-direction: column;
		overflow: hidden;
	}

	/*
	 * Slightly taller than wide, as the panel's stage usually is, so the cover is
	 * cropped in a little. It dissolves into the controls by masking the artwork
	 * rather than painting over it: the card's ground is translucent and changes
	 * with the room, so a painted gradient would show as a band.
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
		aspect-ratio: 1 / 0.92;
		-webkit-mask-image: linear-gradient(to bottom, #000 0%, #000 68%, transparent 100%);
		mask-image: linear-gradient(to bottom, #000 0%, #000 68%, transparent 100%);
	}

	.art img {
		display: block;
		width: 100%;
		height: 100%;
		object-fit: cover;
		border-radius: var(--r-xl) var(--r-xl) 0 0;
	}

	.placeholder {
		display: grid;
		place-items: center;
		width: 100%;
		height: 100%;
		background: var(--bg-sunken);
		color: var(--text-faint);
	}

	.chrome {
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
		padding: var(--space-4);
		margin-top: calc(var(--space-6) * -1);
		position: relative;
	}

	.text {
		min-width: 0;
	}

	.title {
		margin: 0;
		font-size: 1.375rem;
		line-height: 1.15;
		letter-spacing: -0.015em;
		color: var(--text-strong);
		text-shadow: var(--text-shade);
	}

	.artist,
	.album {
		margin: 0.15rem 0 0;
		font-size: 0.9375rem;
	}

	.artist {
		color: var(--text-default);
	}

	.scrub {
		display: grid;
		gap: var(--space-2);
	}

	.times {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
		align-items: center;
		gap: var(--space-2);
		font-size: 0.75rem;
		color: var(--text-faint);
	}

	.times .right {
		text-align: right;
	}

	.transport {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 0 var(--space-4);
	}

	.edge,
	.play {
		display: grid;
		place-items: center;
		transition:
			color var(--transition),
			filter var(--transition),
			background var(--transition);
	}

	.edge {
		width: 2.75rem;
		height: 2.75rem;
		border-radius: var(--r-md);
		color: var(--text-faint);
	}

	.edge.on {
		color: var(--accent);
	}

	.edge:hover {
		color: var(--glow-color);
		filter: var(--glow-icon);
	}

	/* The one filled control on the card: the accent disc is what says this is
	   the thing to press, where the panel's play glyph sits among others. */
	.play {
		width: 4rem;
		height: 4rem;
		border-radius: 50%;
		background: var(--accent);
		color: var(--accent-contrast);
		box-shadow: 0 10px 26px -12px color-mix(in srgb, var(--accent) 80%, transparent);
	}

	.play:hover {
		background: var(--accent-strong);
	}

	.spinner {
		width: 1.5rem;
		height: 1.5rem;
		border-radius: 50%;
		border: 2px solid color-mix(in srgb, currentColor 30%, transparent);
		border-top-color: currentColor;
		animation: spin 0.7s linear infinite;
	}

	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}

	.error {
		margin: 0;
		font-size: 0.8125rem;
		color: var(--danger);
	}

	audio {
		display: none;
	}

	/* The assurance's expiry, under the card, where a phone puts it. */
	.expiry {
		display: none;
		grid-area: expiry;
		margin: 0;
		font-size: 0.8125rem;
		text-align: center;
	}

	/* ── The pane for a link that cannot be played: the login panel ──── */

	.panel {
		grid-area: card;
		align-self: center;
		padding: var(--space-6);
	}

	.panel h2 {
		font-size: 1.375rem;
		margin: 0;
	}

	.sub {
		margin: var(--space-2) 0 0;
		font-size: 0.875rem;
	}

	/* ── Footer ───────────────────────────────────────────────────────── */

	.colophon {
		grid-area: colophon;
		display: grid;
		justify-items: center;
	}

	.onward {
		display: inline-flex;
		align-items: center;
		gap: var(--space-2);
		font-size: 0.8125rem;
		color: var(--text-faint);
		text-decoration: none;
		padding: var(--space-2) var(--space-3);
		border-radius: var(--r-pill);
		transition:
			color var(--transition),
			text-shadow var(--transition);
	}

	.onward:hover,
	.onward:focus-visible {
		color: var(--glow-color);
		text-shadow: var(--glow-text);
	}

	@media (prefers-reduced-motion: reduce) {
		.spinner {
			animation-duration: 2.4s;
		}
	}

	/* One column, as the login page folds, with the crest behind the middle. */
	@media (max-width: 56rem) {
		.stage {
			grid-template-columns: minmax(0, 23rem);
			grid-template-areas:
				'intro'
				'card'
				'colophon';
			gap: var(--space-5);
			align-content: start;
			padding-top: var(--space-6);
		}

		.wordmark {
			font-size: 2.25rem;
		}

		.lockup {
			gap: var(--space-3);
		}

		.crest-field {
			opacity: 0.1;
			-webkit-mask-image: linear-gradient(to bottom, transparent 0%, #000 32%);
			mask-image: linear-gradient(to bottom, transparent 0%, #000 32%);
		}

		.crest-field :global(svg) {
			left: 50%;
			top: 46%;
			width: min(34rem, 128vw) !important;
		}
	}

	/*
	 * A phone. The whole card has to sit on one screen with the play button in
	 * reach of a thumb, which the tablet arrangement above does not do: on an
	 * iPhone 16 (393x852) the square artwork alone was 332px tall and pushed the
	 * transport under Safari's toolbar.
	 *
	 * The artwork becomes a band whose height follows the screen's, the name
	 * and the sentence share one line at the top, and the expiry, which is the
	 * least urgent thing on the page, goes to a line under the card.
	 */
	@media (max-width: 36rem) {
		.stage {
			gap: var(--space-4);
			/* Centred when the screen has room to spare, as the login page is;
			   measured at 560px of content on an 852px iPhone 16. */
			align-content: center;
			padding: var(--space-4) var(--space-4) var(--space-3);
			grid-template-columns: minmax(0, 1fr);
			grid-template-areas:
				'intro'
				'card'
				'expiry'
				'colophon';
		}

		.intro {
			gap: var(--space-2);
		}

		.lockup {
			gap: var(--space-2);
		}

		.lockup :global(svg) {
			width: 1.75rem !important;
			height: 1.75rem !important;
		}

		.wordmark {
			font-size: 1.375rem;
		}

		.lede {
			font-size: 1rem;
			max-width: none;
		}

		.assurance {
			display: none;
		}

		.expiry {
			display: block;
		}

		.art {
			aspect-ratio: auto;
			height: clamp(8.5rem, 27dvh, 14rem);
		}

		.chrome {
			gap: var(--space-3);
			padding: var(--space-4);
			margin-top: calc(var(--space-5) * -1);
		}

		.title {
			font-size: 1.25rem;
		}

		.artist,
		.album {
			font-size: 0.875rem;
		}

		.play {
			width: 3.5rem;
			height: 3.5rem;
		}

		.panel {
			padding: var(--space-5);
		}
	}
</style>
