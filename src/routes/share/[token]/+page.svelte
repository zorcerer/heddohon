<script lang="ts">
	/**
	 * A shared song, opened from a link, with or without an account.
	 *
	 * Laid out as the login page is: what this is on the left, one pane of
	 * glass on the right, the crest behind it and the ambient field behind
	 * that. The pane is the player panel at card size, the artwork running to
	 * its top corners and dissolving into the title, the scrubber and the
	 * transport.
	 *
	 * It plays through its own audio element. The app's player belongs to a
	 * signed-in account, keeps a queue on the server and reports plays, and a
	 * visitor here may have no account. The audio and the cover come from this
	 * link's own routes.
	 */
	import { onMount, tick } from 'svelte';
	import { goto } from '$app/navigation';
	import {
		applyArtworkColor,
		colorOfImage,
		DEFAULT_ARTWORK_COLOR,
		holdArtworkColor,
		randomArtworkColor
	} from '$lib/client/artwork';
	import { formatDuration } from '$lib/client/format';
	import { skipGlyph } from '$lib/client/motion';
	import { prefersReducedMotion } from '$lib/client/sleeve-transition.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import Logo from '$lib/components/Logo.svelte';
	import QualityBadge from '$lib/components/QualityBadge.svelte';
	import Seekbar from '$lib/components/Seekbar.svelte';
	import type { PageData } from './$types';

	const SOURCE_URL = 'https://github.com/zorcerer/heddohon';

	let { data }: { data: PageData } = $props();

	const ready = $derived(data.state === 'ready' ? data : null);
	/*
	 * A song link is a list of one. An album or playlist link plays its tracks
	 * in order from the one chosen, each fetched by its position in the list,
	 * the only thing the page asks the link for.
	 */
	const tracks = $derived(ready?.tracks ?? []);
	const many = $derived(tracks.length > 1);
	let current = $state(0);
	const song = $derived(tracks[current] ?? null);
	const noun = $derived(ready?.item.kind ?? 'song');
	const aNoun = $derived(noun === 'album' ? 'an album' : `a ${noun}`);

	/** The fold of the playing track's facts, behind the info button. */
	let details = $state(false);
	const facts = $derived(
		song
			? [
					['Format', song.quality.format?.toUpperCase() ?? '—'],
					[
						'Depth and rate',
						song.quality.bitDepth && song.quality.sampleRateHz
							? `${song.quality.bitDepth}-bit · ${(song.quality.sampleRateHz / 1000).toFixed(1)} kHz`
							: '—'
					],
					['Bitrate', song.quality.bitrateKbps ? `${song.quality.bitrateKbps} kbps` : '—'],
					['Album', song.album ?? '—'],
					['Year', song.year ? String(song.year) : '—'],
					['Track', song.track ? String(song.track) : '—']
				]
			: []
	);
	const capitalized = $derived(aNoun[0].toUpperCase() + aNoun.slice(1));
	/** The second line of a link's preview: the artist, and for a list how long it is. */
	const previewText = $derived.by(() => {
		if (!ready) return '';
		const count = `${noun === 'album' ? 'Album' : 'Playlist'}, ${tracks.length} track${tracks.length === 1 ? '' : 's'}`;
		if (noun === 'song') return ready.item.subtitle ?? 'A song';
		return ready.item.subtitle ? `${ready.item.subtitle} · ${count}` : count;
	});
	const signedIn = $derived(Boolean(data.account));
	const expires = $derived(
		ready
			? new Date(ready.expiresAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
			: null
	);
	/** The playing track's cover, or the album's or playlist's own where the track has none. */
	const coverPath = $derived(
		!ready ? null : song?.hasCover ? `${ready.media}/cover/${current}` : ready.item.hasCover ? `${ready.media}/cover` : null
	);
	const coverSrc = $derived(coverPath ? `${coverPath}?size=512` : null);
	const coverSrcset = $derived(coverPath ? `${coverPath}?size=512 1x, ${coverPath}?size=1024 2x` : undefined);

	/*
	 * The room's colour. A playable link takes it from its cover once decoded,
	 * and anything else draws a hue, as the login page does. Held, not applied,
	 * so the layout's own tint, which resolves a null cover a microtask later,
	 * does not put the room back to frost.
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
		 * A frame late. The layout's tint effect runs after this page mounts and
		 * claims the room for "nothing playing": held sooner, the colour went
		 * straight back to frost (seen in the first iPhone 16 capture). The
		 * cover may have loaded before hydration, before its load event could
		 * be heard, so it is read here.
		 */
		// Listened for here and not with `onload`, which Svelte renders as an
		// inline handler attribute the Content-Security-Policy refuses.
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
	 * The login page's coming and going. The page starts covered and fades up.
	 * Leaving blurs what is behind the glass and lays the veil back over the
	 * top before the navigation is applied.
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

	/*
	 * To a track by its position, playing. The element's source changes with
	 * `current`, so play() waits a tick for it. Called from the transport, the
	 * end of a track, the lock screen and the list.
	 */
	async function playAt(position: number) {
		if (position < 0 || position >= tracks.length) return;
		failed = false;
		time = 0;
		current = position;
		await tick();
		try {
			await audio?.play();
		} catch {
			// A refused play() leaves the element paused, which the button shows.
		}
	}

	/** Back to the start of the track, or to the one before within its first three seconds. */
	function previous() {
		if (many && current > 0 && time < 3) void playAt(current - 1);
		else restart();
	}

	function next() {
		if (current < tracks.length - 1) void playAt(current + 1);
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
	 * The lock screen and the headset buttons. A phone pausing a shared song
	 * and resuming it from the lock screen is the ordinary case here, and
	 * without metadata the lock screen names the tab.
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
		if (many) {
			navigator.mediaSession.setActionHandler('previoustrack', previous);
			navigator.mediaSession.setActionHandler('nexttrack', next);
		}
		return () => {
			navigator.mediaSession.metadata = null;
			navigator.mediaSession.setActionHandler('play', null);
			navigator.mediaSession.setActionHandler('pause', null);
			navigator.mediaSession.setActionHandler('previoustrack', null);
			navigator.mediaSession.setActionHandler('nexttrack', null);
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
	{#if data.noindex}
		<meta name="robots" content="noindex, nofollow" />
	{/if}
	<!--
		What a messaging app shows of a pasted link: the title, the artist and
		the cover. The page gives all three to anyone holding the link anyway.
	-->
	{#if ready}
		<meta property="og:type" content="music.{noun}" />
		<meta property="og:site_name" content={data.appName} />
		<meta property="og:title" content={ready.item.title} />
		<meta property="og:description" content={previewText} />
		{#if ready.previewImage}
			<meta property="og:image" content={ready.previewImage} />
		{/if}
		<meta name="twitter:card" content="summary" />
	{/if}
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
				{capitalized} you shared.
			{:else if ready?.sharedBy}
				<strong>{ready.sharedBy}</strong> shared {aNoun} with you.
			{:else if song}
				{capitalized}, shared with you.
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
		<article class="card hh-glass hh-glass--deep hh-float" aria-label="Shared {noun}">
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
					<!-- With several tracks the row is five (this, previous, play,
					     next, mute), so play is in the middle. A song link keeps its
					     three. -->
					{#if many}
						<button
							class="edge"
							class:on={details}
							onclick={() => (details = !details)}
							aria-expanded={details}
							aria-label="Track details"
							title="Track details"
						>
							<Icon name="info" size={20} />
						</button>
					{/if}

					<button
						class="edge"
						onclick={(event) => {
							skipGlyph(event.currentTarget, -1);
							previous();
						}}
						aria-label={many ? 'Previous track' : 'Back to the start'}
						title={many ? 'Previous' : 'Back to the start'}
					>
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

					{#if many}
						<button
							class="edge"
							onclick={(event) => {
								skipGlyph(event.currentTarget, 1);
								next();
							}}
							disabled={current >= tracks.length - 1}
							aria-label="Next track"
							title="Next"
						>
							<Icon name="next" size={22} />
						</button>
					{/if}

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

				<!-- The playing track's facts, as the player's track details show them. -->
				{#if many}
					<div class="fold" class:open={details} inert={!details}>
						<div>
							<dl class="facts">
								{#each facts as [term, value] (term)}
									<div>
										<dt class="hh-muted">{term}</dt>
										<dd class="hh-numeric hh-truncate">{value}</dd>
									</div>
								{/each}
							</dl>
						</div>
					</div>
				{/if}

				{#if failed}
					<p class="error" role="alert">
						This track could not be played. The link may have expired or been withdrawn.
					</p>
				{/if}

				{#if many}
					<!-- The album or playlist, in order. A press plays from that track on. -->
					<ol class="tracklist" aria-label="Tracks">
						{#each tracks as track, index (index)}
							<li>
								<button
									class="entry"
									class:current={index === current}
									aria-current={index === current ? 'true' : undefined}
									onclick={() => void playAt(index)}
								>
									<span class="num hh-numeric">{index + 1}</span>
									<span class="entry-text">
										<span class="entry-title hh-truncate">{track.title}</span>
										{#if noun === 'playlist' && track.artist}
											<span class="entry-sub hh-truncate hh-muted">{track.artist}</span>
										{/if}
									</span>
									<span class="dur hh-numeric hh-muted">{formatDuration(track.duration)}</span>
								</button>
							</li>
						{/each}
					</ol>
				{/if}
			</div>

			<!--
				Nothing loads until play is pressed: the file can be a hundred
				megabytes of FLAC. `crossorigin` is unset, as on the app's own
				elements: the stream is same-origin.
			-->
			<audio
				bind:this={audio}
				src="{ready.media}/stream/{current}"
				onended={next}
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
					<h2>This music is not available</h2>
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
			     sent along. The referrer policy already holds it back. -->
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
		padding-top: var(--bare-top);
		grid-template-columns: minmax(0, 23rem) minmax(0, 23rem);
		grid-template-areas:
			'intro card'
			'colophon colophon';
	}

	/* Rests at 0 and is animated from 1, so a browser that never runs the
	   animation is not left under an opaque sheet. */
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

	/* The blur goes on what is behind the glass, never on an ancestor of it,
	   which would become the card's backdrop root. */
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
	 * Slightly taller than wide, as the panel's stage usually is, so the cover
	 * is cropped in a little. It dissolves into the controls by a mask on the
	 * artwork: the card's ground is translucent and changes with the room, so a
	 * painted gradient would show as a band.
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

	/* The playing track's facts, folded under the transport as the player's
	   track details are: a one-row grid whose track opens from 0fr to 1fr.
	   Opacity on the fold, which holds no glass. */
	.fold {
		display: grid;
		grid-template-rows: 0fr;
		opacity: 0;
		margin-block-start: calc(var(--space-4) * -1);
		transition:
			grid-template-rows var(--dur-state) var(--ease-out),
			opacity var(--dur-state) var(--ease-out),
			margin-block-start var(--dur-state) var(--ease-out);
	}

	.fold.open {
		grid-template-rows: 1fr;
		opacity: 1;
		margin-block-start: 0;
	}

	.fold > * {
		overflow: hidden;
		min-height: 0;
	}

	.facts {
		margin: 0;
		display: grid;
		gap: 0.15rem;
		font-size: 0.75rem;
	}

	.facts > div {
		display: grid;
		grid-template-columns: 7.5rem minmax(0, 1fr);
		gap: var(--space-3);
	}

	.facts dt,
	.facts dd {
		margin: 0;
	}

	.facts dd {
		color: var(--text-default);
	}

	/* An album's or playlist's tracks, under the transport: a column the card
	   scrolls within, about six rows tall, so the card keeps the song card's
	   size. */
	.tracklist {
		list-style: none;
		margin: 0 calc(var(--space-2) * -1);
		padding: var(--space-2) 0 0;
		max-height: 16rem;
		overflow-y: auto;
		border-top: 1px solid var(--border-hairline);
		scrollbar-width: none;
	}

	.entry {
		width: 100%;
		display: grid;
		grid-template-columns: 1.75rem minmax(0, 1fr) auto;
		align-items: center;
		gap: var(--space-2);
		padding: 0.45rem var(--space-2);
		border-radius: var(--r-sm);
		text-align: left;
		color: var(--text-default);
	}

	.entry:hover {
		background: var(--bg-hover);
	}

	.entry.current {
		color: var(--glow-color);
		text-shadow: var(--glow-text);
	}

	.num {
		font-size: 0.75rem;
		color: var(--text-faint);
		text-align: right;
	}

	.entry-text {
		display: grid;
		min-width: 0;
	}

	.entry-title {
		font-size: 0.875rem;
	}

	.entry-sub {
		font-size: 0.75rem;
	}

	.dur {
		font-size: 0.75rem;
	}

	.edge:disabled {
		opacity: 0.35;
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

	/* The one filled control on the card: the accent disc marks the thing to
	   press. */
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
			padding-top: var(--bare-top);
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
	 * A phone. The whole card has to fit one screen with the play button in
	 * reach of a thumb: on an iPhone 16 (393x852) the square artwork alone was
	 * 332px tall and pushed the transport under Safari's toolbar.
	 *
	 * The artwork becomes a band whose height follows the screen's, the name
	 * and the sentence share one line at the top, and the expiry goes to a line
	 * under the card.
	 */
	@media (max-width: 36rem) {
		.stage {
			gap: var(--space-4);
			/* Centred when the screen has room to spare, as the login page is:
			   560px of content on an 852px iPhone 16. */
			align-content: center;
			padding: var(--bare-top-tight) var(--space-4) var(--space-3);
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
