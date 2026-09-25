<script lang="ts">
	import '$lib/styles/app.css';
	import { untrack } from 'svelte';
	import { afterNavigate, onNavigate } from '$app/navigation';
	import { player } from '$lib/client/player.svelte';
	import { tintFrom } from '$lib/client/artwork';
	import { ambience } from '$lib/client/ambience.svelte';
	import {
		prefersReducedMotion,
		resetSleeveTokens,
		sleeveTransition,
		supportsViewTransitions
	} from '$lib/client/sleeve-transition.svelte';
	import { handOff } from '$lib/client/handoff';
	import { installPress } from '$lib/client/press';
	import Cover from '$lib/components/Cover.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import NowPlayingPanel from '$lib/components/NowPlayingPanel.svelte';
	import PlaylistPicker from '$lib/components/PlaylistPicker.svelte';
	import ShareDialog from '$lib/components/ShareDialog.svelte';
	import Sidebar from '$lib/components/Sidebar.svelte';
	import type { LayoutData, Snapshot } from './$types';
	import type { Song } from '$lib/types';

	let { data, children }: { data: LayoutData; children: import('svelte').Snippet } = $props();

	// The press effect on every `.hh-button`; see `client/press.ts`.
	$effect(() => installPress());

	let primaryAudio = $state<HTMLAudioElement | null>(null);
	let secondaryAudio = $state<HTMLAudioElement | null>(null);

	/*
	 * A shared link is drawn bare, as the login page is, for visitors with or
	 * without an account. It plays through an audio element of its own, so the
	 * player is not attached there either; it attaches, and the queue is
	 * restored, when a signed-in visitor goes on into the library.
	 */
	const signedIn = $derived(Boolean(data.account) && !data.isLoginPage && !data.isSharePage);

	/*
	 * The fade in when the app arrives from the login page.
	 *
	 * The login page dissolves itself and only then hands over, so without this
	 * the rail, the content and the player all appear in a single frame over an
	 * ambient field that was already on screen.
	 *
	 * Seeded from the value this component was built with, and derived rather
	 * than set from an effect. An effect runs after the DOM is updated, which
	 * would put the scrim up one frame after the thing it is there to cover had
	 * already been painted. A cold load of a signed-in page starts `true` here,
	 * which is not an arrival and does not animate. Signing out posts a form to
	 * an endpoint, so the browser navigates and this is seeded again.
	 */
	let settled = $state(untrack(() => signedIn));
	const arriving = $derived(signedIn && !settled);

	/**
	 * What the browser tab says.
	 *
	 * A loaded track wins over the page name, so a tab in the background says
	 * what is coming out of it. It follows `current` rather than `playing`:
	 * pausing does not change what is loaded, and flipping the tab back to
	 * "Albums" on every pause would be noise.
	 */
	const tabTitle = $derived.by(() => {
		const song = player.current;
		if (!song) return null;
		return song.artist ? `${song.title} - ${song.artist}` : song.title;
	});

	/*
	 * Wiring the player to its audio elements.
	 *
	 * The login page mounts this layout too. Attaching the player there would
	 * fire /api/play-state at an unauthenticated server and log a 401 for
	 * nothing, so this waits until there is an account behind it.
	 *
	 * That wait is why it is an effect and not `onMount`. Signing in is a
	 * client-side navigation: the form action redirects, the layout is never
	 * torn down, and `onMount` has already run and returned by then. From there
	 * the player stayed unattached for the whole session and nothing played
	 * until the page was reloaded by hand. An effect re-runs when `signedIn`
	 * flips, so it attaches at the moment the account appears, and its teardown
	 * detaches on sign-out.
	 *
	 * The audio elements sit outside the signed-in branch of the markup, so they
	 * are bound before this ever runs.
	 */
	$effect(() => {
		if (!signedIn || !primaryAudio || !secondaryAudio) return;
		// Untracked: the effect below keeps a running player's settings current.
		// Reading them as a dependency here would detach and re-attach the
		// player, and restore the queue over the top of itself, every time a
		// setting changed.
		// The whole call untracked, not only the settings: `attach` reads player
		// state on its way, and anything it reads here becomes a reason to
		// detach and re-attach the player, which stops playback.
		const primary = primaryAudio;
		const secondary = secondaryAudio;
		untrack(() => player.attach(primary, secondary, data.settings));
		void restoreQueue();
		return () => player.detach();
	});

	// Settings can change from the settings page while the player is running.
	$effect(() => {
		player.applySettings(data.settings);
	});

	// `data-theme` is written into the document by the server-side HTML
	// transform, so nothing repaints it when the setting changes during a
	// client-side session — saving a new theme would appear to do nothing until
	// the next full page load. Mirroring it here closes that gap.
	$effect(() => {
		document.documentElement.dataset.theme = data.settings.theme;
	});

	// The scale is written into the served HTML by the same transform as the
	// theme, so it has the same gap: saving a new one would do nothing until the
	// next full page load. Mirroring it here closes that.
	$effect(() => {
		document.documentElement.dataset.scale = data.settings.uiScale;
	});

	// The font as well, for the same reason.
	$effect(() => {
		document.documentElement.dataset.font = data.settings.font;
	});

	/*
	 * One colour, applied once, at the root.
	 *
	 * Everything downstream reads `--art-*` by inheritance: the ambient field
	 * behind the page, the accent on the controls, the hover tint on a row. No
	 * component sets its own, which is the whole reason the colour reads as a
	 * light filling the room rather than as decoration applied per panel.
	 *
	 * Reading `coverArt` rather than the whole song keeps this from re-running
	 * when some other field of the same track changes.
	 */
	$effect(() => {
		// While something is actually playing, that is what the room is for. Paused
		// does not count: a queue restored from the server means a track is loaded
		// on every page load, and letting that win would mean the colour never
		// responded to where you are again. So a paused track yields to whatever
		// page you are looking at, and only takes the room back if the page has
		// nothing of its own to offer.
		// `engaged` rather than `playing`: `playing` drops for about 17ms at every
		// track change, which sent the room to the page's cover and back.
		const playing = player.engaged ? player.current?.coverArt : null;
		// `incoming` outranks `page`: during a navigation the page being left is
		// still mounted and still offering its cover, and the room should be on
		// its way to the one being opened.
		void tintFrom(
			document.documentElement,
			playing ?? ambience.incoming ?? ambience.page ?? player.current?.coverArt
		);
	});

	/**
	 * The queue lives on the server, so it survives a reload and follows the
	 * account to another device. Only ids are stored; the metadata is re-fetched
	 * here so a renamed or re-tagged track shows its current details.
	 *
	 * The current track is looked up first and put on screen, and the rest of
	 * the queue follows. On Subsonic every id is its own upstream call, eight at
	 * a time, so a queue of 1000 tracks held the player empty until the last of
	 * 1000 calls had answered.
	 */
	async function restoreQueue() {
		try {
			const response = await fetch('/api/play-state', { headers: { accept: 'application/json' } });
			if (!response.ok) return;
			const state = await response.json();
			if (!Array.isArray(state.songIds) || state.songIds.length === 0) return;
			const ids: string[] = state.songIds;
			const savedIndex = Math.min(Math.max(0, state.index ?? 0), ids.length - 1);
			const settings = {
				repeat: state.repeat ?? 'off',
				shuffle: state.shuffle ?? false
			};

			const [current] = await lookUp([ids[savedIndex]]);
			if (current && ids.length > 1) {
				await player.restore(
					[current],
					{ index: 0, position: state.position ?? 0, ...settings },
					{ ids, index: savedIndex }
				);
				player.completeRestore(await lookUp(ids));
				return;
			}
			if (current) {
				await player.restore([current], { index: 0, position: state.position ?? 0, ...settings });
				return;
			}

			// The current track was removed from the library since the queue was
			// saved. The rest comes back without it, which shifts every position
			// after it, and the queue resumes at the same position from the start
			// of the track now there.
			const songs = await lookUp(ids);
			await player.restore(songs, { index: savedIndex, position: 0, ...settings });
		} catch {
			// A missing queue is not worth an error message.
		}
	}

	async function lookUp(ids: string[]): Promise<Song[]> {
		const response = await fetch('/api/songs', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ ids })
		});
		if (!response.ok) throw new Error(`songs ${response.status}`);
		return ((await response.json()) as { songs: Song[] }).songs;
	}

	/**
	 * Hands the navigation to the browser's view transition machinery, which is
	 * what actually morphs a clicked sleeve into the album page's hero. Anything
	 * without support, or anyone who asked for less motion, gets an ordinary
	 * navigation — the pages are identical either way.
	 */
	onNavigate((navigation) => {
		// A card click points the room at the album it is opening. Any navigation
		// to anywhere else drops that, so a back button or a rail link cannot
		// inherit it, and neither can the click that was abandoned.
		ambience.settle(navigation.to ? navigation.to.url.pathname + navigation.to.url.search : null);

		// Tokens are handed out in render order, so resetting here makes them
		// reproducible: the same page re-rendered gets the same numbers, which is
		// what lets a back navigation find the card it left from.
		resetSleeveTokens();

		// Going back re-arms the names from the outbound trip, so the album hero
		// morphs into the card that opened it instead of cutting.
		if (navigation.type === 'popstate' && navigation.to) {
			const target = navigation.to.url.pathname + navigation.to.url.search;
			if (!sleeveTransition.armReturn(target)) sleeveTransition.end();
		}

		if (prefersReducedMotion()) {
			sleeveTransition.end();
			return;
		}

		// No sleeve in flight: nothing is named, so a view transition would only
		// freeze the page while it captured nothing. The page fades through the
		// room instead, when it is a different page and not a new sort or page
		// number of the same one.
		if (sleeveTransition.activeId === null) {
			const samePage = navigation.from?.url.pathname === navigation.to?.url.pathname;
			const leavingShell = !navigation.to || /^\/(login|share)(\/|$)/.test(navigation.to.url.pathname);
			if (!shellShown || samePage || leavingShell) return;
			return fadeThroughRoom(navigation);
		}

		if (!supportsViewTransitions()) {
			sleeveTransition.end();
			return;
		}

		return new Promise((resolve) => {
			document.startViewTransition(async () => {
				resolve();
				await navigation.complete;
			}).finished.finally(() => {
				sleeveTransition.end();
				// A return trip is only good once; keeping it armed would morph the
				// next unrelated back navigation too.
				if (navigation.type === 'popstate') sleeveTransition.forget();
			});
		});
	});

	/*
	 * Moving between pages.
	 *
	 * A veil the colour of the room rises over the page being left, the new page
	 * is put in underneath it, and the veil falls away. It is one plain layer
	 * above the content column and below the rail and the player, which are
	 * lifted over it by z-index.
	 *
	 * This is the only shape of page transition that the glass allows, and the
	 * two others were tried. A named view transition paints a surface from a
	 * snapshot of itself, which has nothing behind it to blur: that was the
	 * black rectangle over the rail on iPadOS and Windows. Fading the page
	 * itself puts every glass card and button in it under an ancestor below full
	 * opacity, which is a backdrop root, so each one would lose its blur for the
	 * length of the fade and snap back at the end. The veil is a sibling of all
	 * of it; nothing under it changes opacity, and nothing is snapshotted.
	 *
	 * The first half is short, since it is time the reader is waiting, and it
	 * starts after the new page's data has already arrived. It was 90ms, which
	 * read as a flicker rather than a fade; 150ms is five frames of it. The
	 * second half is the travel length, and the page rises into place under it
	 * (`rising`, below).
	 */
	const VEIL_IN_MS = 150;
	let veil = $state<'off' | 'in' | 'out'>('off');
	const shellShown = $derived(signedIn && Boolean(data.account));

	/*
	 * The page arriving: it rises 12px into place while the veil clears, and
	 * any `.hh-stagger` list in it (card grids, track lists) comes in item by
	 * item. Translate on the page, which is not a backdrop root, so the glass
	 * in it keeps its blur; opacity only on the list items, which hold none.
	 * Only for a navigation: a server-rendered page is whole in its first paint.
	 *
	 * Held for the longest of those animations (the travel length plus 12
	 * items of stagger), since taking the class off early would cut the late
	 * items short and snap them into place.
	 */
	let rising = $state(false);
	let risingTimer: ReturnType<typeof setTimeout> | undefined;
	const RISE_HOLD_MS = 900;

	async function fadeThroughRoom(navigation: import('@sveltejs/kit').OnNavigate): Promise<void> {
		veil = 'in';
		navigation.complete.then(
			() => {
				veil = 'out';
				rising = !prefersReducedMotion();
				clearTimeout(risingTimer);
				risingTimer = setTimeout(() => (rising = false), RISE_HOLD_MS);
			},
			() => (veil = 'off')
		);
		await new Promise((resolve) => setTimeout(resolve, VEIL_IN_MS));
	}

	/*
	 * Where the content column is the scroller, above 60rem, a page opened from
	 * a link starts at its top and Back returns to where the page was left.
	 *
	 * SvelteKit does both for the document and nothing for an element that
	 * scrolls inside it, so the column kept one position for every page: an
	 * album opened from 400px down the library opened 400px down its own page,
	 * with the cover the sleeve was flying to out of view. A new sort or page
	 * number of the same page keeps its place, as those links ask for with
	 * `data-sveltekit-noscroll`. SvelteKit restores the snapshot on Back after
	 * the new page is in and before the view transition takes its picture, so
	 * the sleeve's way back finds the card where it was.
	 *
	 * On a narrow screen the document scrolls and SvelteKit handles it; the
	 * column has nothing to scroll there.
	 */
	let content = $state<HTMLElement | null>(null);

	afterNavigate(({ type, from, to }) => {
		if (type === 'enter' || type === 'popstate') return;
		if (from?.url.pathname === to?.url.pathname) return;
		// `instant`: the column scrolls smoothly for everything else.
		content?.scrollTo({ top: 0, behavior: 'instant' });
	});

	export const snapshot: Snapshot<number> = {
		capture: () => content?.scrollTop ?? 0,
		restore: (top) => content?.scrollTo({ top, behavior: 'instant' })
	};

	function showPanel() {
		player.togglePanel();
		// The tool row's chevron is what closes it again, so that is where the
		// keyboard goes once the sliver it was on has gone inert.
		void handOff('player-hide');
	}

	function onKeydown(event: KeyboardEvent) {
		if (!signedIn) return;
		const target = event.target as HTMLElement | null;
		// Never steal keys from a field the user is typing into.
		if (target?.matches('input, textarea, select, [contenteditable="true"]')) return;

		if (event.code === 'Space') {
			event.preventDefault();
			void player.toggle();
		} else if (event.key === 'ArrowRight' && event.shiftKey) {
			event.preventDefault();
			void player.next();
		} else if (event.key === 'ArrowLeft' && event.shiftKey) {
			event.preventDefault();
			void player.previous();
		}
	}
