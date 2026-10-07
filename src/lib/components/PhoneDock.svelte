<script lang="ts">
	/**
	 * The navigation and the player on a phone: one floating slab at the foot
	 * of the screen, with what is playing above four destinations.
	 *
	 * It replaced a bar of nine icons across the top, far from the thumb, which
	 * left nothing of the player on screen once the sheet was closed. Here play
	 * and pause, the next track and the way into the sheet are one tap away.
	 *
	 * Four destinations, not seven. Albums, artists, playlists and genres are
	 * one tab, Library, which opens a page listing them, and Settings is
	 * reached from there too. Four with their labels fit a 320px screen at 80px
	 * each.
	 *
	 * Wider than 60rem this is not shown, and the rail and the docked panel do
	 * its job.
	 */
	import { afterNavigate } from '$app/navigation';
	import { navigating, page } from '$app/state';
	import { player } from '$lib/client/player.svelte';
	import { handOff } from '$lib/client/handoff';
	import { DUR, EASE_OUT_CSS, popGlyph, skipGlyph } from '$lib/client/motion';
	import { prefersReducedMotion } from '$lib/client/sleeve-transition.svelte';
	import Cover from './Cover.svelte';
	import Icon from './Icon.svelte';

	const TABS = [
		{ href: '/', label: 'Home', icon: 'home' as const, pattern: /^\/$/ },
		{
			href: '/library',
			label: 'Library',
			icon: 'library' as const,
			// Everything the Library page lists, and Settings, which it links to.
			pattern: /^\/(library|albums|artists|genres|playlists|folders|history|stats|screen|settings)(\/|$)/
		},
		{ href: '/favourites', label: 'Favourites', icon: 'heart' as const, pattern: /^\/favourites(\/|$)/ },
		{ href: '/search', label: 'Search', icon: 'search' as const, pattern: /^\/search(\/|$)/ }
	];

	// The page being opened while it loads, then that page, as the rail does.
	// Following the address alone, the tab lit only once the next page's data
	// had arrived.
	const path = $derived(navigating.to?.url.pathname ?? page.url.pathname);
	const activeIndex = $derived(TABS.findIndex((tab) => tab.pattern.test(path)));

	const song = $derived(player.current);
	const progress = $derived(player.duration > 0 ? Math.min(1, player.currentTime / player.duration) : 0);

	/*
	 * Folded while scrolling down the page, unfolded scrolling back up, as
	 * Safari's own toolbar does. Only with a track loaded, so something of the
	 * dock is always on screen, and never within the first screen of a page or
	 * at its foot.
	 *
	 * 24px of travel either way before it changes, so a resting finger's small
	 * movements do not open and shut it.
	 */
	let folded = $state(false);
	$effect(() => {
		let anchor = scrollY;
		const onScroll = () => {
			const y = scrollY;
			const atFoot = y + innerHeight >= document.documentElement.scrollHeight - 8;
			if (y < innerHeight * 0.5 || atFoot) {
				folded = false;
				anchor = y;
			} else if (y - anchor > 24) {
				folded = true;
				anchor = y;
			} else if (anchor - y > 24) {
				folded = false;
				anchor = y;
			} else if (folded ? y > anchor : y < anchor) {
				anchor = y;
			}
		};
		addEventListener('scroll', onScroll, { passive: true });
		return () => removeEventListener('scroll', onScroll);
	});

	afterNavigate(() => {
		folded = false;
	});

	function openPlayer() {
		if (!player.panelOpen) player.togglePanel();
		// The sheet's own close control, now that this one is under it.
		void handOff('player-hide');
	}

	/*
	 * Swiping the track: sideways goes to the next or the previous one, the
	 * title following the finger until it goes, and upward opens the sheet.
	 * The row takes every touch (`touch-action: none`): it is fixed chrome,
	 * which the page does not scroll by.
	 */
	const SWIPE = 56;
	let swipe = $state<{ id: number; x: number; y: number; dx: number; axis: 'x' | 'y' | null } | null>(null);
	let swallowClick = false;

	function down(event: PointerEvent) {
		if (event.button !== 0 || !song) return;
		swallowClick = false;
		swipe = { id: event.pointerId, x: event.clientX, y: event.clientY, dx: 0, axis: null };
	}

	function moveSwipe(event: PointerEvent) {
		if (!swipe || event.pointerId !== swipe.id) return;
		const dx = event.clientX - swipe.x;
		const dy = event.clientY - swipe.y;
		if (!swipe.axis) {
			if (Math.hypot(dx, dy) < 10) return;
			swipe.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
			(event.currentTarget as Element).setPointerCapture(event.pointerId);
		}
		if (swipe.axis === 'x') swipe.dx = dx;
		else if (dy < -SWIPE) {
			swipe = null;
			swallowClick = true;
			openPlayer();
		}
	}

	function up(event: PointerEvent) {
		if (!swipe || event.pointerId !== swipe.id) return;
		const { axis, dx } = swipe;
		swipe = null;
		if (!axis) return;
		swallowClick = true;
		if (axis !== 'x') return;
		if (dx <= -SWIPE && player.hasQueue) void player.next();
		else if (dx >= SWIPE && player.hasQueue) void player.previous();
	}

	function clickCapture(event: MouseEvent) {
		if (!swallowClick) return;
		swallowClick = false;
		event.preventDefault();
		event.stopPropagation();
	}

	// The title slides in from the side the track came from, as in the sheet.
	// Not on the first render.
	let shownFor: string | null | undefined = undefined;
	function arrive(key: string | null) {
		return (node: HTMLElement) => {
			const first = shownFor === undefined;
			const changed = shownFor !== key;
			shownFor = key;
			if (first || !changed || prefersReducedMotion()) return;
			const animation = node.animate(
				[
					{ opacity: 0, translate: `${player.direction * 2}rem 0` },
					{ opacity: 1, translate: '0 0' }
				],
				{ duration: DUR.state, easing: EASE_OUT_CSS }
			);
			return () => animation.cancel();
		};
	}
