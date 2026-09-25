import type { PageServerLoad } from './$types';
import { library } from '$lib/server/library';
import { remembered } from '$lib/server/listings';
import { paginate, readPageNumber } from '$lib/server/paging';
import type { Album, Artist, Song } from '$lib/types';

const TABS = ['songs', 'albums', 'artists'] as const;
type Tab = (typeof TABS)[number];

type FavouriteSort =
	| 'recentlyStarred'
	| 'alphabetical'
	| 'byArtist'
	| 'byAlbum'
	| 'byYear'
	| 'mostPlayed'
	| 'recentlyAdded'
	| 'mostAlbums';

/** The orders each tab offers, the first being the default where it applies. */
const SORTS: Record<Tab, readonly FavouriteSort[]> = {
	songs: ['recentlyStarred', 'alphabetical', 'byArtist', 'byAlbum', 'mostPlayed'],
	albums: ['recentlyStarred', 'alphabetical', 'byArtist', 'byYear', 'recentlyAdded'],
	artists: ['recentlyStarred', 'alphabetical', 'mostAlbums']
};

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

/** Text order with missing values last, so a track with no album does not lead the list. */
function byText(a: string | null, b: string | null): number {
	if (a === b) return 0;
	if (a === null) return 1;
	if (b === null) return -1;
	return collator.compare(a, b);
}

/** Largest first, missing values last. */
function byNumberDescending(a: number | null, b: number | null): number {
	return (b ?? -Infinity) - (a ?? -Infinity);
}

type Compare<T> = (a: T, b: T) => number;

const SONG_ORDER: Partial<Record<FavouriteSort, Compare<Song>>> = {
	recentlyStarred: (a, b) => byNumberDescending(a.starredAt, b.starredAt),
	alphabetical: (a, b) => byText(a.title, b.title),
	byArtist: (a, b) =>
		byText(a.albumArtist ?? a.artist, b.albumArtist ?? b.artist) ||
		byText(a.album, b.album) ||
		(a.disc ?? 0) - (b.disc ?? 0) ||
		(a.track ?? 0) - (b.track ?? 0),
	byAlbum: (a, b) =>
		byText(a.album, b.album) || (a.disc ?? 0) - (b.disc ?? 0) || (a.track ?? 0) - (b.track ?? 0),
	mostPlayed: (a, b) => byNumberDescending(a.playCount, b.playCount)
};

const ALBUM_ORDER: Partial<Record<FavouriteSort, Compare<Album>>> = {
	recentlyStarred: (a, b) => byNumberDescending(a.starredAt, b.starredAt),
	alphabetical: (a, b) => byText(a.name, b.name),
	byArtist: (a, b) => byText(a.artist, b.artist) || byNumberDescending(a.year, b.year),
	byYear: (a, b) => byNumberDescending(a.year, b.year),
	recentlyAdded: (a, b) => byNumberDescending(a.createdAt, b.createdAt)
};

const ARTIST_ORDER: Partial<Record<FavouriteSort, Compare<Artist>>> = {
	recentlyStarred: (a, b) => byNumberDescending(a.starredAt, b.starredAt),
	alphabetical: (a, b) => byText(a.name, b.name),
	mostAlbums: (a, b) => byNumberDescending(a.albumCount, b.albumCount)
};

/**
 * A sorted copy. The listing is shared by every request inside its 30 seconds
 * (`listings.ts`) and must not be sorted in place. Ties fall back to the name,
 * so two tracks with the same play count keep one order from load to load.
 */
function sorted<T extends { title: string } | { name: string }>(
	items: readonly T[],
	order: Compare<T> | undefined
): T[] {
	const name = (item: T) => ('title' in item ? item.title : item.name);
	return order
		? [...items].sort((a, b) => order(a, b) || collator.compare(name(a), name(b)))
		: [...items];
}

export const load: PageServerLoad = async (event) => {
	// Whole on both servers, and this page is loaded again on every tab switch
	// and page turn. `/api/star` drops the entry, so a change made here shows at
	// once; see `listings.ts`.
	const starred = await library(event, ({ backend, credential, accountId }) =>
		remembered(accountId, 'starred', () => backend.getStarred(credential))
	);

	const requested = event.url.searchParams.get('tab');
	// Land on whichever tab actually has something in it, so an account with no
	// favourite tracks but plenty of albums does not open on an empty list.
	const fallback: Tab =
		starred.songs.length > 0
			? 'songs'
			: starred.albums.length > 0
				? 'albums'
				: 'artists';
	const tab: Tab = TABS.includes(requested as Tab) ? (requested as Tab) : fallback;

	// "Recently starred" needs a date for the star, which Subsonic reports and
	// Jellyfin does not. Where none is known it is left off rather than offered
	// as an order that changes nothing.
	const dated = starred[tab].some((item) => item.starredAt !== null);
	const sorts = SORTS[tab].filter((sort) => sort !== 'recentlyStarred' || dated);
	const requestedSort = event.url.searchParams.get('sort');
	const sort = sorts.includes(requestedSort as FavouriteSort)
		? (requestedSort as FavouriteSort)
		: sorts[0];

	const page = readPageNumber(event.url.searchParams);

	return {
		tab,
		tabs: TABS,
		sort,
		sorts,
		counts: {
			songs: starred.songs.length,
			albums: starred.albums.length,
			artists: starred.artists.length
		},
		// Only the visible tab is sorted, paginated and sent; the other two would
		// be dead weight in the payload and in the DOM.
		songs: tab === 'songs' ? paginate(sorted(starred.songs, SONG_ORDER[sort]), page) : null,
		albums: tab === 'albums' ? paginate(sorted(starred.albums, ALBUM_ORDER[sort]), page) : null,
		artists: tab === 'artists' ? paginate(sorted(starred.artists, ARTIST_ORDER[sort]), page) : null
	};
};
