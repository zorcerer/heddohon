<script lang="ts">
	import { goto } from '$app/navigation';
	import RubberSegment from './bits/RubberSegment.svelte';

	/**
	 * A few views of one page, one chosen: Svelte Bits' RubberSegment, whose
	 * thumb stretches across to the choice and can be dragged there. Each
	 * choice is an address, so a view is still a URL that Back restores; the
	 * page keeps its scroll, as the sort links do.
	 */
	let {
		items,
		value,
		label
	}: {
		items: { value: string; label: string; href: string }[];
		value: string;
		label: string;
	} = $props();
</script>

<RubberSegment
	items={items.map(({ value, label }) => ({ value, label }))}
	{value}
	onChange={(next) => {
		const to = items.find((item) => item.value === next);
		if (to) void goto(to.href, { reset: false });
	}}
	equalSlots={false}
	size="sm"
	radius={999}
	trackColor="var(--control-face)"
	thumbColor="var(--accent)"
	textColor="var(--text-muted-through)"
	activeTextColor="var(--accent-contrast)"
	aria-label={label}
	className="hh-segment"
/>

<style>
	/* Terminal draws no round controls: square, as its keys are. The radii are
	   the component's own variables, set on the element. */
	:global([data-theme='terminal'] .hh-segment) {
		--rs-radius: 0px !important;
		--rs-thumb-radius: 0px !important;
	}
</style>
