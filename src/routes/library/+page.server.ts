import type { PageServerLoad } from './$types';
import { libraryContext, librarySettled } from '$lib/server/library';

/** Playlists on the shelf under the list: the ones most recently changed. */
const PLAYLISTS_SHOWN = 12;

/**
 * The Library tab on a phone: the ways into the collection, and two shelves
 * under them. Each shelf loads on its own, as on the home page.
 */
export const load: PageServerLoad = async ({ locals }) => {
	const { backend, credential } = libraryContext(locals);
	const shelves = await librarySettled({
		recentlyAdded: backend.getAlbums(credential, { sort: 'recentlyAdded', limit: 12, offset: 0 }),
		playlists: backend.getPlaylists(credential)
	});

	const playlists = (shelves.playlists ?? [])
		.toSorted((a, b) => (b.changedAt ?? -Infinity) - (a.changedAt ?? -Infinity))
		.slice(0, PLAYLISTS_SHOWN);

	return { recentlyAdded: shelves.recentlyAdded ?? [], playlists };
};
