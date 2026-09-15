<script lang="ts">
	/**
	 * The mark.
	 *
	 * Heddohon is ヘッドホン — the Japanese word for headphones — so the mark is
	 * built the way a *kamon* is: a family crest, drawn inside an enclosing ring
	 * (the 丸に "within a circle" convention), strictly symmetric about the
	 * vertical, made of solid forms separated by even negative space, and
	 * carrying no detail that dies at 16px.
	 *
	 * The subject is the thing the name says. A headband arc concentric with the
	 * ring, two solid earcups hanging from its ends. The proportions are not
	 * free: the gap between the band and the ring is what makes it read as a
	 * crest rather than as an icon in a circle, and it was settled by rendering
	 * the alternatives side by side at 64, 32 and 16px rather than on paper.
	 * Closing that gap turns the interior into a solid mass; opening it further
	 * leaves the ring looking unrelated to what it encloses.
	 *
	 * Everything is drawn on a 32-unit box. The surrounding tile is the caller's
	 * to draw, which is why there is no background here.
	 */
	let { size = 24, title }: { size?: number; title?: string } = $props();
</script>

<!-- Sized in rem so the crest follows the interface scale, the same as Icon. -->
<svg
	style="width: {size / 16}rem; height: {size / 16}rem"
	viewBox="0 0 32 32"
	fill="none"
	role={title ? 'img' : 'presentation'}
	aria-label={title}
	aria-hidden={title ? undefined : 'true'}
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
