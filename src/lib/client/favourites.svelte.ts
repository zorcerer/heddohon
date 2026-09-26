/**
 * Favourite state changed in this tab, shared by every heart that shows the
 * same item.
 *
 * Each button used to keep its own override. The player's button is one
 * instance that is handed a new song at every track change, so the override
 * from the previous song stayed and the heart showed that song's state. A
 * track row and the player showing the same song also disagreed after either
 * was pressed. Keying the state by item fixes both.
 *
 * Entries are written only in the browser, from a press, so the server's copy
 * of this module stays empty and every server render uses the loaded value.
 * They last until the page is reloaded, which loads fresh values anyway.
 */
import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import type { StarKind } from '$lib/types';

const changed = new SvelteMap<string, boolean>();
const pending = new SvelteSet<string>();

const keyOf = (kind: StarKind, id: string) => `${kind}:${id}`;

/** The item's state as last set in this tab, or `loaded` if it has not been. */
export function isStarred(kind: StarKind, id: string, loaded: boolean): boolean {
	return changed.get(keyOf(kind, id)) ?? loaded;
}

/** True while a change to the item is on its way to the server. */
export function isPending(kind: StarKind, id: string): boolean {
	return pending.has(keyOf(kind, id));
}

/**
 * Sets the item's state at once and reverts it if the server refuses. Does
 * nothing while a change to the same item is in flight.
 */
export async function setStarred(kind: StarKind, id: string, starred: boolean): Promise<void> {
	const key = keyOf(kind, id);
	if (pending.has(key)) return;

	changed.set(key, starred);
	pending.add(key);
	try {
		const response = await fetch('/api/star', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ id, kind, starred })
		});
		if (!response.ok) changed.set(key, !starred);
	} catch {
		changed.set(key, !starred);
	} finally {
		pending.delete(key);
	}
}
