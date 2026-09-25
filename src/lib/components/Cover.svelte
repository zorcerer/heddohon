<script lang="ts" module>
	/*
	 * Copies of each cover that have loaded in this browser, the largest per
	 * cover. A cover asked for at a size nobody has loaded yet shows one of
	 * these underneath while it arrives.
	 *
	 * The album hero asks for 640px and the card that opened it holds 384px, so
	 * opening an album waited for a second copy of a cover already on screen:
	 * measured against a music server taking 800ms per cover, 1167ms from the
	 * click to the hero. A real Navidrome resizing a large cover takes longer.
	 * The smaller copy is in the browser's memory, so it shows at once, and the
	 * sharp one crossfades over it when it lands.
	 *
	 * Filled only from load events, which run only in the browser, so the
	 * server never holds one.
	 */
	const loadedCopies = new Map<string, { size: number; src: string }>();

	function rememberCopy(coverArt: string, size: number, src: string) {
		const held = loadedCopies.get(coverArt);
		if (held && held.size >= size) return;
		loadedCopies.set(coverArt, { size, src });
		// Oldest first when it grows past a long session's worth of covers.
		if (loadedCopies.size > 2000) loadedCopies.delete(loadedCopies.keys().next().value!);
	}
</script>

<script lang="ts">
	import { untrack } from 'svelte';
	import { coverUrl } from '$lib/client/format';
	import Icon from './Icon.svelte';

	let {
		coverArt,
		alt = '',
		size = 256,
		radius = 'var(--r-md)',
		rounded = false,
		fill = false,
		hidpi = false,
		layered = false
	}: {
		coverArt: string | null | undefined;
		alt?: string;
		size?: number;
		radius?: string;
		rounded?: boolean;
		/**
		 * Fill the container instead of holding a square. The image already
		 * crops rather than stretches, so this is what turns a cover into a
		 * full-bleed, slightly zoomed backdrop. The container decides the shape.
		 */
		fill?: boolean;
		/**
		 * Offer a second copy at twice the density. `size` stays the size a 1x
		 * display gets, so this costs nothing there.
		 *
		 * Worth it where the drawn cover is large: the panel's artwork was asking
		 * for one 512px copy and stretching it across 1700 device pixels. It is
		 * not on by default, since a grid of forty cards would double both the
		 * bytes on the wire and the files in the server's cover cache to sharpen
		 * something already close to its drawn size.
		 */
		hidpi?: boolean;
		/** Keep the images on compositor layers of their own; see `.layered` below. On with `hidpi`. */
		layered?: boolean;
	} = $props();

	let failed = $state(false);
	const src = $derived(coverUrl(coverArt, size));
	/*
	 * Density descriptors rather than widths: the browser then picks by the
	 * screen alone. Widths would need a `sizes` hint in CSS pixels, and these
	 * covers are cropped to fill a box whose height is what usually decides how
	 * much detail is needed, which `sizes` has no way to express.
	 */
	const srcset = $derived(hidpi && coverArt ? `${src} 1x, ${coverUrl(coverArt, size * 2)} 2x` : undefined);

	/*
	 * Listens for a failed load, and catches one that happened before hydration.
	 *
	 * Not `onerror`. For an `onerror` on an element that can fail before the
	 * script arrives, Svelte writes an inline `onerror="this.__e=event"` into
	 * the server-rendered markup so it can replay the event later, and the
	 * Content-Security-Policy refuses inline handlers. The attribute was blocked
	 * on every page, and a cover that failed before hydration kept its broken
	 * image instead of the placeholder. A broken image reports `complete` with
	 * no natural width, which is what is checked here.
	 */
	/*
	 * Arriving, and changing.
	 *
	 * A cover used to appear the moment its bytes did, top to bottom, and a
	 * change of cover (the next track in the player, another record opened from
	 * an album page, which reuses this component) was a hard cut to an empty
	 * square and then to the new image. Now the image is held back until it has
	 * loaded, then comes in from a blur, and a new cover crossfades over the one
	 * it replaces, which stays underneath until the new one is showing.
	 *
	 * `pending` is only ever set from the browser. The server renders the image
	 * visible, so a page is whole before its script runs, and an image that has
	 * already loaded by then is left alone rather than faded in again.
	 */
	let pending = $state(false);
	let previous = $state<{ src: string; srcset: string | undefined } | null>(null);
	let shown: { src: string; srcset: string | undefined } | null = null;
	let settle: ReturnType<typeof setTimeout> | undefined;

	/** A copy of this cover already loaded at another size, to show while this one arrives. */
	function standIn(): { src: string; srcset: undefined } | null {
		const held = coverArt ? loadedCopies.get(coverArt) : undefined;
		return held && held.src !== src ? { src: held.src, srcset: undefined } : null;
	}

	function reveal(image: HTMLImageElement) {
		if (image.naturalWidth === 0) return;
		pending = false;
		shown = { src, srcset };
		if (coverArt) rememberCopy(coverArt, size, src);
		// The fade is 420ms; the old cover goes once it is covered, and a
		// transitionend that never fires (reduced motion, a hidden tab) cannot
		// leave it there.
		clearTimeout(settle);
		settle = setTimeout(() => (previous = null), 480);
	}

	/*
	 * Listens for the load and for a failure, and catches both when they
	 * happened before hydration.
	 *
	 * Not `onload` or `onerror`. For those on an element that can fire before
	 * the script arrives, Svelte writes an inline `onload="this.__e=event"` into
	 * the server-rendered markup so it can replay the event later, and the
	 * Content-Security-Policy refuses inline handlers: a cover that failed
	 * before hydration kept its broken image instead of the placeholder. A
	 * broken image reports `complete` with no natural width.
	 */
	function watch(image: HTMLImageElement) {
		const fail = () => (failed = true);
		const load = () => reveal(image);
		if (image.complete) {
			if (image.naturalWidth > 0) {
				shown = { src, srcset };
				if (coverArt) rememberCopy(coverArt, size, src);
			} else if (image.currentSrc) fail();
		} else {
			pending = true;
			previous = standIn();
		}
		image.addEventListener('load', load);
		image.addEventListener('error', fail);
		return () => {
			image.removeEventListener('load', load);
			image.removeEventListener('error', fail);
			clearTimeout(settle);
		};
	}

	// A new cover: keep the old one underneath, and hold the new one back
	// until it has loaded.
	$effect(() => {
		const next = src;
		untrack(() => {
			failed = false;
			if (!next) {
				shown = null;
				previous = null;
			} else if (shown && shown.src !== next) {
				// The new cover at another size, when one has loaded, rather than
				// the old cover: opening a record from an album page shows it at
				// once instead of the one being left.
				previous = standIn() ?? shown;
				pending = true;
			}
		});
	});
