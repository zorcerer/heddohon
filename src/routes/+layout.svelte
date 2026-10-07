<script lang="ts">
	import '$lib/styles/app.css';
	import { untrack } from 'svelte';
	import { afterNavigate, beforeNavigate, onNavigate, preloadCode, pushState } from '$app/navigation';
	import { navigating, page, updated } from '$app/state';
	import { player } from '$lib/client/player.svelte';
	import { audioOutputs } from '$lib/client/output.svelte';
	import { processing } from '$lib/client/processing.svelte';
	import { remote } from '$lib/client/remote.svelte';
	import { settleStarred } from '$lib/client/favourites.svelte';
	import { together } from '$lib/client/together.svelte';
	import { followCanvas, tintFrom } from '$lib/client/artwork';
	import { ambience } from '$lib/client/ambience.svelte';
	import {
		prefersReducedMotion,
		resetSleeveTokens,
		sleeveTransition,
		supportsViewTransitions
	} from '$lib/client/sleeve-transition.svelte';
	import { handOff } from '$lib/client/handoff';
	import { sheetDrag } from '$lib/client/sheet.svelte';
	import { morphSheet, sheetMorph } from '$lib/client/sheet-morph.svelte';
	import { installPress } from '$lib/client/press';
	import Cover from '$lib/components/Cover.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import NowPlayingPanel from '$lib/components/NowPlayingPanel.svelte';
	import PhoneDock from '$lib/components/PhoneDock.svelte';
	import DevicesDialog from '$lib/components/DevicesDialog.svelte';
	import InstallCard from '$lib/components/InstallCard.svelte';
	import ListeningNow from '$lib/components/ListeningNow.svelte';
	import Reactions from '$lib/components/Reactions.svelte';
	import TogetherDialog from '$lib/components/TogetherDialog.svelte';
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
	 * A shared link is drawn bare, as the login page is, with or without an
	 * account. It plays through its own audio element, so the player is not
	 * attached there. It attaches, and the queue is restored, when a signed-in
	 * visitor goes on into the library.
	 */
	const signedIn = $derived(Boolean(data.account) && !data.isLoginPage && !data.isSharePage);

	/*
	 * The fade in when the app arrives from the login page.
	 *
	 * The login page dissolves itself and then hands over. Without this the
	 * rail, the content and the player appear in one frame.
	 *
	 * Seeded from the value this component was built with, and derived, not set
	 * from an effect: an effect runs after the DOM is updated, one frame after
	 * what the scrim covers has been painted. A cold load of a signed-in page
	 * starts `true`, which is not an arrival and does not animate. Signing out
	 * posts a form, so the browser navigates and this is seeded again.
	 */
	let settled = $state(untrack(() => signedIn));
	const arriving = $derived(signedIn && !settled);

	/**
	 * What the browser tab says. A loaded track wins over the page name. It
	 * follows `current` and not `playing`, so a pause does not flip the tab
	 * back to "Albums".
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
	 * call /api/play-state without a session, so this waits for an account.
	 *
	 * An effect and not `onMount`: signing in is a client-side navigation, the
	 * layout is not torn down, and `onMount` has already run. The player then
	 * stayed unattached and nothing played until a reload. An effect re-runs
	 * when `signedIn` flips, and its teardown detaches on sign-out.
	 *
	 * The audio elements are outside the signed-in branch of the markup, so
	 * they are bound before this runs.
	 */
	$effect(() => {
		if (!signedIn || !primaryAudio || !secondaryAudio) return;
		// The whole call is untracked. The effect below keeps a running player's
		// settings current, and `attach` reads player state on its way: anything
		// read here as a dependency would detach and re-attach the player, which
		// stops playback and restores the queue over itself.
		const primary = primaryAudio;
		const secondary = secondaryAudio;
		untrack(() => player.attach(primary, secondary, data.settings));
		untrack(() => processing.init());
		// Where the headphone database is on, a chosen profile a day old is asked for again.
		untrack(() => {
			if (data.autoeq) void processing.refreshCorrection();
		});
		untrack(() => void audioOutputs.init());
		// Hosting reports what is up next only once the saved queue is back.
		together.after(restoreQueue());
		return () => player.detach();
	});

	/**
	 * The stream that makes this browser one of the account's devices, from
	 * signing in to signing out; see `client/remote.svelte.ts`. Its own effect,
	 * so nothing it reads can detach the player above.
	 */
	$effect(() => {
		if (!signedIn || !data.remoteControl) return;
		untrack(() => remote.start());
		return () => remote.stop();
	});

	// A listen-together party this browser hosts carries on across a reload.
	$effect(() => {
		if (!signedIn || !data.together) return;
		untrack(() => void together.resume());
		return () => together.stop();
	});

	// What this browser plays, for the others: the track, whether it is meant to
	// be playing (`engaged`, which holds across a track change), and the volume.
	// The position goes on its own timer.
	$effect(() => {
		void player.current?.id;
		void player.engaged;
		void player.volume;
		untrack(() => remote.report());
	});

	/**
	 * Every signed-in page, by a path that matches its route. `_` stands in for
	 * an id: preloading fetches a route's code, not its data.
	 */
	const PAGE_PATHS = [
		'/',
		'/library',
		'/albums',
		'/albums/_',
		'/artists',
		'/artists/_',
		'/genres',
		'/radio',
		'/genres/_',
		'/playlists',
		'/playlists/_',
		'/folders',
		'/folders/_',
		'/history',
		'/screen',
		'/stats',
		'/favourites',
		'/search',
		'/settings'
	];

	/**
	 * The code for every page, fetched 3 seconds after signing in.
	 *
	 * The build names each page's code by a hash of its content, and an image
	 * update replaces the build, so files an open tab has not fetched are gone
	 * from the new server. A link to a page not opened before then got a 404,
	 * and SvelteKit loaded the whole page from the server, which stopped
	 * playback (reproduced in the browser suite in Chromium and WebKit). The
	 * whole client is 322 KB of JavaScript before compression.
	 */
	$effect(() => {
		if (!signedIn) return;
		let cancelled = false;
		const timer = setTimeout(async () => {
			for (const path of PAGE_PATHS) {
				if (cancelled) return;
				await preloadCode(path).catch(() => undefined);
			}
		}, 3000);
		return () => {
			cancelled = true;
			clearTimeout(timer);
		};
	});

	/**
	 * A tab that has missed an update takes it on the next page change made
	 * while nothing is playing. SvelteKit checks the server's version every 5
	 * minutes (`version.pollInterval` in `vite.config.ts`). While music plays
	 * the tab keeps its code, since a full page load stops playback.
	 */
	beforeNavigate(({ willUnload, to }) => {
		if (updated.current && !willUnload && to?.url && !player.playing) location.href = to.url.href;
	});

	// Settings can change from the settings page while the player is running.
	$effect(() => {
		player.applySettings(data.settings);
	});

	// `data-theme` is written into the document by the server-side HTML
	// transform, so nothing repaints it when the setting changes in a
	// client-side session. Mirrored here.
	$effect(() => {
		document.documentElement.dataset.theme = data.settings.theme;
		// The phone's bars take the new theme's ground with it; see `followCanvas`.
		followCanvas();
	});

	// The scale is written by the same transform as the theme, and is mirrored
	// the same way.
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
	 * Everything reads `--art-*` by inheritance: the ambient field behind the
	 * page, the accent on the controls, the hover tint on a row. No component
	 * sets its own.
	 *
	 * Reading `coverArt` and not the whole song keeps this from re-running when
	 * another field of the same track changes.
	 */
	$effect(() => {
		// What is playing colours the room. A paused track does not: a restored
		// queue means a track is loaded on every page load, and the colour would
		// never follow the page. A paused track takes the room only when the page
		// offers nothing. `engaged`, not `playing`, which drops for about 17ms at
		// every track change and sent the room to the page's cover and back.
		const playing = player.engaged ? player.current?.coverArt : null;
		// `incoming` outranks `page`: during a navigation the page being left is
		// still mounted and offering its cover.
		void tintFrom(
			document.documentElement,
			playing ?? ambience.incoming ?? ambience.page ?? player.current?.coverArt
		);
	});

	/**
	 * The queue is kept on the server, so it survives a reload and follows the
	 * account to another device. Only ids are stored, and the metadata is
	 * fetched here, so a re-tagged track shows its current details.
	 *
	 * The current track is looked up first and shown, and the rest follows. On
	 * Subsonic every id is its own upstream call, eight at a time, so a queue
	 * of 1000 tracks held the player empty until the last call answered.
	 *
	 * A queue the listener starts while the lookups are out wins: the saved one
	 * is put in only if the player still holds what it held at the start.
	 * Otherwise a track played before the lookup answered was replaced by the
	 * saved queue.
	 *
	 * `newer` is for a page brought back to the front. The saved queue is put
	 * in only if another browser wrote it after the one held here, and only
	 * while nothing plays here. A phone left open for days showed the track it
	 * had held, while the account had played others since.
	 */
	let restoring = false;
	async function restoreQueue(newer = false) {
		if (restoring) return;
		restoring = true;
		try {
			// Untracked: this runs inside the effect that attaches the player, and a
			// read here would make every queue change re-run it.
			const untouched = untrack(() => player.queue);
			const replaced = () => player.queue !== untouched || (newer && !player.idle);
			const response = await fetch('/api/play-state', { headers: { accept: 'application/json' } });
			if (!response.ok) return;
			const state = await response.json();
			if (newer && !(state.updatedAt > player.savedAt)) return;
			if (!Array.isArray(state.songIds) || state.songIds.length === 0) return;
			const ids: string[] = state.songIds;
			const savedIndex = Math.min(Math.max(0, state.index ?? 0), ids.length - 1);
			const settings = {
				repeat: state.repeat ?? 'off',
				shuffle: state.shuffle ?? false,
				orderIds: Array.isArray(state.orderIds) ? (state.orderIds as string[]) : undefined,
				updatedAt: Number(state.updatedAt) || 0
			};

			const [current] = await lookUp([ids[savedIndex]]);
			if (replaced()) return;
			// The track held here is still loaded in its element, and a press on
			// play would start it under the new queue's name.
			if (newer) player.stop();
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
			// saved. The rest comes back without it, and the queue resumes at the
			// same position, from the start of the track now there.
			const songs = await lookUp(ids);
			if (replaced()) return;
			await player.restore(songs, { index: savedIndex, position: 0, ...settings });
		} catch {
			// A missing queue is not worth an error message.
		} finally {
			restoring = false;
		}
	}

	/*
	 * A page brought back to the front (a tab returned to, an installed app
	 * reopened without a reload) asks for the saved queue again; see `newer`
	 * above. `pageshow` is for a page the browser kept whole and put back.
	 */
	$effect(() => {
		if (!signedIn) return;
		const returned = (event: Event) => {
			if (event.type === 'pageshow' && !(event as PageTransitionEvent).persisted) return;
			if (!document.hidden && player.idle) void restoreQueue(true);
		};
		document.addEventListener('visibilitychange', returned);
		window.addEventListener('pageshow', returned);
		return () => {
			document.removeEventListener('visibilitychange', returned);
			window.removeEventListener('pageshow', returned);
		};
	});

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
	 * Hands the navigation to the browser's view transition, which morphs a
	 * clicked sleeve into the album page's hero. Without support, or with
	 * reduced motion, it is an ordinary navigation.
	 */
	onNavigate((navigation) => {
		// The data is here: the wait for it is over. See `waiting`.
		landed = true;

		// A card click points the room at the album it opens. A navigation to
		// anywhere else drops that, so a back button, a rail link or an abandoned
		// click does not inherit it.
		ambience.settle(navigation.to ? navigation.to.url.pathname + navigation.to.url.search : null);

		// Tokens are handed out in render order, so a reset here gives the same
		// page the same numbers, and a back navigation finds the card it left.
		resetSleeveTokens();

		// Back or forward on a phone, or after the system's own animation (a swipe
		// from the edge in Safari, a two-finger swipe on a trackpad): the page is
		// put in at once. Measured on a Pixel 7's viewport on 2026-10-06, a back
		// held the page being left for 172ms under the veil and animated until
		// 663ms, after a gesture that had already shown the move.
		if (navigation.type === 'popstate' && (player.sheetLayout || navigation.event.hasUAVisualTransition)) {
			sleeveTransition.end();
			sleeveTransition.forget();
			// A page opened under a second ago is still rising, and the one
			// returned to would come in item by item under the same class.
			clearTimeout(risingTimer);
			rising = false;
			veil = 'off';
			return;
		}

		// Going back re-arms the names from the outbound trip, so the album hero
		// morphs into the card that opened it.
		if (navigation.type === 'popstate' && navigation.to) {
			const target = navigation.to.url.pathname + navigation.to.url.search;
			if (!sleeveTransition.armReturn(target)) sleeveTransition.end();
		}

		if (prefersReducedMotion()) {
			sleeveTransition.end();
			return;
		}

		// No sleeve in flight: nothing is named, so a view transition would only
		// freeze the page. The page fades through the room instead, when it is a
		// different page and not a new sort or page number of the same one.
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
				// A return trip is good once. Left armed, it would morph the next
				// unrelated back navigation.
				if (navigation.type === 'popstate') sleeveTransition.forget();
			});
		});
	});

	/*
	 * Moving between pages.
	 *
	 * A veil the colour of the room rises over the page being left, the new
	 * page is put in under it, and the veil falls away. It is one plain layer
	 * above the content column and below the rail and the player.
	 *
	 * The glass allows no other shape. A named view transition paints a surface
	 * from a snapshot with nothing behind it to blur: the black rectangle over
	 * the rail on iPadOS and Windows. Fading the page puts its glass under an
	 * ancestor below full opacity, a backdrop root, so each card and button
	 * loses its blur for the fade. The veil is a sibling: nothing under it
	 * changes opacity, and nothing is snapshotted.
	 *
	 * The first half starts once the new page's data has arrived. At 90ms it
	 * read as a flicker, and 150ms is five frames. The second half is the
	 * travel length, and the page rises into place under it (`rising`, below).
	 */
	const VEIL_IN_MS = 150;
	let veil = $state<'off' | 'in' | 'out'>('off');
	const shellShown = $derived(signedIn && Boolean(data.account));

	/*
	 * Waiting for the next page.
	 *
	 * A navigation changes nothing until the next page's data arrives, so on a
	 * slow connection the page appeared to ignore the click. The link pressed
	 * pulses from the press (`.hh-pending` in app.css). After 150ms, the wait
	 * the card play button gives its spinner, a line runs along the top of the
	 * content column and the page being left softens under a layer of the room
	 * with a light blur. The page itself is not dimmed or blurred: a filter or
	 * opacity on an ancestor of glass drops its blur (see the veil above). The
	 * layer is a sibling over it.
	 *
	 * Not while a sleeve is carried into an album page: a layer over the page
	 * would be over the morph.
	 */
	const WAIT_SHOW_MS = 150;
	let waiting = $state(false);
	// Set when the page's data has arrived (`onNavigate`), which ends the wait
	// although the navigation goes on for the veil's 150ms. Counted from the
	// click alone, every page change reached the 150ms and showed the wait.
	let landed = $state(false);

	$effect(() => {
		const going =
			shellShown &&
			navigating.to !== null &&
			!landed &&
			sleeveTransition.activeId === null &&
			!/^\/(login|share)(\/|$)/.test(navigating.to.url.pathname);
		if (!going) {
			waiting = false;
			return;
		}
		const timer = setTimeout(() => (waiting = true), WAIT_SHOW_MS);
		return () => clearTimeout(timer);
	});

	/*
	 * The link pressed, marked from the click until its page arrives. In the
	 * capture phase, since SvelteKit handles the click and cancels its default.
	 * A click that does not navigate is unmarked if no navigation has started
	 * 300ms later.
	 */
	let pendingLink: HTMLAnchorElement | null = null;

	function clearPending() {
		pendingLink?.classList.remove('hh-pending');
		pendingLink = null;
	}

	$effect(() => {
		const onClick = (event: MouseEvent) => {
			if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
			const link = (event.target as Element | null)?.closest?.('a[href]');
			if (!(link instanceof HTMLAnchorElement)) return;
			if (link.target || link.hasAttribute('download') || link.origin !== location.origin) return;
			clearPending();
			pendingLink = link;
			link.classList.add('hh-pending');
			setTimeout(() => {
				if (pendingLink === link && !navigating.to) clearPending();
			}, 300);
		};
		document.addEventListener('click', onClick, true);
		return () => document.removeEventListener('click', onClick, true);
	});

	$effect(() => {
		if (navigating.to) return;
		clearPending();
		landed = false;
	});

	/*
	 * The page arriving: it rises 12px into place while the veil clears, and
	 * any `.hh-stagger` list in it (card grids, track lists) comes in item by
	 * item. Translate on the page, which is not a backdrop root, so its glass
	 * keeps its blur, and opacity only on the list items, which hold none. Only
	 * for a navigation: a server-rendered page is whole in its first paint.
	 *
	 * Held for the longest of those animations (the travel length plus 12 items
	 * of stagger): taking the class off early would snap the late items into
	 * place.
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
	 * SvelteKit does both for the document and nothing for an element scrolling
	 * inside it, so the column kept one position for every page: an album
	 * opened from 400px down the library opened 400px down its own page. A new
	 * sort or page number of the same page keeps its place, as those links ask
	 * with `data-sveltekit-noscroll`. SvelteKit restores the snapshot on Back
	 * after the new page is in and before the view transition takes its
	 * picture, so the sleeve's way back finds the card where it was.
	 *
	 * On a narrow screen the document scrolls and SvelteKit handles it.
	 */
	let content = $state<HTMLElement | null>(null);

	afterNavigate(({ type, from, to }) => {
		if (type === 'enter' || type === 'popstate') return;
		if (from?.url.pathname === to?.url.pathname) return;
		// `instant`: the column scrolls smoothly for everything else.
		content?.scrollTo({ top: 0, behavior: 'instant' });
	});

	/*
	 * On a phone the sheet turns into the dock as it closes and back out of it
	 * as it opens (`client/sheet-morph.svelte.ts`), whatever opened or closed
	 * it. Watched here, before the page is updated, so the wrapper is held for
	 * the morph in the update that would otherwise start the CSS slide.
	 *
	 * Not the change `attach()` makes as it learns the width: on a phone that
	 * closes the sheet the server rendered open, which nobody saw open.
	 */
	let wasOpen = untrack(() => player.panelOpen);
	let wasKnown = untrack(() => player.viewportKnown);
	$effect.pre(() => {
		const open = player.panelOpen;
		const known = player.viewportKnown;
		const changed = open !== wasOpen && wasKnown;
		wasOpen = open;
		wasKnown = known;
		if (!changed) return;
		untrack(() => {
			if (player.sheetLayout && player.current && !prefersReducedMotion()) morphSheet(open);
		});
	});

	// Hearts pressed before this page loaded are in its data now; see
	// `settleStarred`.
	//
	// On a phone the sheet covers the page, so a link followed from inside it
	// (the artist, the album, the artwork) opened a page nobody could see. The
	// sheet goes down by itself.
	afterNavigate(({ type }) => {
		if (type !== 'enter') settleStarred();
	});

	afterNavigate(({ type }) => {
		// Back to an entry the sheet was open over leaves it to the effect below.
		if (type === 'enter' || !player.sheetLayout || !player.panelOpen || page.state.sheet) return;
		player.togglePanel();
	});

	/*
	 * On a phone the open sheet is an entry in the history, so the system's
	 * back (a swipe from the edge, the back button) closes the sheet and leaves
	 * the page under it where it was. Without one, a back with the sheet open
	 * went back a page nobody could see, and the sheet closed over a different
	 * page than it had opened on.
	 *
	 * Opening adds the entry (`pushState`, which loads nothing). Closing from
	 * the sheet itself (its chevron, a pull down) steps back off it. `leaving`
	 * is set for that step: a sheet opened again before the step lands gets a
	 * new entry and stays open. A link followed from inside the sheet replaces
	 * the entry (`data-sveltekit-replacestate` on the wrapper), so a back from
	 * the page it opened returns to the page under the sheet, with the sheet
	 * down.
	 */
	let leaving = false;
	$effect(() => {
		const open = player.panelOpen;
		const phone = player.sheetLayout && player.viewportKnown;
		untrack(() => {
			if (!phone || !signedIn) return;
			if (open && !page.state.sheet && !leaving) pushState('', { ...page.state, sheet: true });
			else if (!open && page.state.sheet && !leaving) {
				leaving = true;
				history.back();
			}
		});
	});
	$effect(() => {
		const marked = page.state.sheet === true;
		untrack(() => {
			if (!player.sheetLayout || !player.viewportKnown) return;
			if (leaving && !marked) {
				leaving = false;
				if (player.panelOpen) pushState('', { ...page.state, sheet: true });
				return;
			}
			if (marked !== player.panelOpen) player.togglePanel();
		});
	});

	export const snapshot: Snapshot<number> = {
		capture: () => content?.scrollTop ?? 0,
		restore: (top) => content?.scrollTo({ top, behavior: 'instant' })
	};

	function showPanel() {
		player.togglePanel();
		// The tool row's chevron closes it again, so the keyboard goes there once
		// the sliver it was on is inert.
		void handOff('player-hide');
	}

	function onKeydown(event: KeyboardEvent) {
		// The living-room screen takes these keys itself, with more of its own.
		if (!signedIn || data.isScreenPage) return;
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
		title element. A loaded track shows here on every page, and with nothing
		loaded the page's own title stands, in the server-rendered HTML too.
	-->
	<title>{tabTitle ?? data.appName}</title>
	<meta name="description" content="High-resolution music player for your own library." />
	<meta name="color-scheme" content="dark light" />
	<!-- The label under the home-screen icon on iOS, which reads this and not
	     the manifest. -->
	<meta name="apple-mobile-web-app-title" content={data.appName} />
</svelte:head>

<!--
  Two audio elements, alternating. The one not producing sound pre-buffers the
  next track, so the handoff does not wait on the network. `crossorigin` is
  unset: these are same-origin proxy URLs.
-->
<audio bind:this={primaryAudio} preload="metadata"></audio>
<audio bind:this={secondaryAudio} preload="none"></audio>

{#if signedIn && data.account && !data.isScreenPage}
	<div
		class="app"
		class:player-open={player.panelOpen}
		class:viewport-known={player.viewportKnown}
		class:has-song={Boolean(player.current)}
	>
		<!-- The room, and the aurora drifting in it when turned on; see `.aurora` in app.css. -->
		<div class="hh-ambience" aria-hidden="true">
			{#if data.settings?.aurora === 'moving' || data.settings?.aurora === 'still'}
				<div class="aurora" class:still={data.settings.aurora === 'still'}></div>
			{/if}
		</div>

		<Sidebar appName={data.appName} />
		<PhoneDock />

		<!--
			Focusable on purpose, like the lyrics body. With no scrollbar the
			keyboard has to be able to scroll this: WCAG 2.1.1 does not allow a
			scrollable region to be keyboard-unreachable. Chrome makes overflow
			containers focusable and Safari does not. The rule below does not
			model scrollable regions.
		-->
		<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
		<main class="content" class:rising tabindex="0" bind:this={content}>
			{@render children()}
		</main>

		<!--
			Closing the panel does not unmount it. Its column narrows to the
			sliver, which leaves the panel overhanging the right-hand edge with a
			44px strip on screen. That strip is a button that brings the panel
			back. See `.dock` below.
		-->
		<div
			class="player"
			data-sveltekit-replacestate={page.state.sheet ? '' : undefined}
			class:dragging={sheetDrag.offset !== null}
			class:morphing={sheetMorph.phase === 'morphing'}
			class:parking={sheetMorph.phase === 'parking'}
			style:translate={sheetDrag.offset !== null ? `0 ${sheetDrag.offset}px` : undefined}
		>
			<div class="dock">
				<div class="body" inert={!player.panelOpen}>
					<NowPlayingPanel showQualityBadge={data.settings.showQualityBadge} />
				</div>

				<!--
					The sliver's own face: the cover, the track and the way back. A raw
					crop of the panel's first 44px would show half a title and a
					sliced button.
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
		<DevicesDialog />
		{#if data.together}
			<TogetherDialog />
			<Reactions reactions={together.reactions} />
		{/if}
		{#if data.sharing}
			<ShareDialog />
		{/if}
		{#if data.listeners}
			<ListeningNow backend={data.account.backend} username={data.account.username} />
		{/if}
		<!-- Not on a cast receiver's page, which only a Cast device opens. -->
		{#if !page.url.pathname.startsWith('/cast/')}
			<InstallCard appName={data.appName} dismissed={data.settings.installCardDismissed} />
		{/if}

		<!-- Waiting for the next page; see `waiting`. Always present, and hidden
		     while not waiting, so it fades both ways. -->
		<div class="wait-veil hh-ambience" class:waiting aria-hidden="true"></div>
		<div class="nav-progress" class:waiting role="progressbar" aria-label="Loading the page" aria-hidden={!waiting}>
			<span></span>
		</div>

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
			<!-- Repeats the page's own ground, so what fades away here is what the
			     login page left on screen. -->
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
	 * and the queue sit on it as separate panes with air around them, so each
	 * has something behind it to blur.
	 */
	/*
	 * The scrim that covers the arrival from the login page.
	 *
	 * The scrim fades out; the app does not fade in. An element below opacity 1
	 * is a backdrop root, so fading the app would take the blur off the rail
	 * and the player for the animation. This is a sibling, so every glass
	 * surface under it stays at opacity 1 and is only revealed.
	 *
	 * It borrows `.hh-ambience` for the wash and the ground. The z-index has to
	 * outrank that class, hence the descendant selector.
	 *
	 * It rests at 0 and is animated from 1, so a browser that never runs the
	 * animation is not left under an opaque sheet.
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
	 * own grid cell, so none of it is behind the rail or the player.
	 *
	 * At first it covered the whole screen, under the rail and the player. In
	 * Chromium they looked the same over it. In Safari and Firefox both went
	 * dark for a moment on every page change: a layer animating its opacity
	 * behind `backdrop-filter` is not blurred cleanly there while it moves.
	 *
	 * `.hh-ambience` places it fixed over the viewport, and the grid cell
	 * replaces that. The room's gradients are attached to the viewport, so the
	 * veil matches what is around it. iOS Safari ignores
	 * `background-attachment: fixed` and draws them against the cell, which
	 * shifts the wash slightly for the 350ms the veil is up.
	 *
	 * Rests at 0 and is animated up, then down from 1, so a browser that never
	 * runs the animation is not left under an opaque sheet.
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

	/*
	 * The page being left, softened while the next one loads: the room at 45
	 * percent over it, with a 3px blur of its own. Placed as the veil is, in
	 * the content cell. It is glass itself, so its opacity is its own, and the
	 * page under it is left alone.
	 */
	.app .wait-veil {
		grid-area: content;
		position: relative;
		inset: auto;
		background-attachment: fixed;
		z-index: 1;
		opacity: 0;
		visibility: hidden;
		pointer-events: none;
		-webkit-backdrop-filter: blur(3px);
		backdrop-filter: blur(3px);
		transition:
			opacity var(--dur-hover) var(--ease-out),
			visibility 0s linear var(--dur-hover);
	}

	.app .wait-veil.waiting {
		opacity: 0.45;
		visibility: visible;
		transition:
			opacity var(--dur-state) var(--ease-out),
			visibility 0s linear 0s;
	}

	/* A line along the top of the content column, the accent sweeping across it
	   while the page loads. Over the wait layer, and in the content cell only. */
	.nav-progress {
		grid-area: content;
		align-self: start;
		position: relative;
		z-index: 2;
		height: 2px;
		margin: 0 var(--space-5);
		border-radius: var(--r-pill);
		overflow: hidden;
		opacity: 0;
		transition: opacity var(--dur-hover) var(--ease-out);
		pointer-events: none;
	}

	.nav-progress.waiting {
		opacity: 1;
	}

	.nav-progress span {
		display: block;
		width: 35%;
		height: 100%;
		border-radius: inherit;
		background: var(--accent);
		box-shadow: 0 0 8px color-mix(in srgb, var(--accent) 60%, transparent);
		animation: nav-sweep 1.1s var(--ease-colour) infinite;
	}

	/* Held while the line is hidden. Running, it kept every page drawing
	   frames with nothing on screen moving: 60 style passes a second in
	   Chromium on an idle page. */
	.nav-progress:not(.waiting) span {
		animation-play-state: paused;
	}

	@keyframes nav-sweep {
		from {
			translate: -100% 0;
		}
		to {
			translate: 300% 0;
		}
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
		 * The player track is a maximum, not a fixed width. The content track,
		 * whose minimum is zero, gives its space up first, so this is the same
		 * 24rem column at every ordinary width. Where the grid has less room
		 * than the tracks want, the panel narrows and the row does not overflow.
		 *
		 * It is not what stops the panel being clipped when the layout is wider
		 * than the window: there the grid has more room than it needs, and the
		 * body's own width fixes it.
		 */
		grid-template-columns: var(--rail-width) minmax(0, 1fr) minmax(0, var(--player-width));
		gap: var(--float-gap);
		padding: var(--edge-top) var(--edge-right) var(--edge-bottom) var(--edge-left);
		height: 100vh;
		height: 100dvh;
		/*
		 * The closed panel overhangs the right-hand edge, and the part past the
		 * edge is cut off here. `clip`, not `hidden`, which makes this a scroll
		 * container and pairs only with `hidden` on the other axis, trapping the
		 * dialog and the ambient wash in a box the height of the grid.
		 */
		overflow-x: clip;
	}

	/*
	 * Closed, the column narrows to the sliver in one step, once the panel has
	 * left (the delay below), and the content takes the space back in one
	 * layout. Opening, it widens at once and the panel arrives in the empty
	 * column. The panel does the moving, by `translate` (see `.dock`), and
	 * only ever over the room: glass sliding over the page would blur a new
	 * backdrop on every frame.
	 *
	 * Until 2026-10-08 the column's width was what animated, and the panel
	 * rode its edge: a layout of the page on every frame of the slide. On an
	 * iPad Pro in landscape the slide was reported as a few frames a second.
	 * Headless at 1194x834 and twice the pixels, on the album grid with the
	 * aurora off, in the 700ms around a press: Chromium laid the page out 29
	 * times closing and 22 opening (21ms and 20ms), now 6 to 9 and 4 (2ms and
	 * 1ms). WebKit drew 8 frames opening and 7 to 8 closing, now 25 to 26 and
	 * 11 to 12.
	 */
	.app:not(.player-open) {
		grid-template-columns: var(--rail-width) minmax(0, 1fr) minmax(0, var(--player-sliver));
		transition: grid-template-columns 0s linear var(--slide-duration);
	}

	.content {
		grid-area: content;
		position: relative;
		z-index: 1;
		overflow-y: auto;
		/* A record protruding from a card in the last column would push out a
		   horizontal scrollbar. `clip` pairs with `auto`, and `hidden` does not. */
		overflow-x: clip;
		/* The player is a column beside this, so the content reserves no strip
		   for it. */
		padding: var(--space-5);
		scroll-behavior: smooth;
	}

	/*
	 * Every page sets its own maximum width, a reading measure: a track row
	 * 2800px wide puts the title and the duration at opposite ends of a 32:9
	 * monitor. Centring is applied here, so a new route cannot forget it. The
	 * rule does nothing to a page that sets no maximum.
	 */
	.content > :global(*) {
		margin-inline: auto;
	}

	/*
	 * A column of its own, full height, beside the content. Docked, it reflows
	 * the page once when toggled. An always-open overlay would cover a strip of
	 * the page.
	 */
	.player {
		grid-area: player;
		min-height: 0;
		position: relative;
		/* Over the page veil. */
		z-index: 2;
	}

	/*
	 * Pinned to the right-hand edge of the column, which does not move, and
	 * holding the panel's full width whatever the column is doing. Closed, it
	 * is moved right by the width the column gave up, so its left edge sits on
	 * the sliver and the rest overhangs the screen. Open and closed differ in
	 * `translate` alone, which the compositor runs without a layout, and a
	 * press during the slide turns it round from where it is.
	 */
	.dock {
		position: absolute;
		inset: 0 0 0 auto;
		width: var(--player-width);
		translate: none;
		transition: translate var(--slide);
	}

	.app:not(.player-open) .dock {
		translate: calc(var(--player-width) - var(--player-sliver)) 0;
	}

	.body {
		height: 100%;
		visibility: visible;
		transition: visibility 0s linear 0s;
	}

	/*
	 * Hidden behind the sliver. The panel's first 44px are padding, a slice of
	 * the title and the edge of one tool button.
	 *
	 * Hidden once the slide has finished, not faded while it runs. An ancestor
	 * below full opacity is a backdrop root: during a fade the panel's glass
	 * lost its blur and its darkening and showed the page through it, then
	 * snapped back, on every close.
	 */
	.app:not(.player-open) .body {
		visibility: hidden;
		transition: visibility 0s linear var(--slide-duration);
	}

	/*
	 * The sliver. It covers the part of the column still on screen. `inert` on
	 * the two of them keeps the hidden one out of the tab order and the
	 * accessibility tree, so the opacity here concerns paint only.
	 */
	.grip {
		position: absolute;
		inset: 0 auto 0 0;
		/* Wider than the column by the gap the grid keeps around every floating
		   panel, so the strip reaches the edge of the screen. With air on its
		   right it does not read as continuing off frame. */
		width: calc(var(--player-sliver) + var(--float-gap));
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: var(--space-3);
		padding: var(--space-3) var(--space-2);
		/* `.hh-float` supplies the edge and the shadow, as on every floating
		   pane. The right-hand side is not an edge: the panel carries on past
		   the screen there. */
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

	/* Set down the strip, not across it: a 44px column cannot hold a horizontal
	   title at a readable size. */
	.grip-title {
		flex: 1 1 auto;
		min-height: 0;
		writing-mode: vertical-rl;
		/* A button centres its text, which in a vertical writing mode centres it
		   down the strip, 300px below the cover it belongs to. */
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
	 * Too narrow for two columns and a rail. The rail gives way to the dock at
	 * the foot of the screen (`PhoneDock.svelte`), and the player becomes a
	 * sheet over the content: a full-screen now-playing view.
	 */
	@media (max-width: 60rem) {
		/*
		 * The document scrolls here, not the content column. Safari on iOS 26
		 * draws the page behind its toolbar, and under the status bar once
		 * scrolled, only from the document's own scroll. A column scrolling
		 * inside a box one screen tall ended at the top of the toolbar: on an
		 * iPhone the page stopped about 150pt above the bottom of the screen.
		 * The document scroll is also what Safari folds its toolbar away on,
		 * and what a tap on the status bar returns to the top.
		 *
		 * The grid grows with the page and is at least one screen tall. `svh`,
		 * not `dvh`, which grows as the toolbar folds away: a page between the
		 * two heights would grow with it and have nothing left to scroll.
		 *
		 * The content is the one cell. Its foot is padded by the dock's height
		 * and the air under it, so the last row scrolls clear of the dock.
		 */
		.app {
			--dock-height: var(--dock-tabs);
			--dock-space: calc(var(--dock-height) + var(--edge-bottom) + var(--float-gap));
		}

		.app.has-song {
			--dock-height: calc(var(--dock-now) + var(--dock-tabs) + 1px);
		}

		.app,
		.app:not(.player-open) {
			grid-template-areas: 'content';
			grid-template-columns: minmax(0, 1fr);
			grid-template-rows: minmax(0, 1fr);
			height: auto;
			min-height: 100svh;
			padding-bottom: var(--dock-space);
			transition: none;
		}

		.content {
			overflow-y: visible;
			padding: var(--space-4) var(--space-2) var(--space-4);
		}

		/*
		 * A jump to an anchor lands clear of the status bar at the top and of
		 * the dock at the foot.
		 *
		 * `none` turns pull-to-refresh off, which the document scroll would
		 * offer: a pull past the top would reload the page and stop playback.
		 *
		 * Only with the app on the page: the sign-in and shared-link pages have
		 * no dock.
		 */
		:global(html:has(.app)) {
			scroll-padding-top: var(--edge-top);
			scroll-padding-bottom: calc(var(--dock-tabs) + var(--dock-now) + var(--edge-bottom) + var(--float-gap));
			overscroll-behavior-y: none;
		}

		/*
		 * The open sheet covers the page. Without this, a wheel over it scrolled
		 * the document underneath in Chromium, and a drag would scroll it in
		 * Safari and fold the toolbar away. Only once the client knows the
		 * width: the server renders the panel open.
		 */
		:global(html:has(.app.player-open.viewport-known)) {
			overflow: hidden;
		}

		/*
		 * Under the status bar, where the page scrolls behind the clock once it
		 * is on the home screen and runs full screen: the dock's frosted glass,
		 * the height of the status bar, so the time and the battery are not set
		 * over a line of type. Zero tall in a browser tab, which draws its own
		 * bar there.
		 */
		.app::after {
			content: '';
			position: fixed;
			inset: 0 0 auto;
			height: env(safe-area-inset-top, 0px);
			z-index: 39;
			background: color-mix(in srgb, var(--bg-surface) 72%, transparent);
			-webkit-backdrop-filter: blur(18px);
			backdrop-filter: blur(18px);
			pointer-events: none;
		}

		/*
		 * iOS writes the clock, the signal and the battery in white over an
		 * installed app that draws under them (`black-translucent` in
		 * app.html), in the light theme too, where frosted parchment would leave
		 * them unreadable. So the strip is smoked there: white on it measures
		 * 7.2 to 1 over the parchment ground.
		 */
		:global([data-theme='light']) .app::after {
			background: rgb(38 30 22 / 0.72);
		}

		/*
		 * The content cell runs the length of the page here and passes behind
		 * the dock, and a layer fading behind glass darkens it in Safari and
		 * Firefox (see the veil above). So the veil is fixed to the screen,
		 * ending the float gap above the dock.
		 *
		 * iOS Safari draws the wash against the veil's own box, which fixed is
		 * the screen less the dock and not the whole length of the page.
		 */
		.app .page-veil,
		.app .wait-veil {
			position: fixed;
			inset: var(--edge-top) var(--edge-right) var(--dock-space) var(--edge-left);
		}

		/* At the top of the screen, under the status bar, as the page scrolls. */
		.nav-progress {
			position: fixed;
			top: var(--edge-top);
			left: var(--edge-left);
			right: var(--edge-right);
			margin: 0 var(--space-2);
		}

		/*
		 * The sheet covers the whole screen, the dock included, with the gap
		 * every floating panel keeps. It slides up from below the screen and
		 * back down with `translate`, which the compositor runs without a
		 * layout, and rests at `none`, so an open sheet carries no transform.
		 * The transform is on this wrapper and not on the glass inside it, and
		 * a transform is not a backdrop root, so the panel keeps its blur.
		 *
		 * Closed, it is hidden once it has gone, which takes it out of
		 * hit-testing. `inert` on the body keeps it out of the tab order.
		 */
		.player {
			position: fixed;
			inset: var(--edge-top) var(--edge-right) var(--edge-bottom) var(--edge-left);
			/* A phone's width at most, centred, as the dock is. On a tablet held
			   upright (820px) the full width made the artwork a crop about 800px
			   tall. */
			max-width: 34rem;
			margin-inline: auto;
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

		/*
		 * Following a finger that is pulling it down (`client/sheet.svelte.ts`).
		 * The offset is an inline `translate`, and the transition comes back on
		 * with the class, so a release carries on from where the finger let go.
		 */
		.player.dragging {
			transition: none;
		}

		/*
		 * Turning into the dock or out of it (`client/sheet-morph.svelte.ts`):
		 * held where the morph's transform can move it, whichever way
		 * `player-open` says it is going. Then, for one frame after a close, the
		 * closed state lands without its slide.
		 */
		.app .player.morphing,
		.app:not(.player-open) .player.morphing {
			translate: none;
			visibility: visible;
			transition: none;
		}

		.app .player.parking,
		.app:not(.player-open) .player.parking {
			transition: none;
		}

		.dock,
		.app:not(.player-open) .dock {
			position: static;
			width: auto;
			height: 100%;
			translate: none;
			transition: none;
		}

		/* A sheet over the library has no right-hand edge for a sliver. Closed
		   means gone here, and the dock carries the way back. */
		.grip {
			display: none;
		}

		/*
		 * The server renders the panel, which is right for a screen wide enough
		 * to hold it as a column. Here it would be a sheet over the library, so
		 * it stays hidden until the client knows the width: see `viewportKnown`
		 * on the player.
		 */
		.app:not(.viewport-known) .player {
			display: none;
		}
	}

	/* Without the slide, the column snaps to its new width and the sliver
	   appears in place. */
	@media (prefers-reduced-motion: reduce) {
		.app:not(.player-open),
		.dock,
		.app:not(.player-open) .dock,
		.body,
		.app:not(.player-open) .body,
		.grip,
		.app:not(.player-open) .grip,
		.player,
		.app:not(.player-open) .player {
			transition: none;
		}
	}

	/* Loading without the sweep: the line held across the column, dimmed. */
	@media (prefers-reduced-motion: reduce) {
		.nav-progress span {
			width: 100%;
			opacity: 0.6;
			animation: none;
		}
	}
</style>
