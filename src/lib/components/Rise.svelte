<script lang="ts">
	import type { Snippet } from 'svelte';
	import { untrack } from 'svelte';
	import { navigating } from '$app/state';
	import AnimatedContent from './bits/AnimatedContent.svelte';

	/**
	 * A list arriving with its page: Svelte Bits' AnimatedContent, which rises
	 * it 12px into place as it fades in, when it comes into view. Only on a
	 * navigation in the app, or `always` (a dialog's list as it opens): a
	 * server-rendered page is whole in its first paint. Not with less motion.
	 */
	let { always = false, class: className = '', children }: { always?: boolean; class?: string; children: Snippet } = $props();

	const armed = untrack(
		() =>
			typeof window !== 'undefined' &&
			(always || navigating.to !== null) &&
			!window.matchMedia('(prefers-reduced-motion: reduce)').matches
	);

	// The column scrolls on a wide screen and the document on a phone.
	const scroller = (): Element | null => {
		const main = document.querySelector('main.content');
		return main && main.scrollHeight > main.clientHeight ? main : null;
	};
</script>

{#if armed}
	<AnimatedContent distance={12} duration={0.4} threshold={0} container={scroller()} class="hh-rise {className}">
		{@render children()}
	</AnimatedContent>
{:else}
	<div class="hh-rise {className}">{@render children()}</div>
{/if}
