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
 * `memo.ts` has how entries are held and shared.
 */
import { Memo } from './memo';

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

const listings = new Memo(LISTING_TTL_MS, MAX_LISTINGS);

export type ListingName = 'artists' | 'starred' | 'genres';

/** The listing `name` for `accountId`, from memory when it is fresh enough. */
export function remembered<T>(accountId: string, name: ListingName, load: () => Promise<T>): Promise<T> {
	return listings.get(accountId, name, load);
}

/**
 * Drops listings held for an account: one of them after a write that changes
 * it, or every one after the account's credential stopped working.
 */
export function forgetListings(accountId: string, name?: ListingName): void {
	if (name) listings.forget(accountId, name);
	else listings.forgetAccount(accountId);
}
