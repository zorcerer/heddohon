/**
 * The "You might like" shelves on album and artist pages, remembered per
 * account for 30 days.
 *
 * On Navidrome both come from its external agents (Last.fm and others), and on
 * Subsonic the album shelf is `getSimilarSongs2` folded into albums, so they
 * are usually the slowest reads on the page, and what they answer changes over
 * months.
 *
 * An album removed by a scan stays on a shelf until its entry expires, and
 * opening it shows the not-found page. The cards show no favourite state, so a
 * star drops nothing here.
 *
 * `memo.ts` has how entries are held and shared.
 */
import type { Album, Artist } from '$lib/types';
import type { LibraryContext } from './library';
import { Memo } from './memo';

const SUGGESTION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * An empty shelf is asked for again after an hour, so a server that gains an
 * agent or a similarity plugin (AudioMuse-AI) fills its shelves the same day.
 */
const EMPTY_TTL_MS = 60 * 60 * 1000;

/**
 * Entries held at once, oldest dropped first. A shelf is eight cards of a few
 * hundred bytes each, so 2000 entries are about 10MB.
 */
const MAX_SUGGESTIONS = 2000;

const suggestions = new Memo(SUGGESTION_TTL_MS, MAX_SUGGESTIONS);

const ttlFor = (items: readonly unknown[]) => (items.length > 0 ? SUGGESTION_TTL_MS : EMPTY_TTL_MS);

/** Albums like `albumId`, for its page's shelf. */
export function similarAlbums(
	{ backend, credential, accountId }: LibraryContext,
	albumId: string,
	artistId: string | null,
	limit: number
): Promise<Album[]> {
	return suggestions.get(
		{ accountId, credential },
		`album\u0000${albumId}\u0000${limit}`,
		() => backend.getSimilarAlbums(credential, albumId, artistId, limit),
		ttlFor
	);
}

/** Artists like `artistId`, for its page's shelf. */
export function similarArtists(
	{ backend, credential, accountId }: LibraryContext,
	artistId: string,
	limit: number
): Promise<Artist[]> {
	return suggestions.get(
		{ accountId, credential },
		`artist\u0000${artistId}\u0000${limit}`,
		() => backend.getSimilarArtists(credential, artistId, limit),
		ttlFor
	);
}

/** Drops every shelf held for an account, after its credential stopped working. */
export function forgetSuggestions(accountId: string): void {
	suggestions.forgetAccount(accountId);
}
