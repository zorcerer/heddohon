import type { PageServerLoad } from './$types';
import { library } from '$lib/server/library';

const LIMIT = 24;

/**
 * Search runs on the server on every keystroke-committed navigation, which
 * keeps the result set out of the client bundle and means a shared link to a
 * search reproduces exactly.
 */
export const load: PageServerLoad = async (event) => {
	const query = (event.url.searchParams.get('q') ?? '').trim();

	if (query.length < 2) {
		return { query, results: { albums: [], artists: [], songs: [] }, searched: false };
	}

	const results = await library(event, ({ backend, credential }) =>
		backend.search(credential, query, LIMIT)
	);

	return { query, results, searched: true };
};
