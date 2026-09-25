/**
 * Whole-library listings, remembered per account for 30 seconds.
 *
 * Subsonic's `getArtists` and `getStarred2` have no offset or filter
 * parameter, so the artists and favourites pages asked for the entire set on
 * every page turn, tab switch and debounced filter keystroke, then kept 100 of
 * them (see `paging.ts`). Measured against a mock Subsonic server holding 5000
 * artists and answering `getArtists` in 150ms: ten page turns and five filter
 * queries made 15 upstream calls and took 2552 to 2637ms. With this in front
 * of it the same walk makes one call.
 *
 * The genre list is held the same way. Every genre page read the whole list to
 * find its name, beside the page of albums it was opened for.
 *
 * The key is the account, never the backend or the server alone. Jellyfin
 * decides per user which libraries an account can see, so one account's
 * listing is not another's.
 *
 * What is held is the promise rather than the result, so the requests a fast
 * typist fires while the first one is still out wait for it instead of each
 * starting their own. A rejected promise is dropped as soon as it settles:
 * a failure is never served from here, and the next request asks again.
 *
 * Callers must treat the value as read-only. Every request inside the window
 * receives the same object.
 */

/**
 * How long a listing is served without asking again.
 *
 * This is how late a change made outside Heddohon can appear: an artist added
 * by a library scan, or a star made in the Navidrome or Jellyfin web
 * interface. A star made through Heddohon drops the entry at once
 * (`/api/star`), so it shows on the next load.
 */
const LISTING_TTL_MS = 30_000;

/**
 * Entries held at once, oldest dropped first. A listing of 5000 artists
 * measured 0.77MB of heap, and a starred set is usually smaller, so 64 entries
 * stays in the tens of megabytes. It is reached only when 22 accounts open
 * all three listings inside one window.
 */
const MAX_LISTINGS = 64;

const listings = new Map<string, { value: Promise<unknown>; until: number }>();

export type ListingName = 'artists' | 'starred' | 'genres';

/** The listing `name` for `accountId`, from memory when it is fresh enough. */
export function remembered<T>(accountId: string, name: ListingName, load: () => Promise<T>): Promise<T> {
	const key = `${accountId}\u0000${name}`;
	const held = listings.get(key);
	if (held && held.until > Date.now()) return held.value as Promise<T>;

	const value = load();
	// Deleted first so the entry moves to the end of the insertion order, which
	// is what the eviction below reads as age.
	listings.delete(key);
	listings.set(key, { value, until: Date.now() + LISTING_TTL_MS });
	if (listings.size > MAX_LISTINGS) listings.delete(listings.keys().next().value!);

	value.catch(() => {
		if (listings.get(key)?.value === value) listings.delete(key);
	});
	return value;
}

/**
 * Drops listings held for an account: one of them after a write that changes
 * it, or every one after the account's credential stopped working.
 *
 * A load already in flight is dropped with the rest. Its promise was stored
 * when it started, so a request after this call starts a fresh one rather
 * than waiting on a read that may predate the write.
 */
export function forgetListings(accountId: string, name?: ListingName): void {
	if (name) {
		listings.delete(`${accountId}\u0000${name}`);
		return;
	}
	const prefix = `${accountId}\u0000`;
	for (const key of listings.keys()) {
		if (key.startsWith(prefix)) listings.delete(key);
	}
}
