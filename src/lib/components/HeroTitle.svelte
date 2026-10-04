<script lang="ts">
	/**
	 * The headline of a hero, sized against how long it is.
	 *
	 * A hero is two columns: a fixed square of artwork, and a text block whose
	 * height the title decides. A three-line title made a taller column than a
	 * one-line one, and the artwork sat in empty space that grew with the name.
	 *
	 * The artwork centres in the row, so the slack is split above and below.
	 * And the title gives back a little size as it gets longer, which keeps
	 * long names to the line count short ones get.
	 *
	 * The measure is character count, not rendered width: it is known on the
	 * server, so the type is right in the first frame. Measuring the laid-out
	 * text would ship a title at the wrong size and then resize it.
	 */
	let {
		text,
		/** Ceiling for the fluid size, in rem. Lower for a hero with a narrower text column. */
		max = 3.9
	}: { text: string; max?: number } = $props();
</script>

<h1 class="hh-display" style="--title-len: {text.length}; --title-max: {max}rem">{text}</h1>

<style>
	h1 {
		margin: 0.1rem 0;
		/*
		 * Sizes the title to land on about two lines whatever its length.
		 *
		 * What a line holds is characters times size, so the size a title can
		 * afford falls as 1/length. A fixed amount off per character past a
		 * threshold put a 58-character title at 30px when 44px still fitted two
		 * lines.
		 *
		 * `cqw` is a percent of the hero's text column, which declares
		 * `container-type: inline-size` for this, so the expression is column
		 * width over length, scaled by a constant fitted against rendered line
		 * counts. It holds when the column is narrowed by the rail, a phone or
		 * a split view. The ceiling is container-relative too: a flat rem cap
		 * let a six-character title render at 62px inside a 334px phone column.
		 * The floor keeps a very long name readable, and on a narrow screen the
		 * hero stacks, so the extra lines cost the artwork nothing.
		 */
		font-size: clamp(
			1.6rem,
			calc(320cqw / var(--title-len, 20)),
			min(var(--title-max, 3.9rem), 10cqw)
		);
	}
</style>
