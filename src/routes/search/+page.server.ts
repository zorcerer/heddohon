import type { PageServerLoad } from './$types';
import { library, libraryContext } from '$lib/server/library';
import { remembered } from '$lib/server/listings';
import { log, reason } from '$lib/server/log';
import type { Genre } from '$lib/types';

const LIMIT = 24;

/** Genres offered to browse before anything is typed: the largest by albums. */
const GENRES_SHOWN = 8;

/**
 * Search runs on the server on every keystroke-committed navigation, which
 * keeps the result set out of the client bundle and means a shared link to a
 * search reproduces exactly.
 *
 * Before a query, the page offers the largest genres to browse instead of an
 * empty field. They are streamed, and read from the same listing the genres
 * page uses, so a slow or failing genre list never holds the search field.
 */
export const load: PageServerLoad = async (event) => {
	const query = (event.url.searchParams.get('q') ?? '').trim();

	if (query.length < 2) {
		const { backend, credential, accountId } = libraryContext(event.locals);
		const genres: Promise<Genre[]> = remembered(accountId, 'genres', () => backend.getGenres(credential))
			.then((all) =>
				all
					.filter((genre) => (genre.albumCount ?? 0) > 0)
					.toSorted((a, b) => (b.albumCount ?? 0) - (a.albumCount ?? 0))
					.slice(0, GENRES_SHOWN)
			)
			.catch((err) => {
				log.warn('section-failed', { section: 'genres', detail: reason(err) });
				return [];
			});
		return { query, results: { albums: [], artists: [], songs: [] }, searched: false, genres };
	}

	const results = await library(event, ({ backend, credential }) =>
		backend.search(credential, query, LIMIT)
	);

	return { query, results, searched: true, genres: Promise.resolve([] as Genre[]) };
};
