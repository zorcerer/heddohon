<script lang="ts">
	import { page } from '$app/state';
	import { player } from '$lib/client/player.svelte';
	import Icon from './Icon.svelte';
	import Logo from './Logo.svelte';

	let { appName }: { appName: string } = $props();

	const LINKS = [
		{ href: '/', label: 'Home', icon: 'home' as const, exact: true },
		{ href: '/albums', label: 'Albums', icon: 'album' as const, exact: false },
		{ href: '/artists', label: 'Artists', icon: 'artist' as const, exact: false },
		{ href: '/playlists', label: 'Playlists', icon: 'playlist' as const, exact: false },
		{ href: '/favourites', label: 'Favourites', icon: 'heart' as const, exact: false },
		{ href: '/search', label: 'Search', icon: 'search' as const, exact: false }
	];

	function isActive(href: string, exact: boolean): boolean {
		const path = page.url.pathname;
		return exact ? path === href : path === href || path.startsWith(`${href}/`);
	}
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
<nav class="rail hh-glass hh-tint-morph hh-float" aria-label="Primary">
	<a class="brand" href="/" title={appName}>
		<span class="mark" aria-hidden="true"><Logo size={19} /></span>
		<span class="wordmark hh-visually-hidden">{appName}</span>
	</a>

	<ul class="links">
		{#each LINKS as link (link.href)}
			{@const active = isActive(link.href, link.exact)}
			<li>
				<a
					class="link"
					class:active
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
		{#if !player.panelOpen}
			<button
				class="link reopen"
				type="button"
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
		z-index: 1;
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

		.link.active::before {
			left: 50%;
			top: auto;
			bottom: 2px;
			width: 1.1rem;
			height: 3px;
			margin: 0 0 0 -0.55rem;
		}
	}
</style>
