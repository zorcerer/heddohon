<script lang="ts">
	import type { Snippet } from 'svelte';
	import SpringCheck from './bits/SpringCheck.svelte';

	/**
	 * One of a list of choices: Svelte Bits' SpringCheck, whose box fills on a
	 * spring and draws its tick. The label is beside the box, unstruck: a
	 * choice here is kept, not done. With a `name` it posts in a form as a
 * checkbox does.
	 */
	let {
		// No fallback: a form's field can start undefined, which is off.
		checked = $bindable(),
		label,
		name,
		ariaLabel,
		disabled = false,
		onchange
	}: {
		checked?: boolean;
		label?: Snippet | string;
		name?: string;
		ariaLabel?: string;
		disabled?: boolean;
		onchange?: (checked: boolean) => void;
	} = $props();
</script>

<SpringCheck
	checked={checked ?? false}
	onChange={(next) => {
		checked = next;
		onchange?.(next);
	}}
	label={label ?? null}
	{ariaLabel}
	{disabled}
	strike="none"
	doneOpacity={1}
	boxSize={18}
	boxRadius={5}
	fontSize={15}
	color="var(--text-default)"
	fillColor="var(--accent)"
	checkColor="var(--accent-contrast)"
	className="hh-check"
/>
{#if name && checked && !disabled}<input type="hidden" {name} value="on" />{/if}
