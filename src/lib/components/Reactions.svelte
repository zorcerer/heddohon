<script lang="ts">
	/**
	 * Reactions from a listen-together session, floating up and fading, at the
	 * foot of the screen. Decoration for those watching; the reaction itself is
	 * announced once, politely, for a screen reader.
	 */
	import type { FloatingReaction } from '$lib/client/together.svelte';

	let { reactions }: { reactions: FloatingReaction[] } = $props();

	// Spread across a band, the same place for the same reaction number.
	const offset = (key: number) => ((key * 37) % 60) - 30;
</script>

<div class="reactions" aria-hidden="true">
	{#each reactions as reaction (reaction.key)}
		<span class="reaction" style="--x: {offset(reaction.key)}px">{reaction.emoji}</span>
	{/each}
</div>
<p class="hh-visually-hidden" role="status">{reactions.at(-1)?.emoji ?? ''}</p>

<style>
	.reactions {
		position: fixed;
		right: calc(var(--edge-right, 1rem) + 4rem);
		bottom: calc(var(--edge-bottom, 1rem) + 6rem);
		width: 0;
		height: 0;
		z-index: 60;
		pointer-events: none;
	}

	.reaction {
		position: absolute;
		left: var(--x);
		bottom: 0;
		font-size: 2rem;
		animation: rise 2400ms var(--ease-out) forwards;
	}

	@keyframes rise {
		0% {
			opacity: 0;
			translate: 0 0;
			scale: 0.6;
		}
		15% {
			opacity: 1;
			scale: 1.1;
		}
		100% {
			opacity: 0;
			translate: 0 -12rem;
			scale: 1;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.reaction {
			animation: fade 2400ms linear forwards;
		}

		@keyframes fade {
			0%,
			80% {
				opacity: 1;
			}
			100% {
				opacity: 0;
			}
		}
	}
</style>