</script>

<div
	class="cover"
	class:fill
	class:layered={layered || hidpi}
	class:rounded
	style:border-radius={rounded ? '50%' : radius}
	style:--placeholder-size="{Math.round(size / 4)}px"
>
	{#if src && !failed}
		{#if previous}
			<img class="under" src={previous.src} srcset={previous.srcset} alt="" aria-hidden="true" />
		{/if}
		<img class="current" class:pending {src} {srcset} {alt} loading="lazy" decoding="async" {@attach watch} />
	{:else}
		<div class="placeholder" aria-hidden="true">
			<Icon name="album" size={Math.max(16, Math.round(size / 5))} strokeWidth={1.2} />
		</div>
	{/if}
</div>

<style>
	.cover {
		position: relative;
		aspect-ratio: 1;
		width: 100%;
		overflow: hidden;
		background: var(--bg-sunken);
		border: 1px solid var(--border-hairline);
		flex: none;
	}

	/*
	 * The image carries the radius itself rather than relying on the clip above
	 * it.
	 *
	 * `overflow: hidden` plus a radius is a clip, and a clip is applied by the
	 * compositor. Every time a layer is built or thrown away around one of these
	 * (a card lifting on hover, a sleeve taking a `view-transition-name`, a
	 * panel with a `backdrop-filter` being recomposited on navigation) there is
	 * a frame where the layer exists and the rounding has not been applied to
	 * it, and a square corner of opaque image shows in a round one. Rounding the
	 * painted content makes the clip redundant rather than load-bearing: it
	 * stays as a backstop, and a frame without it now looks the same.
	 */
	img {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		object-fit: cover;
		border-radius: inherit;
	}

	/*
	 * In from a blur. Opacity leads so the cover is recognisable early, and the
	 * blur clears over a little longer. Blur on an image, which carries no
	 * glass, so none of the backdrop-root trouble applies.
	 */
	.current {
		transition:
			opacity var(--dur-state) var(--ease-out),
			filter var(--dur-travel) var(--ease-out);
	}

	/*
	 * The large covers (the album hero, and the player, which asks for a hidpi
	 * copy) keep their images on compositor layers of their own throughout.
	 * Otherwise WebKit builds the layer when the fade starts, and for two
	 * frames drew neither the stand-in underneath nor the arriving image:
	 * recorded in Playwright's WebKit as the player's artwork going from 80
	 * to 40 and back in brightness as a restored queue's cover arrived. The
	 * card grids hold dozens of covers and do not take a layer each.
	 */
	.layered img {
		will-change: opacity, filter;
	}

	/* Hidden at once: the element already holds the new source, so there is
	   nothing on it worth fading out. The old cover is underneath. */
	.current.pending {
		opacity: 0;
		filter: blur(14px);
		transition: none;
	}

	/* No square to hold, and no hairline either: an edge in the middle of a
	   full-bleed image is a seam, not a frame. */
	.cover.fill {
		aspect-ratio: auto;
		height: 100%;
		border: none;
	}

	.placeholder {
		width: 100%;
		height: 100%;
		display: grid;
		place-items: center;
		color: var(--text-faint);
	}
</style>
