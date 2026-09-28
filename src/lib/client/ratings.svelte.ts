/**
 * Ratings changed in this tab, shared by every set of stars that shows the
 * same item, as `favourites.svelte.ts` does for hearts: the player hands one
 * component a new song at every track change, and the album page and the
 * player can show the same album's songs.
 *
 * Entries are written only in the browser, from a press, so the server's copy
 * of this module stays empty and every server render uses the loaded value.
 */
import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import type { RatingKind } from '$lib/types';

const changed = new SvelteMap<string, number>();
const pending = new SvelteSet<string>();

const keyOf = (kind: RatingKind, id: string) => `${kind}:${id}`;

/** The item's rating as last set in this tab, or `loaded` if it has not been. */
export function ratingOf(kind: RatingKind, id: string, loaded: number): number {
	return changed.get(keyOf(kind, id)) ?? loaded;
}

/**
 * Sets the item's rating at once and puts back the one it had if the server
 * refuses. Does nothing while a change to the same item is in flight.
 */
export async function setRating(kind: RatingKind, id: string, rating: number, previous: number): Promise<void> {
	const key = keyOf(kind, id);
	if (pending.has(key)) return;

	changed.set(key, rating);
	pending.add(key);
	try {
		const response = await fetch('/api/rating', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ id, rating })
		});
		if (!response.ok) changed.set(key, previous);
	} catch {
		changed.set(key, previous);
	} finally {
		pending.delete(key);
	}
}
