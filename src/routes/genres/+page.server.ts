import type { PageServerLoad } from './$types';
import { library } from '$lib/server/library';
import { remembered } from '$lib/server/listings';

export const load: PageServerLoad = async (event) => ({
	// The same listing each genre page reads for its name; see `listings.ts`.
	genres: await library(event, ({ backend, credential, accountId }) =>
		remembered(accountId, 'genres', () => backend.getGenres(credential))
	)
});
