<script lang="ts">
	import { navigating, page } from '$app/state';
	import { player } from '$lib/client/player.svelte';
	import { DUR, EASE_OUT_CSS, easeOut, motion } from '$lib/client/motion';
	import { untrack } from 'svelte';
	import { slide } from 'svelte/transition';
	import Icon from './Icon.svelte';
	import Logo from './Logo.svelte';

	let { appName }: { appName: string } = $props();

	const LINKS = [
		{ href: '/', label: 'Home', icon: 'home' as const, exact: true },
		{ href: '/albums', label: 'Albums', icon: 'album' as const, exact: false },
		{ href: '/artists', label: 'Artists', icon: 'artist' as const, exact: false },
		// Not in the phone's row, which is full; the Albums page links to it there.
		{ href: '/genres', label: 'Genres', icon: 'genre' as const, exact: false, wideOnly: true },
		{ href: '/playlists', label: 'Playlists', icon: 'playlist' as const, exact: false },
		{ href: '/favourites', label: 'Favourites', icon: 'heart' as const, exact: false },
		{ href: '/search', label: 'Search', icon: 'search' as const, exact: false }
	];

	/*
	 * Where the rail points: the page being opened while it loads, then that
	 * page. Following the address alone, the marker waited for the next page's
	 * data before it moved, and on a slow one it sat for 46 frames and then
	 * jumped. An abandoned navigation clears `navigating`, and it goes back.
	 */
	const path = $derived(navigating.to?.url.pathname ?? page.url.pathname);

	function isActive(href: string, exact: boolean): boolean {
		return exact ? path === href : path === href || path.startsWith(`${href}/`);
	}

	/*
	 * The active marker slides from one destination to the next on the spring,
	 * instead of disappearing from one and appearing at the other.
	 *
	 * The server cannot measure, so the first paint keeps the marker each link
	 * draws for itself, and this one takes over once it has a position
	 * (`measured`), placed without travel the first time. It moves by
	 * `translate` inside the rail's glass, holding none of its own, so the
	 * rail's blur is untouched. Settings is below the list, so on that page the
	 * marker fades out here and Settings draws its own.
	 */
	let list = $state<HTMLUListElement | null>(null);
	let anchors = $state<Array<HTMLAnchorElement | null>>([]);
	let marker = $state<{ x: number; y: number } | null>(null);
	let markerEl = $state<HTMLLIElement | null>(null);
	let placedIndex = -1;
	let measured = $state(false);
	let settled = $state(false);
	const activeIndex = $derived(LINKS.findIndex((link) => isActive(link.href, link.exact)));

	function place() {
		const anchor = activeIndex >= 0 ? anchors[activeIndex] : null;
		// A destination hidden at this width (Genres on a phone) has no box.
		if (!anchor || anchor.offsetWidth === 0) {
			marker = null;
			return;
		}
		// Untracked: `place` runs in an effect, and reading what it is about to
		// write made the effect depend on itself.
		const from = untrack(() => marker);
		marker = {
			x: anchor.offsetLeft + anchor.offsetWidth / 2,
			y: anchor.offsetTop + anchor.offsetHeight / 2
		};
		// A new destination, not the same one measured again after a resize.
		if (untrack(() => settled) && from && placedIndex !== activeIndex) stretch(from, marker);
		placedIndex = activeIndex;
		if (!measured) {
			measured = true;
			// Travel only from the second position on.
			requestAnimationFrame(() => requestAnimationFrame(() => (settled = true)));
		}
	}

	/*
	 * The bar draws out along its path as it travels, to about twice its
	 * length a third of the way, and gathers back as it lands, so the move reads
	 * as a slide rather than a hop. Scale on the bar itself, apart from the
	 * `translate` that carries it, so the two do not interrupt each other.
	 */
	function stretch(from: { x: number; y: number }, to: { x: number; y: number }) {
		const duration = motion(DUR.travel);
		if (!markerEl || duration === 0) return;
		const along = Math.abs(to.x - from.x) > Math.abs(to.y - from.y) ? '2.2 1' : '1 2.2';
		markerEl.animate([{ scale: '1 1' }, { scale: along, offset: 0.35 }, { scale: '1 1' }], {
			duration,
			easing: EASE_OUT_CSS
		});
	}

	$effect(() => {
		void activeIndex;
		place();
	});

	$effect(() => {
		if (!list) return;
		const observer = new ResizeObserver(() => place());
		observer.observe(list);
		return () => observer.disconnect();
	});
