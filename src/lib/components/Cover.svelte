<script lang="ts">
	import { coverUrl } from '$lib/client/format';
	import Icon from './Icon.svelte';

	let {
		coverArt,
		alt = '',
		size = 256,
		radius = 'var(--r-md)',
		rounded = false,
		fill = false,
		hidpi = false
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

	// A new id means a new image; give it a fresh chance to load.
	$effect(() => {
		void coverArt;
		failed = false;
	});
</script>

<div
	class="cover"
	class:fill
	class:rounded
	style:border-radius={rounded ? '50%' : radius}
	style:--placeholder-size="{Math.round(size / 4)}px"
>
	{#if src && !failed}
		<img {src} {srcset} {alt} loading="lazy" decoding="async" onerror={() => (failed = true)} />
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
		width: 100%;
		height: 100%;
		object-fit: cover;
		border-radius: inherit;
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
