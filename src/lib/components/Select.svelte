<script lang="ts" generics="T extends string">
	import GlideSelect from './bits/GlideSelect.svelte';

	/**
	 * One of a list: Svelte Bits' GlideSelect, whose menu pops from the chip
	 * and whose highlight glides from option to option. Named by `label`, the
	 * text beside it: GlideSelect names itself "Select" otherwise, over any
	 * `<label>` around it. With a `name` the value posts in a form, from a
	 * hidden field of that name, and the control is `data-select="<name>"`.
	 */
	let {
		value = $bindable(),
		options,
		name,
		label,
		disabled = false,
		onchange
	}: {
		value: T;
		options: readonly { value: T; label: string }[];
		name?: string;
		label: string;
		disabled?: boolean;
		onchange?: (value: T) => void;
	} = $props();
</script>

<span class="hh-select" data-select={name}>
	<GlideSelect
		options={[...options]}
		{value}
		onChange={(next) => {
			value = next as T;
			onchange?.(next as T);
		}}
		ariaLabel={label}
		{disabled}
		size="sm"
		radius={8}
		menuWidth={208}
		accentColor="var(--accent)"
		surfaceColor="var(--bg-raised)"
		highlightColor="color-mix(in srgb, var(--accent) 22%, transparent)"
		textColor="var(--text-strong)"
	/>
	{#if name}<input type="hidden" {name} {value} {disabled} />{/if}
</span>

<style>
	.hh-select {
		display: inline-block;
	}
</style>
