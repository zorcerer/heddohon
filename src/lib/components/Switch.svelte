<script lang="ts">
	import SquishSwitch from './bits/SquishSwitch.svelte';

	/**
	 * An on/off setting: Svelte Bits' SquishSwitch, whose thumb stretches as it
	 * travels and can be dragged. Named by the `<label>` around it, or by
	 * `label`. With a `name` it posts in a form as a checkbox does, `on` or
	 * nothing, so a form action reads it unchanged, and its button is
 * `switch-<name>`.
	 */
	let {
		// No fallback: a form's field can start undefined, which is off.
		checked = $bindable(),
		name,
		label,
		disabled = false,
		onchange
	}: {
		checked?: boolean;
		name?: string;
		label?: string;
		disabled?: boolean;
		onchange?: (checked: boolean) => void;
	} = $props();
</script>

<SquishSwitch
	checked={checked ?? false}
	onChange={(next) => {
		checked = next;
		onchange?.(next);
	}}
	id={name ? `switch-${name}` : undefined}
	ariaLabel={label}
	{disabled}
	width={40}
	height={22}
	radius={11}
	trackColor="color-mix(in srgb, var(--text-muted) 35%, transparent)"
	trackOnColor="var(--accent)"
	thumbColor="var(--text-strong)"
	thumbOnColor="var(--accent-contrast)"
	className="hh-switch"
/>
{#if name && checked && !disabled}<input type="hidden" {name} value="on" />{/if}
