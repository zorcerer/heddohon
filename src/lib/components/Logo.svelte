<script lang="ts">
	/**
	 * The mark.
	 *
	 * Heddohon is ヘッドホン, the Japanese word for headphones, so the mark is
	 * built as a *kamon*, a family crest: drawn inside an enclosing ring (the
	 * 丸に "within a circle" convention), symmetric about the vertical, made of
	 * solid forms separated by even negative space, with no detail lost at
	 * 16px.
	 *
	 * A headband arc concentric with the ring, with two solid earcups hanging
	 * from its ends. The gap between the band and the ring was settled by
	 * rendering the alternatives at 64, 32 and 16px: closed, the interior
	 * becomes a solid mass, and wider, the ring looks unrelated to what it
	 * encloses.
	 *
	 * Drawn on a 32-unit box. The surrounding tile is the caller's to draw, so
	 * there is no background here.
	 */
	let { size = 24 }: { size?: number } = $props();
</script>

<!-- Sized in rem so the crest follows the interface scale, the same as Icon. -->
<svg
	style="width: {size / 16}rem; height: {size / 16}rem"
	viewBox="0 0 32 32"
	fill="none"
	role="presentation"
	aria-hidden="true"
>
	<circle cx="16" cy="16" r="13.6" stroke="currentColor" stroke-width="1.8" />
	<path
		d="M8.98 19.27A7.75 7.75 0 1 1 23.02 19.27"
		stroke="currentColor"
		stroke-width="2.75"
		stroke-linecap="round"
	/>
	<rect x="6.62" y="17.9" width="4.72" height="8.3" rx="2.36" fill="currentColor" />
	<rect x="20.66" y="17.9" width="4.72" height="8.3" rx="2.36" fill="currentColor" />
</svg>
