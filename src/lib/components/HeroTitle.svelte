<script lang="ts">
	/**
	 * The headline of a hero, sized against how long it is.
	 *
	 * A hero is two columns: a fixed square of artwork, and a text block whose
	 * height is decided by the title. A one-line title and a three-line title
	 * therefore build columns of very different heights, and the artwork ends up
	 * sitting in a pool of empty space that grows with the name of the record.
	 *
	 * Two things fix that together, and both are needed. The artwork centres in
	 * the row rather than hanging off its bottom edge, so whatever slack is left
	 * is split above and below instead of collecting on one side. And the title
	 * gives back a little size as it gets longer, which is what this is for: it
	 * keeps long names to the same line count short ones get, so there is much
	 * less slack to split in the first place.
	 *
	 * The measure is character count, not rendered width. That is deliberate —
	 * it is known at render time, on the server, so the type is right in the
	 * first frame. Measuring the laid-out text would be more accurate and would
	 * also mean shipping a title at the wrong size and then visibly resizing it.
	 */
	let {
		text,
		/** Ceiling for the fluid size, in rem. Heroes with a narrower text column
		    want a lower one. */
		max = 3.9
	}: { text: string; max?: number } = $props();
</script>

<h1 class="hh-display" style="--title-len: {text.length}; --title-max: {max}rem">{text}</h1>

<style>
	h1 {
		margin: 0.1rem 0;
		/*
		 * Size the title so it lands on about two lines whatever its length.
		 *
		 * The first attempt took a fixed amount off per character past a
		 * threshold. That is the wrong shape: what a line holds is characters ×
		 * size, so the size a title can afford falls as 1/length, not linearly.
		 * Measured, the linear taper put a 58-character title at 30px when 44px
		 * still fitted two lines — it shrank hardest exactly where it hurt most.
		 *
		 * `cqw` is a percent of the hero's text column, which declares
		 * `container-type: inline-size` for this, so what follows is "column
		 * width ÷ length", scaled by a constant fitted against
		 * rendered line counts: it needs no viewport guesswork and it holds when
		 * the column is narrowed by the rail, by a phone, or by a split view.
		 * The ceiling is container-relative for the same reason the size is: a
		 * flat rem cap let a six-character title render at 62px inside a 334px
		 * phone column, because nothing in the expression knew the column had
		 * got smaller. The floor keeps a pathological name readable; past a
		 * point such a title simply needs the lines, and on a narrow screen the
		 * hero stacks anyway, so the artwork is not the thing paying for it.
		 */
		font-size: clamp(
			1.6rem,
			calc(320cqw / var(--title-len, 20)),
			min(var(--title-max, 3.9rem), 10cqw)
		);
	}
</style>
