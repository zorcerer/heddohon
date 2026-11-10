<script lang="ts">
	import { navigating, page } from '$app/state';
	import { untrack } from 'svelte';
	import Icon from './Icon.svelte';
	import Logo from './Logo.svelte';
	import Tip from './Tip.svelte';

	let { appName }: { appName: string } = $props();

	const LINKS = $derived([
		{ href: '/', label: 'Home', icon: 'home' as const, exact: true },
		{ href: '/albums', label: 'Albums', icon: 'album' as const, exact: false },
		{ href: '/artists', label: 'Artists', icon: 'artist' as const, exact: false },
		{ href: '/genres', label: 'Genres', icon: 'genre' as const, exact: false },
		{ href: '/playlists', label: 'Playlists', icon: 'playlist' as const, exact: false },
		// Unless the deployment has switched the folder view off (`HEDDOHON_FOLDERS`).
		...(page.data.folders === false ? [] : [{ href: '/folders', label: 'Folders', icon: 'folder' as const, exact: false }]),
		// Where the music server keeps stations; see `radio.ts`.
		...(page.data.radio ? [{ href: '/radio', label: 'Radio', icon: 'radio' as const, exact: false }] : []),
		{ href: '/history', label: 'History', icon: 'history' as const, exact: false, also: '/stats' },
		{ href: '/favourites', label: 'Favourites', icon: 'heart' as const, exact: false },
		...(page.data.profiles ? [{ href: '/people', label: 'People', icon: 'people' as const, exact: false }] : []),
		{ href: '/search', label: 'Search', icon: 'search' as const, exact: false }
	]);

	/*
	 * Where the rail points: the page being opened while it loads, then that
	 * page. Following the address alone, the marker waited for the next page's
	 * data, and on a slow one sat for 46 frames and then jumped. An abandoned
	 * navigation clears `navigating`, and it goes back.
	 */
	const path = $derived(navigating.to?.url.pathname ?? page.url.pathname);

	// `also` is a second page the entry stands for, and the pages under it:
	// History is Recently played, Your listening and the recap, which are tabs
	// of one another.
	function isActive(href: string, exact: boolean, also?: string): boolean {
		if (also && (path === also || path.startsWith(`${also}/`))) return true;
		return exact ? path === href : path === href || path.startsWith(`${href}/`);
	}

	/*
	 * The active marker slides from one destination to the next.
	 *
	 * The server cannot measure, so the first paint keeps the marker each link
	 * draws for itself, and this one takes over once it has a position
	 * (`measured`), placed without travel the first time. It moves by
	 * `translate` inside the rail's glass and holds none, so the rail's blur is
	 * untouched. Settings is below the list, so on that page the marker fades
	 * out here and Settings draws its own.
	 */
	let list = $state<HTMLUListElement | null>(null);
	let anchors = $state<Array<HTMLAnchorElement | null>>([]);
	let marker = $state<{ y: number } | null>(null);
	let measured = $state(false);
	let settled = $state(false);
	const activeIndex = $derived(LINKS.findIndex((link) => isActive(link.href, link.exact, link.also)));

	function place() {
		const anchor = activeIndex >= 0 ? anchors[activeIndex] : null;
		// The rail is not shown on a phone (`PhoneDock` is), and a hidden link has no box.
		if (!anchor || anchor.offsetWidth === 0) {
			marker = null;
			return;
		}
		// From the list, and not `offsetTop`: each link is inside its tooltip's
		// positioned box, which would be the offset parent.
		const top = anchor.getBoundingClientRect().top - (list?.getBoundingClientRect().top ?? 0);
		marker = { y: top + anchor.offsetHeight / 2 };
		if (!measured) {
			measured = true;
			// Travel only from the second position on.
			requestAnimationFrame(() => requestAnimationFrame(() => (settled = true)));
		}
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
	Icons only. A column of labels beside them was 11rem of rail.

	The labels stay in the markup, clipped and not `display: none`: a removed
	label takes the accessible name with it, leaving the primary navigation as
	unnamed links. `title` gives a pointer the same word on hover.
-->
<nav class="rail hh-glass hh-tint-morph hh-float" class:measured aria-label="Primary">
	<Tip group>
		<a class="brand" href="/" title={appName}>
			<span class="mark" aria-hidden="true"><Logo size={19} /></span>
			<span class="wordmark hh-visually-hidden">{appName}</span>
		</a>

		<ul class="links" bind:this={list}>
			<li
				class="marker"
				class:settled
				class:gone={marker === null}
				aria-hidden="true"
				style:--marker-y="{marker?.y ?? 0}px"
			></li>
			{#each LINKS as link, index (link.href)}
				{@const active = isActive(link.href, link.exact, link.also)}
				<li>
					<Tip label={link.label} side="right">
						<a
							class="link"
							class:active
							bind:this={anchors[index]}
							href={link.href}
							aria-current={active ? 'page' : undefined}
						>
							<Icon name={link.icon} size={19} />
							<span class="hh-visually-hidden">{link.label}</span>
						</a>
					</Tip>
				</li>
			{/each}
		</ul>

		<div class="foot">
			<Tip label="Living-room screen" side="right">
				<a class="link" href="/screen">
					<Icon name="screen" size={19} />
					<span class="hh-visually-hidden">Living-room screen</span>
				</a>
			</Tip>

			<Tip label="Settings" side="right">
				<a
					class="link"
					class:active={isActive('/settings', false)}
					href="/settings"
					aria-current={isActive('/settings', false) ? 'page' : undefined}
				>
					<Icon name="settings" size={19} />
					<span class="hh-visually-hidden">Settings</span>
				</a>
			</Tip>

			<!-- Styled as one of the rail's links: it is in the same column, and gets
			     their collapse-to-icon behaviour at narrow widths. -->
			<form method="POST" action="/logout">
				<Tip label="Sign out" side="right">
					<button class="link signout" type="submit">
						<Icon name="logout" size={19} />
						<span class="hh-visually-hidden">Sign out</span>
					</button>
				</Tip>
			</form>
		</div>
	</Tip>
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
		/* The rail is three things: identity, where you can go, your account. The
		   rule ends the first. */
		border-bottom: 1px solid var(--border-hairline);
	}

	/* Glass with the crest in the accent, not a filled accent tile, so the mark
	   is made of the same material as the rest of the chrome. */
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
	 * Set as a label, not a headline. In the display face at 1.45rem and weight
	 * 800 it had an album title's treatment in the corner of every page, beside
	 * the page's own headline. Mono, small and widely tracked.
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

	/* A square target with the glyph centred in it, so a column of icons does
	   not read as left-aligned text without its words. */
	/* Each link's tooltip box fills its row, as the link did. */
	.rail :global(.hh-tip) {
		display: grid;
		width: 100%;
	}

	.link {
		position: relative;
		/* Over the marker, which is earlier in the list. */
		z-index: 1;
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

	/* The glyph cannot take a text-shadow, so it gets the same halo as a filter,
	   on the svg: on the link it would also shadow the label, over the
	   text-shadow above. */
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

	/*
	 * The destination is a step of the ground with a hairline, the shape of the
	 * crest's tile above it, and the glyph at full strength. A 3px accent bar
	 * against the rail's edge marked it until 2026-11, restyled twice in Terminal
	 * (#242, #248). The marker holds no glass, so the rail's blur is untouched.
	 *
	 * Until the marker has a position (the server-rendered page), and for
	 * Settings, which is outside the list, the link draws the step itself.
	 */
	.rail:not(.measured) .link.active,
	.foot .link.active,
	.marker {
		background: var(--bg-hover);
		box-shadow: inset 0 0 0 1px var(--border-hairline);
	}

	/* The link's own square, centred on its centre (`--marker-y`). It fades where
	   the list has nothing to mark. */
	.marker {
		position: absolute;
		left: 0;
		top: 0;
		width: 100%;
		aspect-ratio: 1;
		border-radius: var(--r-sm);
		translate: 0 calc(var(--marker-y) - 50%);
		pointer-events: none;
		opacity: 0;
	}

	.measured .marker:not(.gone) {
		opacity: 1;
	}

	.marker.settled {
		transition:
			translate var(--dur-travel) var(--ease-out),
			opacity var(--dur-hover) var(--ease-out);
	}

	.foot {
		display: grid;
		gap: 2px;
		padding-top: var(--space-3);
		border-top: 1px solid var(--border-hairline);
	}

	.signout {
		width: 100%;
	}

	.signout:hover {
		color: var(--danger);
	}

	/* On a phone the dock at the foot of the screen (`PhoneDock.svelte`) is the
	   navigation, and this rail is not shown. */
	@media (max-width: 60rem) {
		.rail {
			display: none;
		}
	}

	/* ── Terminal ────────────────────────────────────────────────────────────── */

	/*
	 * The destination stands in the square brackets the theme's buttons wear,
	 * `[shuffle]`, around a glyph at full strength. They travel as a pair with
	 * the marker. A block filled with the accent came first, then a step of
	 * the ground with a 2px accent edge.
	 */
	:global([data-theme='terminal']) .mark {
		background: none;
		border-color: transparent;
	}

	:global([data-theme='terminal']) .link:hover {
		color: var(--text-strong);
	}

	:global([data-theme='terminal']) .signout:hover {
		color: var(--danger);
	}

	:global([data-theme='terminal']) .link:active {
		background: var(--bg-hover);
	}

	:global([data-theme='terminal']) .rail:not(.measured) .link.active,
	:global([data-theme='terminal']) .foot .link.active,
	:global([data-theme='terminal']) .marker {
		background: none;
		box-shadow: none;
	}

	:global([data-theme='terminal']) .rail:not(.measured) .link.active::before,
	:global([data-theme='terminal']) .rail:not(.measured) .link.active::after,
	:global([data-theme='terminal']) .foot .link.active::before,
	:global([data-theme='terminal']) .foot .link.active::after,
	:global([data-theme='terminal']) .marker::before,
	:global([data-theme='terminal']) .marker::after {
		position: absolute;
		top: 50%;
		translate: 0 -50%;
		font-family: var(--font-mono);
		font-size: 1.125rem;
		line-height: 1;
		color: var(--accent);
	}

	:global([data-theme='terminal']) .rail:not(.measured) .link.active::before,
	:global([data-theme='terminal']) .foot .link.active::before,
	:global([data-theme='terminal']) .marker::before {
		content: '[';
		content: '[' / '';
		left: 0.25rem;
	}

	:global([data-theme='terminal']) .rail:not(.measured) .link.active::after,
	:global([data-theme='terminal']) .foot .link.active::after,
	:global([data-theme='terminal']) .marker::after {
		content: ']';
		content: ']' / '';
		right: 0.25rem;
	}

	:global([data-theme='terminal']) .marker.settled {
		transition:
			translate var(--dur-state) var(--ease-out),
			opacity var(--dur-hover) var(--ease-out);
	}
</style>
