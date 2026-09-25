import type { PageServerLoad } from './$types';
import { library } from '$lib/server/library';
import { remembered } from '$lib/server/listings';
import { paginate, readPageNumber } from '$lib/server/paging';

export const load: PageServerLoad = async (event) => {
	// The whole list comes back from upstream on every call, and this page is
	// loaded again on every page turn and every filter keystroke. `remembered`
	// serves those from one fetch; see `listings.ts` for the window and the key.
	const all = await library(event, ({ backend, credential, accountId }) =>
		remembered(accountId, 'artists', () => backend.getArtists(credential))
	);

	// The filter is applied before slicing, so searching looks across the whole
	// library rather than only the page you happen to be on.
	const query = (event.url.searchParams.get('q') ?? '').trim();
	const matches = query
		? all.filter((artist) => artist.name.toLowerCase().includes(query.toLowerCase()))
		: all;

	return {
		...paginate(matches, readPageNumber(event.url.searchParams)),
		query,
		libraryTotal: all.length
	};
};
