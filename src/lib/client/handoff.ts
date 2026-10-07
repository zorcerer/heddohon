import { tick } from 'svelte';

/**
 * Moves focus to the control that undoes a toggle whose own button has just
 * gone away.
 *
 * Showing and hiding the player swaps one control for another: the sliver on
 * the right-hand edge opens it, the chevron in the tool row closes it, and the
 * one pressed is inert by the time the click finishes. Left alone, focus falls
 * to the document body and the next Tab starts from the top of the page.
 *
 * Addressed by id: the two controls are in different components.
 */
export async function handOff(id: string): Promise<void> {
	await tick();
	const target = document.getElementById(id);
	// `offsetParent` is null inside a `display: none` subtree, which the
	// counterpart is below the sheet breakpoint. Focusing it there would drop
	// focus.
	if (target instanceof HTMLElement && target.offsetParent !== null) target.focus();
}
