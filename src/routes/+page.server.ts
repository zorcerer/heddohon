import type { PageServerLoad } from './$types';
import { libraryContext, librarySettled } from '$lib/server/library';

/**
 * The home page is rendered on the server, so the first paint already has real
 * album art and titles in it. Each shelf is loaded independently: one failing
 * endpoint dims a single row rather than taking the page down.
 */
export const load: PageServerLoad = async ({ locals }) => {
	const { backend, credential } = libraryContext(locals);

	const shelves = await librarySettled({
		recentlyAdded: backend.getAlbums(credential, { sort: 'recentlyAdded', limit: 12, offset: 0 }),
		mostPlayed: backend.getAlbums(credential, { sort: 'mostPlayed', limit: 12, offset: 0 }),
		recentlyPlayed: backend.getAlbums(credential, { sort: 'recentlyPlayed', limit: 12, offset: 0 }),
		starred: backend.getStarred(credential),
		discover: backend.getRandomSongs(credential, 12)
	});

	return {
		recentlyAdded: shelves.recentlyAdded ?? [],
		mostPlayed: shelves.mostPlayed ?? [],
		recentlyPlayed: shelves.recentlyPlayed ?? [],
		favouriteSongs: shelves.starred?.songs.slice(0, 8) ?? [],
		discover: shelves.discover ?? []
	};
};
