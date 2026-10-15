/**
 * The "You might like" shelves on album and artist pages, remembered per
 * account for 30 days.
 *
 * On Navidrome both come from its external agents (Last.fm and others), and on
 * Subsonic the album shelf is `getSimilarSongs2` folded into albums, filled
 * up from the album's genre, so they are usually the slowest reads on the
 * page, and what they answer changes over months.
 *
 * An album removed by a scan stays on a shelf until its entry expires, and
 * opening it shows the not-found page. The cards show no favourite state, so a
 * star drops nothing here.
 *
 * `memo.ts` has how entries are held and shared.
 */
import type { Album, Artist, ExternalLink } from '$lib/types';
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
	limit: number,
	/** The album's genre and year, for a server that fills the shelf from them. */
	like: { genre: string | null; year: number | null }
): Promise<Album[]> {
	return suggestions.get(
		{ accountId, credential },
		`album\u0000${albumId}\u0000${limit}`,
		() => backend.getSimilarAlbums(credential, albumId, artistId, limit, like),
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

/** At most this many links under a page; Jellyfin with every provider plugin has a dozen. */
const MAX_LINKS = 8;

/**
 * Pages about an album or an artist elsewhere, held with the shelves: on
 * Navidrome the Last.fm address comes from the same agent, and changes as
 * rarely.
 *
 * The music server's administrator writes these, as they do a station's home
 * page, so only http and https addresses without a user name become links,
 * once each, and the browser opens them with no referrer (`ExternalLinks`).
 */
export function externalLinks(
	{ backend, credential, accountId }: LibraryContext,
	kind: 'album' | 'artist',
	id: string
): Promise<ExternalLink[]> {
	return suggestions.get(
		{ accountId, credential },
		`links\u0000${kind}\u0000${id}`,
		async () => {
			const seen = new Set<string>();
			const links: ExternalLink[] = [];
			for (const link of await backend.getExternalLinks(credential, kind, id)) {
				const url = URL.canParse(link.url) ? new URL(link.url) : null;
				if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) continue;
				const label = link.label.trim().slice(0, 40);
				if (!label || seen.has(url.href)) continue;
				seen.add(url.href);
				links.push({ label, url: url.href });
				if (links.length === MAX_LINKS) break;
			}
			return links;
		},
		ttlFor
	);
}

/** Drops every shelf held for an account, after its credential stopped working. */
export function forgetSuggestions(accountId: string): void {
	suggestions.forgetAccount(accountId);
}