</script>

<!-- `inert` while the sheet is up: the sheet covers this and its controls answer. -->
<div
	class="phone-dock hh-glass hh-glass--deep hh-tint-morph hh-float"
	class:folded={folded && song}
	class:playing={Boolean(song)}
	class:covered={player.sheetLayout && player.panelOpen}
	inert={player.sheetLayout && player.panelOpen}
>
	{#if song}
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			class="now"
			class:swiping={swipe?.axis === 'x'}
			onpointerdown={down}
			onpointermove={moveSwipe}
			onpointerup={up}
			onpointercancel={() => (swipe = null)}
			onclickcapture={clickCapture}
		>
			<button
				id="dock-open"
				class="open"
				type="button"
				onclick={openPlayer}
				aria-label="Show the player: {song.title}{song.artist ? `, ${song.artist}` : ''}"
			>
				<span class="art">
					<Cover coverArt={song.coverArt} size={96} alt="" radius="var(--r-sm)" />
				</span>
				<span
					class="text"
					style:translate={swipe?.axis === 'x' ? `${swipe.dx * 0.6}px 0` : undefined}
					style:opacity={swipe?.axis === 'x' ? Math.max(0.2, 1 - Math.abs(swipe.dx) / 220) : undefined}
					{@attach arrive(song.id)}
				>
					<span class="title hh-truncate">{song.title}</span>
					<span class="artist hh-truncate">{song.artist ?? 'Unknown artist'}</span>
				</span>
			</button>

			<button
				class="control play"
				type="button"
				onclick={(event) => {
					popGlyph(event.currentTarget);
					void player.toggle();
				}}
				aria-label={player.playing ? 'Pause' : 'Play'}
			>
				{#if player.loading && player.playing}
					<span class="spinner" aria-hidden="true"></span>
				{:else}
					<Icon name={player.playing ? 'pause' : 'play'} size={24} strokeWidth={2.6} />
				{/if}
			</button>
			<button
				class="control"
				type="button"
				onclick={(event) => {
					skipGlyph(event.currentTarget, 1);
					void player.next();
				}}
				disabled={!player.hasQueue}
				aria-label="Next track"
			>
				<Icon name="skip" size={22} />
			</button>

			<span class="progress" aria-hidden="true" style:scale="{progress} 1"></span>
		</div>
	{/if}

	<div class="fold">
		<nav class="tabs" aria-label="Primary" style:--active={activeIndex}>
			<span class="lens" class:gone={activeIndex < 0} aria-hidden="true"></span>
			{#each TABS as tab, index (tab.href)}
				<a
					class="tab"
					class:active={index === activeIndex}
					href={tab.href}
					aria-current={index === activeIndex ? 'page' : undefined}
				>
					<Icon name={index === activeIndex && tab.icon === 'heart' ? 'heart-filled' : tab.icon} size={21} />
					<span class="label">{tab.label}</span>
				</a>
			{/each}
		</nav>
	</div>
</div>

<style>
	.phone-dock {
		display: none;
	}

	@media (max-width: 60rem) {
		/*
		 * Fixed to the foot of the screen, clear of the home indicator by the gap
		 * every floating panel keeps. The page scrolls under it, and the layout
		 * pads the foot of the page by `--dock-space` so the last row scrolls
		 * clear.
		 */
		.phone-dock {
			position: fixed;
			left: var(--edge-left);
			right: var(--edge-right);
			bottom: var(--edge-bottom);
			/* Over the page veil and the content; under the sheet (45) and dialogs. */
			z-index: 40;
			display: flex;
			flex-direction: column;
			border-radius: var(--r-xl);
			overflow: hidden;
			/* As dense as the sheet: the page scrolls under this, and at the
			   docked panel's 66 percent a row of titles read through the tab
			   labels. */
			--glass-base: 88%;
			transition: visibility 0s linear 0s;
			/* A phone's width at most, centred: on a tablet held upright, four
			   tabs across 800px put Home and Search a hand apart. */
			max-width: 34rem;
			margin-inline: auto;
		}

		/*
		 * Under the open sheet, which is 92 percent opaque, the tab labels showed
		 * through its tool row. Hidden once the sheet has arrived, and back when
		 * it starts to leave.
		 */
		.phone-dock.covered {
			visibility: hidden;
			transition: visibility 0s linear var(--dur-travel);
		}

		/* ── What is playing ─────────────────────────────────────────── */

		.now {
			position: relative;
			display: flex;
			align-items: center;
			gap: var(--space-1);
			height: var(--dock-now);
			padding: 0 var(--space-2) 0 var(--space-2);
			touch-action: none;
			user-select: none;
			-webkit-user-select: none;
		}

		.open {
			flex: 1;
			min-width: 0;
			height: 100%;
			display: flex;
			align-items: center;
			gap: var(--space-3);
			padding: 0;
			text-align: left;
			color: inherit;
		}

		.art {
			flex: none;
			width: 2.75rem;
			height: 2.75rem;
			border-radius: var(--r-sm);
			box-shadow: 0 2px 10px rgb(0 0 0 / 0.28);
		}

		.text {
			flex: 1;
			min-width: 0;
			display: grid;
			gap: 1px;
		}

		.swiping .text {
			transition: none;
		}

		.now:not(.swiping) .text {
			transition:
				translate var(--dur-state) var(--ease-spring),
				opacity var(--dur-hover) var(--ease-out);
		}

		.title {
			font-size: 0.9375rem;
			font-weight: 650;
			color: var(--text-strong);
			text-shadow: var(--text-shade);
		}

		.artist {
			font-size: 0.8125rem;
			color: var(--text-muted-through);
			text-shadow: var(--text-shade);
		}

		.control {
			flex: none;
			display: grid;
			place-items: center;
			width: 2.75rem;
			height: 2.75rem;
			border-radius: var(--r-pill);
			color: var(--text-strong);
			transition:
				color var(--transition),
				scale var(--dur-press) var(--ease-out);
		}

		.control:active {
			scale: 0.88;
			background: var(--bg-hover);
		}

		.control:disabled {
			opacity: 0.35;
		}

		.spinner {
			width: 1.25rem;
			height: 1.25rem;
			border: 2px solid currentColor;
			border-right-color: transparent;
			border-radius: 50%;
			animation: spin 0.8s linear infinite;
		}

		@keyframes spin {
			to {
				rotate: 1turn;
			}
		}

		/*
		 * How far into the track, as a line along the foot of the row. Scaled,
		 * not resized, so each tick is a composited change and not a layout of
		 * the dock. It holds no glass.
		 */
		.progress {
			position: absolute;
			left: var(--space-3);
			right: var(--space-3);
			bottom: 0;
			height: 2px;
			border-radius: var(--r-pill);
			background: var(--accent);
			transform-origin: left;
			transition: scale 250ms linear;
		}

		/* ── Destinations ────────────────────────────────────────────── */

		/* Folding takes the row's height to nothing, as the details fold in the
		   player does: a one-row grid whose track goes from 1fr to 0fr. */
		.fold {
			display: grid;
			grid-template-rows: 1fr;
			transition: grid-template-rows var(--dur-state) var(--ease-out);
		}

		.folded .fold {
			grid-template-rows: 0fr;
		}

		.tabs {
			position: relative;
			min-height: 0;
			overflow: hidden;
			display: grid;
			grid-template-columns: repeat(4, minmax(0, 1fr));
			padding: 0 var(--space-1);
		}

		.playing .tabs {
			border-top: 1px solid var(--border-hairline);
		}

		.folded .tabs {
			border-top-color: transparent;
		}

		.tab {
			position: relative;
			display: grid;
			justify-items: center;
			align-content: center;
			gap: 2px;
			height: var(--dock-tabs);
			color: var(--text-muted-through);
			font-size: 0.6875rem;
			font-weight: 600;
			letter-spacing: 0.01em;
			-webkit-tap-highlight-color: transparent;
			transition: color var(--transition);
		}

		.tab.active {
			color: var(--glow-color);
		}

		.tab.active :global(svg) {
			filter: var(--glow-icon);
		}

		.tab:active :global(svg) {
			scale: 0.9;
		}

		.tab :global(svg) {
			transition: scale var(--dur-press) var(--ease-out);
		}

		.label {
			text-shadow: var(--text-shade);
		}

		/*
		 * A pill of the room's colour behind the active tab, which slides to the
		 * next one on the spring. Four equal columns, so its place is the index
		 * and needs no measuring. It holds no glass, so moving it leaves the
		 * dock's blur alone.
		 */
		.lens {
			position: absolute;
			top: 0.3rem;
			bottom: 0.3rem;
			left: var(--space-1);
			width: calc((100% - var(--space-2)) / 4);
			border-radius: var(--r-lg);
			background: color-mix(in srgb, var(--accent) 16%, transparent);
			box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 22%, transparent);
			translate: calc(var(--active) * 100%) 0;
			transition:
				translate var(--dur-travel) var(--ease-spring),
				opacity var(--dur-hover) var(--ease-out);
			pointer-events: none;
		}

		.lens.gone {
			opacity: 0;
		}
	}

	@media (max-width: 60rem) and (prefers-reduced-motion: reduce) {
		.fold,
		.lens,
		.now:not(.swiping) .text,
		.progress {
			transition: none;
		}
	}
</style>
