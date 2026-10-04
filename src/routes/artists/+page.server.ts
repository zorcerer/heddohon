import type { PageServerLoad } from './$types';
import { library } from '$lib/server/library';
import { remembered } from '$lib/server/listings';
import { paginate, readPageNumber } from '$lib/server/paging';

export const load: PageServerLoad = async (event) => {
	// The whole list comes back from upstream on every call, and this page loads
	// again on every page turn and filter keystroke. `remembered` serves those
	// from one fetch; see `listings.ts`.
	const all = await library(event, ({ backend, credential, accountId }) =>
		remembered({ accountId, credential }, 'artists', () => backend.getArtists(credential))
	);

	// Filtered before slicing, so a search covers the whole library.
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
