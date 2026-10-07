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
	| 'mostAlbums'
	| 'random';

/** The orders each tab offers, the first being the default where it applies. */
const SORTS: Record<Tab, readonly FavouriteSort[]> = {
	songs: ['recentlyStarred', 'alphabetical', 'byArtist', 'byAlbum', 'mostPlayed', 'random'],
	albums: ['recentlyStarred', 'alphabetical', 'byArtist', 'byYear', 'recentlyAdded', 'random'],
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
 * Where an item falls in the shuffle for `seed`: FNV-1a over the seed and the
 * id. The seed travels in the URL, so page two continues page one's order. A
 * star added or removed moves no other item.
 */
function shufflePosition(seed: number, id: string): number {
	let hash = 0x811c9dc5 ^ seed;
	for (let i = 0; i < id.length; i++) {
		hash ^= id.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return hash >>> 0;
}

function shuffled<T extends { id: string }>(seed: number): Compare<T> {
	return (a, b) => shufflePosition(seed, a.id) - shufflePosition(seed, b.id);
}

/** The shuffle seed from the URL, or null when it is missing or not one. */
function readSeed(params: URLSearchParams): number | null {
	const raw = params.get('seed');
	if (raw === null || !/^\d{1,10}$/.test(raw)) return null;
	const seed = Number(raw);
	return seed <= 0xffffffff ? seed : null;
}

const newSeed = () => Math.floor(Math.random() * 0x100000000);

/**
 * A sorted copy. The listing is shared by every request inside its 30 seconds
 * (`listings.ts`) and must not be sorted in place. Ties fall back to the name,
 * so the order is the same from load to load.
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

/*
 * Sorted copies, remembered against the listing they came from, so a page turn
 * inside the listing's 30 seconds does not sort again: with 20,000 favourites
 * a sort took 40 to 115ms of the event loop. Held weakly, so a copy goes with
 * its listing. Eight orders per listing, the most recent, since a shuffle's
 * seed can take any value.
 */
const sortedCopies = new WeakMap<readonly unknown[], Map<string, unknown[]>>();

function sortedOnce<T extends { title: string } | { name: string }>(
	items: readonly T[],
	key: string,
	order: Compare<T> | undefined
): T[] {
	let copies = sortedCopies.get(items);
	if (!copies) sortedCopies.set(items, (copies = new Map()));
	const held = copies.get(key);
	if (held) return held as T[];
	const copy = sorted(items, order);
	copies.set(key, copy);
	if (copies.size > 8) copies.delete(copies.keys().next().value!);
	return copy;
}

export const load: PageServerLoad = async (event) => {
	// Whole on both servers, and this page loads again on every tab switch and
	// page turn. `/api/star` drops the entry, so a change made here shows at
	// once; see `listings.ts`.
	const starred = await library(event, ({ backend, credential, accountId }) =>
		remembered({ accountId, credential }, 'starred', () => backend.getStarred(credential))
	);

	const requested = event.url.searchParams.get('tab');
	// Lands on a tab that has something in it.
	const fallback: Tab =
		starred.songs.length > 0
			? 'songs'
			: starred.albums.length > 0
				? 'albums'
				: 'artists';
	const tab: Tab = TABS.includes(requested as Tab) ? (requested as Tab) : fallback;

	// "Recently starred" needs the date of the star, which Subsonic reports and
	// Jellyfin does not. Without one the order is not offered.
	const dated = starred[tab].some((item) => item.starredAt !== null);
	const sorts = SORTS[tab].filter((sort) => sort !== 'recentlyStarred' || dated);
	const requestedSort = event.url.searchParams.get('sort');
	const sort = sorts.includes(requestedSort as FavouriteSort)
		? (requestedSort as FavouriteSort)
		: sorts[0];

	const page = readPageNumber(event.url.searchParams);
	// A shuffle opened without a seed draws one, and the page's links carry it.
	const seed = sort === 'random' ? (readSeed(event.url.searchParams) ?? newSeed()) : null;
	const songOrder = seed === null ? SONG_ORDER[sort] : shuffled<Song>(seed);
	const albumOrder = seed === null ? ALBUM_ORDER[sort] : shuffled<Album>(seed);

	return {
		tab,
		tabs: TABS,
		sort,
		sorts,
		seed,
		// What the "Random" chip links to. Drawn here, so the server-rendered link
		// and the hydrated one match, and pressing it again deals a new order.
		reshuffleSeed: newSeed(),
		counts: {
			songs: starred.songs.length,
			albums: starred.albums.length,
			artists: starred.artists.length
		},
		// Only the visible tab is sorted, paginated and sent.
		songs: tab === 'songs' ? paginate(sortedOnce(starred.songs, `${sort}:${seed}`, songOrder), page) : null,
		albums: tab === 'albums' ? paginate(sortedOnce(starred.albums, `${sort}:${seed}`, albumOrder), page) : null,
		artists: tab === 'artists' ? paginate(sortedOnce(starred.artists, sort, ARTIST_ORDER[sort]), page) : null
	};
};