</script>

<svelte:window onkeydown={onKeydown} />

<svelte:head>
	<!--
		The pages set their own titles too, and the document ends up with one
		title element rather than two. Measured across the states that matter: a
		loaded track shows here on every page, and with nothing loaded the page's
		own title stands, including in the server-rendered HTML.
	-->
	<title>{tabTitle ?? data.appName}</title>
	<meta name="description" content="High-resolution music player for your own library." />
	<meta name="color-scheme" content="dark light" />
	<!-- The label under the home-screen icon on iOS, which reads this and not
	     the manifest. -->
	<meta name="apple-mobile-web-app-title" content={data.appName} />
</svelte:head>

<!--
  Two audio elements, alternating. The one not currently producing sound
  pre-buffers the next track so the handoff does not wait on the network.
  `crossorigin` is unset on purpose: these are same-origin proxy URLs, and
  leaving it off keeps the element out of any CORS-tainted code path.
-->
<audio bind:this={primaryAudio} preload="metadata"></audio>
<audio bind:this={secondaryAudio} preload="none"></audio>

{#if signedIn && data.account}
	<div class="app" class:player-open={player.panelOpen} class:viewport-known={player.viewportKnown}>
		<!-- The room, and the aurora drifting in it when turned on; see `.aurora` in app.css. -->
		<div class="hh-ambience" aria-hidden="true">
			{#if data.settings?.aurora === 'moving' || data.settings?.aurora === 'still'}
				<div class="aurora" class:still={data.settings.aurora === 'still'}></div>
			{/if}
		</div>

		<Sidebar appName={data.appName} />

		<!--
			Focusable on purpose, like the lyrics body. With no scrollbar there is
			no pointer-only way to scroll this, so the keyboard has to be one —
			WCAG 2.1.1 does not allow a scrollable region to be keyboard-
			unreachable. Chrome makes overflow containers focusable by itself;
			Safari does not, and a tab stop is the portable answer. The rule below
			does not model scrollable regions, so it is wrong here.
		-->
		<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
		<main class="content" class:rising tabindex="0" bind:this={content}>
			{@render children()}
		</main>

		<!--
			Closing the panel does not unmount it. The column it sits in narrows to
			the sliver instead, which leaves the panel overhanging the right-hand
			edge with a 44px strip of it still on screen. That strip is a button, and
			pressing it brings the panel back. See `.dock` below.
		-->
		<div class="player">
			<div class="dock">
				<div class="body" inert={!player.panelOpen}>
					<NowPlayingPanel showQualityBadge={data.settings.showQualityBadge} />
				</div>

				<!--
					The sliver's own face, rather than whatever the panel happens to
					have in its first 44px. A raw crop of the panel would put half a
					title and a sliced button on the edge of every page; this shows
					the cover, the track and the way back, which is the same panel
					reduced rather than cut.
				-->
				<button
					id="player-grip"
					class="grip hh-glass hh-glass--deep hh-float"
					type="button"
					inert={player.panelOpen}
					onclick={showPanel}
					title="Show the player"
					aria-label="Show the player"
				>
					<span class="grip-art">
						<Cover coverArt={player.current?.coverArt} size={64} radius="var(--r-sm)" />
					</span>
					<span class="grip-title">{player.current?.title ?? 'Now playing'}</span>
					<Icon name="chevron-left" size={18} />
				</button>
			</div>
		</div>

		<PlaylistPicker />
		{#if data.sharing}
			<ShareDialog />
		{/if}

		{#if veil !== 'off'}
			<div
				class="page-veil hh-ambience"
				class:out={veil === 'out'}
				aria-hidden="true"
				onanimationend={() => {
					if (veil === 'out') veil = 'off';
				}}
			></div>
		{/if}

		{#if arriving}
			<!--
				Repeats the page's own ground, so what fades away here is what the
				login page left on screen a moment earlier.
			-->
			<div
				class="arrival hh-ambience"
				aria-hidden="true"
				onanimationend={() => (settled = true)}
			></div>
		{/if}
	</div>
{:else}
	{@render children()}
{/if}

<style>
	/*
	 * Everything floats. The ambient wash is the page, and the rail, the player
	 * bar and the queue sit on top of it as separate panes with air around them —
	 * which is what makes the blur legible, because there is genuinely something
	 * behind each one.
	 */
	/*
	 * The scrim that covers the arrival from the login page.
	 *
	 * A scrim that fades out, rather than the app fading in. An element whose
	 * opacity is below 1 forms a backdrop root, so fading the app would take
	 * the blur and the brightness attenuation off the rail and the player for
	 * the length of the animation and hand them back on the frame it reaches 1.
	 * This is a sibling of all of that, so every glass surface under it stays at
	 * opacity 1 throughout and is only revealed.
	 *
	 * It borrows `.hh-ambience` for the wash and the ground. The z-index has to
	 * outrank that class, hence the descendant selector.
	 *
	 * It rests at 0 and is animated from 1. Left the other way round, a browser
	 * that never ran the animation would keep an opaque sheet over the app.
	 */
	.app .arrival {
		z-index: 60;
		opacity: 0;
		animation: arrive var(--dur-travel) var(--ease-out) forwards;
	}

	@keyframes arrive {
		from {
			opacity: 1;
		}
		to {
			opacity: 0;
		}
	}

	/*
	 * Over the content (z-index 1, and later in the document), in the content's
	 * own grid cell, so nothing of it is behind the rail or the player.
	 *
	 * It covered the whole screen at first, under the rail and the player, on
	 * the reasoning that they blur whatever is behind them and it repeats the
	 * room's ground, so they would look the same over it. In Chromium they did.
	 * In Safari and Firefox both went dark for a moment on every page change,
	 * with or without a change of colour: a layer animating its opacity behind
	 * `backdrop-filter` is not blurred cleanly there while it moves. No part of
	 * the veil is under glass now, so neither panel has anything changing
	 * behind it.
	 *
	 * `.hh-ambience` places it fixed over the whole viewport; the grid cell
	 * replaces that. The room's gradients are attached to the viewport, as they
	 * are on the room itself, so the veil matches what is around it. iOS Safari
	 * ignores `background-attachment: fixed` and draws them against the cell,
	 * which shifts the wash slightly for the 350ms the veil is up.
	 *
	 * Rests at 0 and is animated up, then down from 1, so a browser that never
	 * runs the animation is not left behind an opaque sheet.
	 */
	.app .page-veil {
		grid-area: content;
		position: relative;
		inset: auto;
		background-attachment: fixed;
		z-index: 1;
		opacity: 0;
		animation: page-veil-in 150ms var(--ease-out) forwards;
	}

	.app .page-veil.out {
		animation: page-veil-out var(--dur-travel) var(--ease-out) forwards;
	}

	/* The page rising into place as the veil clears; see `rising`. */
	.content.rising > :global(*) {
		animation: page-rise var(--dur-travel) var(--ease-out) both;
	}

	@keyframes page-rise {
		from {
			translate: 0 0.75rem;
		}
	}

	@keyframes page-veil-in {
		to {
			opacity: 1;
		}
	}

	@keyframes page-veil-out {
		from {
			opacity: 1;
		}
		to {
			opacity: 0;
		}
	}

	.app {
		display: grid;
		grid-template-areas: 'rail content player';
		/*
		 * The player track is a maximum, not a fixed width. The content track
		 * gives its space up first, since its minimum is zero, so at every
		 * ordinary width this is the same 24rem column; it only differs when the
		 * grid itself has less room than the tracks want, and there the panel
		 * narrows rather than the row overflowing.
		 *
		 * It is not what stops the panel being clipped when the layout is wider
		 * than the window: measured, that case leaves the grid with more room
		 * than it needs, not less, so no track shrinks. The body's own width is
		 * what fixes that.
		 */
		grid-template-columns: var(--rail-width) minmax(0, 1fr) minmax(0, var(--player-width));
		gap: var(--float-gap);
		padding: var(--edge-top) var(--edge-right) var(--edge-bottom) var(--edge-left);
		height: 100vh;
		height: 100dvh;
		/*
		 * The closed panel overhangs the right-hand edge rather than being taken
		 * out of the layout, so the part past the edge is cut off here. `clip`
		 * rather than `hidden`: `hidden` makes this a scroll container, and it
		 * pairs only with `hidden` on the other axis, which would trap the
		 * dialog and the ambient wash inside a box the height of the grid.
		 */
		overflow-x: clip;
		transition: grid-template-columns var(--slide);
	}

	/*
	 * Closed, the column narrows to the sliver. The panel inside keeps its own
	 * width, so narrowing the column is what slides it off the right-hand edge,
	 * and the content takes the rest of the space back in the same motion. One
	 * animated property drives both halves, which is why there is no transform
	 * anywhere in this.
	 *
	 * It animates layout rather than the compositor, so it is not free: measured
	 * on the album grid with 69 cards in a headless container, frames went from
	 * 13-20ms to 25-46ms for the 160ms the slide lasts. The alternative is to
	 * snap the column and slide the panel over the content with a transform,
	 * which costs one reflow instead of ten, and makes the whole library jump to
	 * a new column count in a single frame. A short slide at a lower frame rate
	 * is the less noticeable of the two.
	 */
	.app:not(.player-open) {
		grid-template-columns: var(--rail-width) minmax(0, 1fr) minmax(0, var(--player-sliver));
	}

	.content {
		grid-area: content;
		position: relative;
		z-index: 1;
		overflow-y: auto;
		/* A record protruding from a card in the last column would otherwise push
		   out a horizontal scrollbar. `clip` pairs with `auto`; `hidden` does not. */
		overflow-x: clip;
		/*
		 * The player is a column beside this now rather than a bar floating over
		 * the bottom of it, so the content no longer has to reserve a strip of
		 * itself to keep the last row clear of the glass.
		 */
		padding: var(--space-5);
		scroll-behavior: smooth;
	}

	/*
	 * Every page sets its own maximum width, which is a reading measure: a track
	 * row 2800px wide puts the title and the duration at opposite ends of a
	 * 32:9 monitor. Centring is applied here rather than in each page, so the
	 * page files carry only the measure and a new route cannot forget it. The
	 * rule does nothing to a page that sets no maximum.
	 */
	.content > :global(*) {
		margin-inline: auto;
	}

	/*
	 * A column of its own, full height, beside the content rather than over it.
	 * Docked like this it reflows the page once when you toggle it, instead of
	 * permanently covering a strip of whatever you are reading — which is the
	 * trade an always-open overlay would make.
	 */
	.player {
		grid-area: player;
		min-height: 0;
		position: relative;
		/* Over the page veil. */
		z-index: 2;
	}

	/*
	 * Pinned to the left edge of the column and holding the panel's full width,
	 * whatever the column is currently doing. This is the part that overhangs.
	 */
	.dock {
		position: absolute;
		inset: 0 auto 0 0;
		width: var(--player-width);
	}

	.body {
		height: 100%;
		visibility: visible;
		transition: visibility 0s linear 0s;
	}

	/*
	 * Hidden behind the sliver rather than left showing through it. The panel's
	 * first 44px are a column of padding, a slice of the title and the left edge
	 * of one tool button, and none of that reads as anything.
	 *
	 * Hidden once the slide has finished, not faded while it runs. This used to
	 * fade, and an ancestor below full opacity is a backdrop root: for the whole
	 * fade the panel's glass lost its blur and its darkening and showed the page
	 * through it, then snapped back when the fade ended. That flash, on every
	 * close, was most of what made the slide look rough.
	 */
	.app:not(.player-open) .body {
		visibility: hidden;
		transition: visibility 0s linear var(--slide-duration);
	}

	/*
	 * The sliver. It covers the part of the column that is still on screen, so
	 * what stays behind when the panel goes is this and nothing else. `inert`
	 * on the two of them is what keeps the hidden one out of the tab order and
	 * the accessibility tree, so the opacity here is only ever about paint.
	 */
	.grip {
		position: absolute;
		inset: 0 auto 0 0;
		/*
		 * Wider than the column by exactly the gap the grid keeps around every
		 * floating panel, so the strip reaches the edge of the screen instead of
		 * stopping 12px short of it. A tab with air on its right does not read as
		 * something that continues off frame, it reads as a tab.
		 */
		width: calc(var(--player-sliver) + var(--float-gap));
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: var(--space-3);
		padding: var(--space-3) var(--space-2);
		/* `.hh-float` supplies the edge and the shadow, the same as every other
		   floating pane. Only the right-hand side differs: that is not an edge,
		   it is where the rest of the panel carries on past the screen. */
		border-right: none;
		border-radius: var(--r-xl) 0 0 var(--r-xl);
		color: var(--text-muted);
		opacity: 0;
		/* Opening: out of the way at once, so the panel slides in clear of it. */
		transition:
			opacity var(--dur-press) var(--ease-exit),
			color var(--transition);
	}

	/* Closing: it arrives over the second half of the slide, as the panel's
	   edge reaches the place it takes over from. */
	.app:not(.player-open) .grip {
		opacity: 1;
		transition:
			opacity var(--dur-hover) var(--ease-out) calc(var(--slide-duration) - var(--dur-hover)),
			color var(--transition);
	}

	.grip:hover,
	.grip:focus-visible {
		color: var(--glow-color);
		text-shadow: var(--glow-text);
	}

	.grip-art {
		width: 100%;
		flex: none;
	}

	/*
	 * Set down the strip rather than across it. A 44px column cannot hold a
	 * horizontal title at any size that is still type, and a rotated line is
	 * how a tab on a vertical edge has always been labelled.
	 */
	.grip-title {
		flex: 1 1 auto;
		min-height: 0;
		writing-mode: vertical-rl;
		/* A button centres its text, and in a vertical writing mode that centres
		   it down the strip: the title ended up floating in the middle with the
		   cover it belongs to 300px above it. */
		text-align: start;
		font-size: 0.75rem;
		font-weight: 500;
		letter-spacing: 0.02em;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		text-shadow: var(--text-shade);
	}

	.grip :global(svg) {
		flex: none;
	}

	audio {
		display: none;
	}

	/*
	 * Too narrow for two columns and a rail. The player becomes a sheet over the
	 * content instead — which is also what the design it is modelled on is, on a
	 * phone: the full-screen now-playing view rather than a side panel.
	 */
	@media (max-width: 60rem) {
		/*
		 * The document scrolls here, not the content column. Safari on iOS 26
		 * draws the page behind its toolbar, and under the status bar once
		 * scrolled, only from the document's own scroll. A column scrolling
		 * inside a box one screen tall ended at the top of the toolbar: on an
		 * iPhone the page stopped about 150pt above the bottom of the screen,
		 * with the canvas colour below it. The document scroll is also what
		 * Safari folds its toolbar away on, and what a tap on the status bar
		 * returns to the top.
		 *
		 * The grid grows with the page and is at least one screen tall. `svh`
		 * rather than `dvh`: `dvh` grows as the toolbar folds away, and a page
		 * between the two heights would grow with it and have nothing left to
		 * scroll.
		 *
		 * The first row is the rail's height. The rail spans both rows so that
		 * it can stay pinned over the page; see `Sidebar.svelte`.
		 */
		.app,
		.app:not(.player-open) {
			grid-template-areas:
				'rail'
				'content';
			grid-template-columns: minmax(0, 1fr);
			grid-template-rows: var(--rail-height) minmax(0, 1fr);
			height: auto;
			min-height: 100svh;
		}

		.content {
			overflow-y: visible;
			padding: var(--space-4);
		}

		/*
		 * A jump to an anchor lands below the pinned rail rather than under it.
		 *
		 * `none` turns pull-to-refresh off. The content column never offered it,
		 * and the document scroll would: a pull past the top would reload the
		 * page and stop playback.
		 *
		 * Only with the app on the page: the sign-in and shared-link pages have
		 * no rail.
		 */
		:global(html:has(.app)) {
			scroll-padding-top: calc(var(--edge-top) + var(--rail-height));
			overscroll-behavior-y: none;
		}

		/*
		 * The open sheet covers the page. Without this, a wheel over it scrolled
		 * the document underneath in Chromium, and a drag would scroll it in
		 * Safari and fold the toolbar away. Only once the client knows the width:
		 * the server renders the panel open.
		 */
		:global(html:has(.app.player-open.viewport-known)) {
			overflow: hidden;
		}

		/*
		 * The content cell runs the length of the page here and passes behind the
		 * rail once scrolled, and a layer fading behind glass darkens it in Safari
		 * and Firefox (see the veil above). So the veil is fixed to the screen
		 * below the rail, with the same gap the grid keeps between the two.
		 *
		 * iOS Safari draws the wash against the veil's own box. Fixed, that box is
		 * the screen less the rail rather than the whole length of the page.
		 */
		.app .page-veil {
			position: fixed;
			inset: calc(var(--edge-top) + var(--rail-height) + var(--float-gap)) var(--edge-right) 0 var(--edge-left);
		}

		/*
		 * The sheet slides up from below the screen and back down, rather than
		 * appearing and vanishing. It moves with `translate`, which the compositor
		 * runs without laying the page out again, and it rests at `none`, so an
		 * open sheet carries no transform at all. The transform is on this
		 * wrapper and not on the glass inside it, and a transform is not a
		 * backdrop root, so the panel keeps its blur all the way up.
		 *
		 * Closed, it is hidden once it has gone, which also takes it out of
		 * hit-testing. `inert` on the body already keeps it out of the tab order.
		 */
		.player {
			position: fixed;
			inset: calc(var(--edge-top) + var(--rail-height) + var(--float-gap)) var(--edge-right) var(--edge-bottom)
				var(--edge-left);
			z-index: 45;
			translate: none;
			visibility: visible;
			transition:
				translate var(--sheet-in),
				visibility 0s linear 0s;
		}

		.app:not(.player-open) .player {
			translate: 0 calc(100% + var(--float-gap) * 2 + env(safe-area-inset-bottom, 0px));
			visibility: hidden;
			transition:
				translate var(--sheet-out),
				visibility 0s linear var(--sheet-out-duration);
		}

		.dock {
			position: static;
			width: auto;
			height: 100%;
		}

		/*
		 * A sheet over the library rather than a column beside it, so there is no
		 * right-hand edge for a sliver to sit on and nothing for it to overhang.
		 * Closed means gone here, and the rail carries the way back.
		 */
		.grip {
			display: none;
		}

		/*
		 * The server renders the panel because that is right for a screen wide
		 * enough to hold it as a column. Here it would be a sheet over the
		 * library, so it stays hidden until the client has said how wide the
		 * screen actually is — see `viewportKnown` on the player.
		 */
		.app:not(.viewport-known) .player {
			display: none;
		}
	}

	/*
	 * The slide is the whole point of it, so it is the whole thing that goes:
	 * the column snaps to its new width and the sliver appears already in place.
	 */
	@media (prefers-reduced-motion: reduce) {
		.app,
		.app:not(.player-open),
		.body,
		.app:not(.player-open) .body,
		.grip,
		.app:not(.player-open) .grip,
		.player,
		.app:not(.player-open) .player {
			transition: none;
		}
	}
</style>
