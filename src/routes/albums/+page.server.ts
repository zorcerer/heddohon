import type { PageServerLoad } from './$types';
import { library } from '$lib/server/library';
import type { AlbumSort } from '$lib/types';

const SORTS: AlbumSort[] = [
	'recentlyAdded',
	'alphabetical',
	'byArtist',
	'byYear',
	'mostPlayed',
	'recentlyPlayed',
	'starred',
	'random'
];

const PAGE_SIZE = 60;

export const load: PageServerLoad = async (event) => {
	const requested = event.url.searchParams.get('sort');
	const sort = SORTS.includes(requested as AlbumSort)
		? (requested as AlbumSort)
		: ((event.locals.settings?.defaultAlbumSort as AlbumSort) ?? 'recentlyAdded');

	const page = Math.max(1, Number(event.url.searchParams.get('page')) || 1);
	const offset = (page - 1) * PAGE_SIZE;

	// One extra row tells us whether a next page exists without a count query,
	// which Subsonic does not offer anyway.
	const albums = await library(event, ({ backend, credential }) =>
		backend.getAlbums(credential, { sort, limit: PAGE_SIZE + 1, offset })
	);

	return {
		albums: albums.slice(0, PAGE_SIZE),
		hasMore: albums.length > PAGE_SIZE,
		page,
		sort,
		sorts: SORTS
	};
};
