<script lang="ts">
	/**
	 * A cover, treated as a pane that floats above the page like everything else.
	 *
	 * This used to carry a vinyl record protruding from behind it. That detail
	 * belonged to the printed-catalogue look; against translucent glass it read as
	 * a hard, opaque smudge, so it is gone. What remains is the part the rest of
	 * the app depends on: this is the element that claims the shared
	 * view-transition name and morphs between a grid card and an album hero.
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
		 * Album id. When this cover is the one carrying a navigation it claims the
		 * shared view-transition names, so the browser morphs it into its
		 * counterpart on the next page — and back again.
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
		<Cover {coverArt} {alt} {size} {radius} />
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
		 * No `overflow: hidden`. The cover inside is rounded to the same radius
		 * and so is its image, so this was a second rounded clip doing the first
		 * one's job, on the element that the hover lift and the launch scale
		 * both promote to a layer of its own. The radius stays: it shapes the
		 * inset highlight and the drop shadow.
		 */
		transition: transform var(--transition);
	}

	/* The click gesture: the cover lifts toward the viewer and holds there while
	   the navigation runs, so the snapshot the view transition takes is already
	   moving in the right direction. */
	.launching .art {
		transform: scale(1.04);
		transition: transform 190ms cubic-bezier(0.32, 0.9, 0.3, 1);
	}
</style>
