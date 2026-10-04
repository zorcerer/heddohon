/**
 * Whole-library listings, remembered per account for 30 seconds.
 *
 * Subsonic's `getArtists` and `getStarred2` have no offset or filter, so the
 * artists and favourites pages asked for the whole set on every page turn, tab
 * switch and filter keystroke, then kept 100 (see `paging.ts`). Against a mock
 * Subsonic server with 5000 artists answering `getArtists` in 150ms, ten page
 * turns and five filter queries made 15 upstream calls and took 2552 to
 * 2637ms. With this the same walk makes one call.
 *
 * The genre list is held the same way: every genre page read the whole list to
 * find its name.
 *
 * `memo.ts` has how entries are held and shared.
 */
import { Memo, type MemoScope } from './memo';

/**
 * How long a listing is served without asking again, and so how late a change
 * made outside Heddohon can appear. A star made through Heddohon drops the
 * entry at once (`/api/star`).
 */
const LISTING_TTL_MS = 30_000;

/**
 * Entries held at once, oldest dropped first. A listing of 5000 artists
 * measured 0.77MB of heap, so 64 entries are tens of megabytes. Reached only
 * when 22 accounts open all three listings inside one window.
 */
const MAX_LISTINGS = 64;

const listings = new Memo(LISTING_TTL_MS, MAX_LISTINGS);

export type ListingName = 'artists' | 'starred' | 'genres';

/** The listing `name` for the account, from memory when it is fresh enough. */
export function remembered<T>(scope: MemoScope, name: ListingName, load: () => Promise<T>): Promise<T> {
	return listings.get(scope, name, load);
}

/**
 * Drops listings held for an account: one of them after a write that changes
 * it, or every one after the account's credential stopped working.
 */
export function forgetListings(accountId: string, name?: ListingName): void {
	if (name) listings.forget(accountId, name);
	else listings.forgetAccount(accountId);
}
