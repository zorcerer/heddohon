<script lang="ts">
	import '$lib/styles/app.css';
	import { onMount } from 'svelte';
	import { onNavigate } from '$app/navigation';
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
	import Cover from '$lib/components/Cover.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import NowPlayingPanel from '$lib/components/NowPlayingPanel.svelte';
	import PlaylistPicker from '$lib/components/PlaylistPicker.svelte';
	import Sidebar from '$lib/components/Sidebar.svelte';
	import type { LayoutData } from './$types';

	let { data, children }: { data: LayoutData; children: import('svelte').Snippet } = $props();

	let primaryAudio = $state<HTMLAudioElement | null>(null);
	let secondaryAudio = $state<HTMLAudioElement | null>(null);

	const signedIn = $derived(Boolean(data.account) && !data.isLoginPage);

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

	onMount(() => {
		// The login page mounts this layout too. Attaching the player there would
		// fire /api/play-state at an unauthenticated server and log a 401 for
		// nothing, so wire it up only once there is an account behind it.
		if (!signedIn || !primaryAudio || !secondaryAudio) return;
		player.attach(primaryAudio, secondaryAudio, data.settings);
		void restoreQueue();
		return () => player.detach();
	});

	// Settings can change from the settings page while the player is running.
	$effect(() => {
		player.settings = data.settings;
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
		const playing = player.playing ? player.current?.coverArt : null;
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
	 */
	async function restoreQueue() {
		try {
			const response = await fetch('/api/play-state', { headers: { accept: 'application/json' } });
			if (!response.ok) return;
			const state = await response.json();
			if (!Array.isArray(state.songIds) || state.songIds.length === 0) return;

			const songsResponse = await fetch('/api/songs', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ ids: state.songIds })
			});
			if (!songsResponse.ok) return;
			const { songs } = await songsResponse.json();
			await player.restore(songs, {
				index: state.index ?? 0,
				position: state.position ?? 0,
				repeat: state.repeat ?? 'off',
				shuffle: state.shuffle ?? false
			});
		} catch {
			// A missing queue is not worth an error message.
		}
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

		if (!supportsViewTransitions() || prefersReducedMotion()) {
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
		<div class="hh-ambience" aria-hidden="true"></div>

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
		<main class="content" tabindex="0">
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
		padding: var(--float-gap);
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
		transition: grid-template-columns var(--transition);
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
		transition: opacity var(--transition);
	}

	/*
	 * Faded out behind the sliver rather than left showing through it. The
	 * panel's first 44px are a column of padding, a slice of the title and the
	 * left edge of one tool button, and none of that reads as anything.
	 */
	.app:not(.player-open) .body {
		opacity: 0;
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
		transition:
			opacity var(--transition),
			color var(--transition);
	}

	.app:not(.player-open) .grip {
		opacity: 1;
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
		.app,
		.app:not(.player-open) {
			grid-template-areas:
				'rail'
				'content';
			grid-template-columns: minmax(0, 1fr);
			grid-template-rows: auto minmax(0, 1fr);
		}

		.content {
			padding: var(--space-4);
		}

		.player {
			position: fixed;
			inset: calc(var(--rail-height) + var(--float-gap) * 2) var(--float-gap) var(--float-gap);
			z-index: 45;
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

		.app:not(.player-open) .player {
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
		.body,
		.grip {
			transition: none;
		}
	}
</style>
