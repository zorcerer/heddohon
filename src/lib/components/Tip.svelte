<script lang="ts">
	import type { Snippet } from 'svelte';
	import WarmTooltip from './bits/WarmTooltip.svelte';

	/**
	 * The name of a control drawn as a glyph alone, on pointing at it: Svelte
	 * Bits' WarmTooltip. The first waits, and the next ones of the same `group`
	 * follow at once, gliding over from the last. `group` alone, with no label,
	 * is the group around them.
	 */
	let {
		label,
		side = 'top',
		group = false,
		children
	}: {
		label?: string;
		side?: 'top' | 'bottom' | 'left' | 'right';
		group?: boolean;
		children: Snippet;
	} = $props();
</script>

{#if group}
	<WarmTooltip group>{@render children()}</WarmTooltip>
{:else}
	<WarmTooltip
		content={label}
		{side}
		size="sm"
		surfaceColor="var(--text-strong)"
		inkColor="var(--bg-base)"
		className="hh-tip"
	>
		{@render children()}
	</WarmTooltip>
{/if}
