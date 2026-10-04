<script lang="ts">
	/**
	 * A cover as a pane floating above the page, like the rest of the interface.
	 *
	 * This is the element that claims the shared view-transition name and
	 * morphs between a grid card and an album hero. The vinyl record it once
	 * carried behind it read as an opaque smudge against translucent glass.
	 */
	import Cover from './Cover.svelte';
	import { sleeveTransition } from '$lib/client/sleeve-transition.svelte';

	let {
		coverArt,
		alt = '',
		size = 384,
		/** Colour the surrounding glass from this cover. Costs one canvas read. */
		radius = 'var(--r-lg)',
		/**
		 * Album id. When this cover carries a navigation it claims the shared
		 * view-transition names, so the browser morphs it into its counterpart
		 * on the next page, and back.
		 */
		transitionId = null,
		/** Identifies this specific card when several show the same album. */
		transitionToken = null,
		/** Lifts the cover as it is clicked, just before the page changes. */
		launching = false
	}: {
		coverArt: string | null | undefined;
		alt?: string;
		size?: number;
		radius?: string;
		transitionId?: string | null;
		transitionToken?: number | null;
		launching?: boolean;
	} = $props();


	const carrying = $derived(sleeveTransition.claims(transitionId, transitionToken));

</script>

<div class="sleeve" class:launching>
	<div
		class="art"
		style:border-radius={radius}
		style:view-transition-name={carrying ? `sleeve-art-${transitionId}` : undefined}
	>
		<Cover {coverArt} {alt} {size} {radius} layered={size >= 512} />
	</div>
</div>

<style>
	.sleeve {
		position: relative;
		width: 100%;
		aspect-ratio: 1;
	}

	.art {
		position: relative;
		width: 100%;
		/* The same edge treatment as the floating panels: a light catch along the
		   top, a soft drop below. */
		box-shadow:
			inset 0 1px 0 rgb(255 255 255 / 0.1),
			var(--float-shadow);
		/*
		 * No `overflow: hidden`. The cover inside and its image are rounded to
		 * the same radius, so this would be a second rounded clip on the element
		 * that the hover lift and the launch scale promote to a layer. The
		 * radius stays: it shapes the inset highlight and the drop shadow.
		 */
		transition: transform var(--transition);
	}

	/* The click gesture: the cover lifts toward the viewer and holds while the
	   navigation runs, so the snapshot the view transition takes is already
	   moving the right way. */
	.launching .art {
		transform: scale(1.04);
		/* 190ms is `LAUNCH_MS`, the wait before the navigation starts. */
		transition: transform 190ms var(--ease-out);
	}
</style>