</script>

<!--
	Icons only. The glyphs carry six destinations on their own, and a column of
	labels beside them was 11rem of rail that the content and the player could
	use instead.

	The labels stay in the markup, clipped rather than `display: none`. A
	removed label takes the accessible name with it, which would leave the whole
	of the primary navigation as unnamed links; `title` then gives a pointer the
	same word on hover.
-->
<nav class="rail hh-glass hh-tint-morph hh-float" class:measured aria-label="Primary">
	<a class="brand" href="/" title={appName}>
		<span class="mark" aria-hidden="true"><Logo size={19} /></span>
		<span class="wordmark hh-visually-hidden">{appName}</span>
	</a>

	<ul class="links" bind:this={list}>
		<li
			bind:this={markerEl}
			class="marker"
			class:settled
			class:gone={marker === null}
			aria-hidden="true"
			style:--marker-x="{marker?.x ?? 0}px"
			style:--marker-y="{marker?.y ?? 0}px"
		></li>
		{#each LINKS as link, index (link.href)}
			{@const active = isActive(link.href, link.exact)}
			<li class:wide-only={'wideOnly' in link}>
				<a
					class="link"
					class:active
					bind:this={anchors[index]}
					href={link.href}
					title={link.label}
					aria-current={active ? 'page' : undefined}
				>
					<Icon name={link.icon} size={19} />
					<span class="hh-visually-hidden">{link.label}</span>
				</a>
			</li>
		{/each}
	</ul>

	<div class="foot">
		<!--
			The way back to a player you closed, on the screens where the panel is
			a sheet over the library and closing it leaves nothing behind. Wider
			than that, the panel leaves a sliver on the right-hand edge that does
			the same job in the place you closed it from, so this is hidden.
		-->
		<!-- Opens and closes across the rail rather than appearing, so the
		     icons beside it move over instead of jumping. The button is inside
		     the rail's glass and holds none of its own, so its opacity and size
		     can change without touching the rail's blur. -->
		{#if !player.panelOpen}
			<button
				class="link reopen"
				type="button"
				transition:slide={{ axis: 'x', duration: motion(DUR.state), easing: easeOut }}
				title="Now playing"
				onclick={() => player.togglePanel()}
			>
				<Icon name="waveform" size={19} />
				<span class="hh-visually-hidden">Now playing</span>
			</button>
		{/if}

		<a
			class="link"
			class:active={isActive('/settings', false)}
			href="/settings"
			title="Settings"
		>
			<Icon name="settings" size={19} />
			<span class="hh-visually-hidden">Settings</span>
		</a>

		<!--
			Styled as one of the rail's links rather than as a control of its own:
			it belongs to the same column, and it inherits the collapse-to-icon
			behaviour the links already have at narrow widths for free.
		-->
		<form method="POST" action="/logout">
			<button class="link signout" type="submit" title="Sign out">
				<Icon name="logout" size={19} />
				<span class="hh-visually-hidden">Sign out</span>
			</button>
		</form>
	</div>
</nav>

<style>
	.rail {
		grid-area: rail;
		position: relative;
		/* Over the page veil in the layout, which sits at 1. */
		z-index: 2;
		width: var(--rail-width);
		display: flex;
		flex-direction: column;
		gap: var(--space-5);
		padding: var(--space-5) var(--space-2) var(--space-4);
		overflow-y: auto;
	}

	.brand {
		display: grid;
		place-items: center;
		padding: 0 0 var(--space-4);
		/* The rail reads as three things — identity, where you can go, your
		   account — and the rule is what says the first one has ended. */
		border-bottom: 1px solid var(--border-hairline);
	}

	/*
	 * Glass with the crest in the accent, not a filled accent tile. A solid
	 * block of colour is the one thing in the chrome that was not made of the
	 * same material as everything else, and it is the first thing your eye hits
	 * on every page.
	 */
	.mark {
		display: grid;
		place-items: center;
		width: 1.875rem;
		height: 1.875rem;
		background: var(--control-face);
		-webkit-backdrop-filter: var(--control-blur);
		backdrop-filter: var(--control-blur);
		border: 1px solid var(--border-strong);
		color: var(--accent);
		border-radius: var(--r-sm);
	}

	/*
	 * Set as a label, not a headline.
	 *
	 * It was the display face at 1.45rem and weight 800 — the same treatment an
	 * album title gets, in the corner of every page, competing with the actual
	 * headline three inches to its right. Mono, small and widely tracked reads
	 * as a marking on a piece of equipment instead, which is what a name in a
	 * corner is for, and it stops fighting the content.
	 */
	.wordmark {
		font-family: var(--font-mono);
		font-size: 0.8125rem;
		font-weight: 500;
		letter-spacing: 0.2em;
		text-transform: uppercase;
		color: var(--text-default);
	}

	.links {
		position: relative;
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 2px;
		flex: 1;
		align-content: start;
	}

	/*
	 * A square target rather than a row. The glyph is centred in it, which is
	 * what stops a column of icons reading as a column of left-aligned text
	 * that lost its words.
	 */
	.link {
		display: grid;
		place-items: center;
		aspect-ratio: 1;
		padding: 0;
		border-radius: var(--r-sm);
		color: var(--text-muted);
		font-size: 0.875rem;
		font-weight: 500;
		transition:
			text-shadow var(--transition),
			color var(--transition);
	}

	.link:hover {
		color: var(--glow-color);
		text-shadow: var(--glow-text);
	}

	/* The glyph cannot take a text-shadow, so it gets the same halo as a filter.
	   Applied to the svg rather than the link, which would drop-shadow the
	   label as well and double it up with the text-shadow above. */
	.link:hover :global(svg),
	.link.active :global(svg) {
		filter: var(--glow-icon);
	}

	.link.active {
		color: var(--glow-color);
		text-shadow: var(--glow-text);
	}

	/* Touch-down feedback. See the note on `.hh-button:active` in app.css. */
	.link:active {
		color: var(--glow-color);
		background: var(--bg-hover);
	}

	/* A short accent bar on the active item rather than a filled pill: less
	   visual weight in a list that is always on screen. */
	.link.active {
		position: relative;
	}

	/* Hard against the rail's own left edge, so the marker reads as being in the
	   margin rather than as part of the icon. */
	.link.active::before {
		content: '';
		position: absolute;
		left: calc(var(--space-2) * -1);
		top: 50%;
		width: 3px;
		height: 1.1rem;
		margin-top: -0.55rem;
		border-radius: var(--r-pill);
		background: var(--accent);
	}

	/*
	 * The sliding marker. Same bar as the per-link one below, placed from the
	 * active link's centre (`--marker-x`, `--marker-y`). It travels on the
	 * spring and fades where there is nothing in the list to mark.
	 */
	.marker {
		position: absolute;
		left: calc(var(--space-2) * -1);
		top: 0;
		width: 3px;
		height: 1.1rem;
		border-radius: var(--r-pill);
		background: var(--accent);
		translate: 0 calc(var(--marker-y) - 0.55rem);
		pointer-events: none;
		opacity: 0;
	}

	.measured .marker:not(.gone) {
		opacity: 1;
	}

	.marker.settled {
		transition:
			translate var(--dur-travel) var(--ease-spring),
			opacity var(--dur-hover) var(--ease-out);
	}

	/* Once the sliding marker has a position, it is the one drawn. */
	.measured .links .link.active::before {
		display: none;
	}

	.foot {
		display: grid;
		gap: var(--space-3);
		padding-top: var(--space-3);
		border-top: 1px solid var(--border-hairline);
	}

	.signout {
		width: 100%;
	}

	.reopen {
		display: none;
	}

	.signout:hover {
		color: var(--danger);
	}

	@media (max-width: 60rem) {
		.rail {
			width: 100%;
			/* Pinned rather than intrinsic: --rail-height is what everything
			   floating over the page subtracts to stay clear of the nav, and a
			   token that only approximates its element is worse than none. */
			height: var(--rail-height);
			padding-bottom: var(--space-2);
			flex-direction: row;
			align-items: center;
			gap: var(--space-2);
			padding: var(--space-2) var(--space-3);
			/*
			 * The bar itself must not scroll. When it did, the destinations took
			 * all the width they wanted and pushed Settings off the right-hand
			 * edge — reachable only by discovering that a nav bar scrolls
			 * sideways, which nobody does. The destinations scroll inside their
			 * own row instead, and everything after them stays put.
			 */
			overflow: hidden;
			/*
			 * The document scrolls under the rail on a narrow screen (see the
			 * layout), and this keeps it on screen. A sticky box stays inside its
			 * containing block, and CSS Grid defines a grid item's containing
			 * block as its grid area, which in the first row alone is the rail's
			 * own height. Chromium 141 measures against the whole grid instead: with
			 * the rail confined to the first row it still sat at 12px after
			 * 1500px of scrolling. Spanning both rows makes it stick under either
			 * reading, and the height above keeps it to the first row on screen.
			 */
			position: sticky;
			top: var(--edge-top);
			grid-row: 1 / -1;
		}

		/*
		 * The brand goes: it is identity, not a destination, and the row has
		 * exactly enough width for the things you can actually press. Home is one
		 * tap away in the row itself, which is all the brand was doing here.
		 *
		 * The labels are already clipped by `.hh-visually-hidden` in the markup,
		 * so there is nothing left to hide. This block used to carry a
		 * `.link span { display: none }` that took the accessible name with it
		 * and left the whole bar as a row of unnamed links.
		 */
		.brand {
			display: none;
			padding: 0;
			border-bottom: none;
		}

		/*
		 * Eight targets have to fit 342px of content box. At the stacked rail's
		 * horizontal padding they need 376 and the row starts clipping Search,
		 * so the padding comes in — the glyph keeps its size, only the air around
		 * it shrinks. Vertical padding goes the other way: a 19px glyph with
		 * 12.5px above and below is a 44px target, which is what --rail-height is
		 * sized from.
		 */
		.link {
			/*
			 * Horizontal padding is set from what is left rather than picked: the
			 * row has 342px for eight controls, so each can be 42px wide at most.
			 * The gap between them goes to zero and that space moves *inside* the
			 * targets, which leaves the glyphs spaced exactly as they were and
			 * makes each one 41x44 instead of 35x44. 44 square does not fit eight
			 * items on a 390px screen — 8x44 plus any separation is already over
			 * the row — so this is the largest target the set can have.
			 *
			 * The square aspect the stacked rail gives its targets is dropped
			 * here: in a row it is the height that is fixed and the width that
			 * has to give.
			 */
			aspect-ratio: auto;
			padding: 0.78rem 0.7rem;
		}

		.links {
			display: flex;
			flex: 1;
			min-width: 0;
			gap: 0;
			overflow-x: auto;
		}

		/*
		 * The stacked rail separates the foot from the destinations with a rule
		 * and a gap above it. Folded into a row, that inherited padding pushed
		 * Settings and Sign out 13px below the line the other icons sit on, and
		 * drew a stray hairline across the bar. Neither belongs here: the
		 * separation in a row is the space between the two groups.
		 */
		.foot {
			display: flex;
			align-items: center;
			flex: none;
			gap: 0;
			padding-top: 0;
			border-top: none;
		}

		/* One icon among the others here, so it must not stretch to fill the row. */
		.signout {
			width: auto;
		}

		.reopen {
			display: grid;
		}

		.wide-only {
			display: none;
		}

		.link.active::before {
			left: 50%;
			top: auto;
			bottom: 2px;
			width: 1.1rem;
			height: 3px;
			margin: 0 0 0 -0.55rem;
		}

		/* Under the icon in the row, travelling sideways. */
		.marker {
			left: 0;
			top: auto;
			bottom: 2px;
			width: 1.1rem;
			height: 3px;
			translate: calc(var(--marker-x) - 0.55rem) 0;
		}
	}
</style>
