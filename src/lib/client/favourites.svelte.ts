/**
 * Favourite state changed in this tab, shared by every heart that shows the
 * same item.
 *
 * Keyed by item, not kept per button. The player's button is one instance
 * handed a new song at every track change, so its own override showed the
 * previous song's state, and a track row and the player disagreed about one
 * song after either was pressed.
 *
 * Entries are written only in the browser, from a press, so the server's copy
 * of this module stays empty and server renders use the loaded value.
 *
 * They last until the next page has loaded (`settleStarred`). Kept until a
 * reload, in a tab open for days, a heart pressed here and changed later in
 * another player went on showing the press. A page loaded after a press
 * already has it, since `/api/star` drops the server's held copies after the
 * write.
 */
import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import type { StarKind } from '$lib/types';
import { player } from './player.svelte';

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

	const settle = (value: boolean) => {
		changed.set(key, value);
		// The player's heart reads the queue's copy of the song, which no page load
		// refreshes, so the copy is changed with the press.
		if (kind === 'song') player.markStarred(id, value);
	};
	settle(starred);
	pending.add(key);
	try {
		const response = await fetch('/api/star', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ id, kind, starred })
		});
		if (!response.ok) settle(!starred);
	} catch {
		settle(!starred);
	} finally {
		pending.delete(key);
	}
}

/**
 * Hands every heart back to the values loaded with the page, after a
 * navigation. A press still on its way to the server is kept: the page may
 * have loaded before it landed.
 */
export function settleStarred(): void {
	for (const key of [...changed.keys()]) if (!pending.has(key)) changed.delete(key);
}
