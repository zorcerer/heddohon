import { tick } from 'svelte';

/**
 * Moves focus to the control that undoes a toggle whose own button has just
 * gone away.
 *
 * Showing and hiding the player swaps one control for another: the sliver on
 * the right-hand edge opens it, the chevron in the tool row closes it, and
 * whichever one was pressed is inert by the time the click finishes. Left
 * alone, focus falls back to the document body and the next Tab starts again
 * from the top of the page.
 *
 * Addressed by id rather than by a passed-in reference: the two controls live
 * in different components, and threading a ref through the layout to reach the
 * other one is more machinery than the two ids are worth.
 */
export async function handOff(id: string): Promise<void> {
	await tick();
	const target = document.getElementById(id);
	// `offsetParent` is null for anything inside a `display: none` subtree,
	// which is what the counterpart is below the sheet breakpoint. Focusing it
	// there would drop focus rather than move it.
	if (target instanceof HTMLElement && target.offsetParent !== null) target.focus();
}
