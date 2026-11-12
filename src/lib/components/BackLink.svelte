<script lang="ts">
	import { afterNavigate, goto } from '$app/navigation';
	import { page } from '$app/state';
	import { ownBack } from '#lib/client/own-back.svelte.ts';
	import Icon from './Icon.svelte';

	/*
	 * The way back from an album, an artist, a playlist, a genre or a folder,
	 * on a phone. The app installed on an iPhone has no back button of its
	 * own, and the path strip is not shown at that width, so an album opened
	 * from the home page was a page with no way out but the dock.
	 *
	 * Back is the history's while the entry behind this one is of this page
	 * load, so it returns to the place in the list it was opened from and the
	 * music plays on. Otherwise (the page opened from a link elsewhere, or
	 * reloaded) it goes up to the section's own page, without a reload.
	 */
	const SECTIONS = new Set(['albums', 'artists', 'playlists', 'genres', 'folders']);

	const section = $derived.by(() => {
		const [first, second] = page.url.pathname.split('/').filter(Boolean);
		return first && second && SECTIONS.has(first) && second !== 'import' ? first : null;
	});

	// Entries of this app behind the current one: up on a push, by the step on Back and Forward.
	let behind = 0;
	afterNavigate((navigation) => {
		if (navigation.type === 'enter') behind = 0;
		else if (navigation.type === 'popstate') behind = Math.max(0, behind + navigation.delta);
		else behind += 1;
	});

	/*
	 * Whether the entry behind this one belongs to this page load, so going
	 * back to it keeps the player playing. An entry of this site from an
	 * earlier load (a reload, a link opened from elsewhere) loads the page
	 * again, which stops the music: there the link goes up instead. The
	 * Navigation API says so exactly, by `sameDocument`, where the browser
	 * has it; elsewhere the count above, which a replaced entry makes one too
	 * many.
	 */
	function appBehind(): boolean {
		const nav = (window as { navigation?: { currentEntry: { index: number } | null; entries(): { sameDocument: boolean }[] } }).navigation;
		if (nav?.currentEntry) return nav.entries()[nav.currentEntry.index - 1]?.sameDocument === true;
		return behind > 0;
	}

	function back(event: MouseEvent) {
		if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
		event.preventDefault();
		// In the iPhone home-screen app the pages behind are the app's own list.
		if (ownBack.active) {
			if (!ownBack.back()) void goto(`/${section}`);
			return;
		}
		if (appBehind()) history.back();
		else void goto(`/${section}`);
	}
</script>

{#if section}
	<a class="back" href="/{section}" onclick={back}>
		<Icon name="chevron-left" size={18} />
		<span>Back</span>
	</a>
{/if}

<style>
	.back {
		display: none;
	}

	/* The phone layout, where the rail and the path strip are not shown. */
	@media (max-width: 60rem) {
		/* Over the page: the album page's hero reaches up over it with a
		   negative margin, and took the tap. */
		.back {
			position: relative;
			z-index: 2;
			display: inline-flex;
			align-items: center;
			gap: 0.15rem;
			justify-self: start;
			margin: 0 0 var(--space-2) -0.35rem;
			padding: 0.35rem 0.6rem 0.35rem 0.25rem;
			border-radius: var(--r-md);
			color: var(--text-muted);
			font-size: 0.875rem;
			-webkit-tap-highlight-color: transparent;
		}

		.back:active {
			background: var(--bg-hover);
		}
	}
</style>
