import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { library } from '$lib/server/library';
import { remembered } from '$lib/server/listings';

const PAGE_SIZE = 60;

export const load: PageServerLoad = async (event) => {
	const id = event.params.id;
	if (id.length === 0 || id.length > 200) error(404, 'That genre does not exist.');
	const page = Math.max(1, Number(event.url.searchParams.get('page')) || 1);

	// The list is read alongside for the name and the counts: on Jellyfin the
	// id in the path is an item id, and the name is not in it. It is the listing
	// the genres page holds for 30 seconds, so a page turn or a genre opened
	// from that page asks the music server only for the albums.
	const [genres, albums] = await library(event, ({ backend, credential, accountId }) =>
		Promise.all([
			remembered(accountId, 'genres', () => backend.getGenres(credential)),
			backend.getGenreAlbums(credential, id, PAGE_SIZE + 1, (page - 1) * PAGE_SIZE)
		])
	);
	const genre = genres.find((candidate) => candidate.id === id);
	if (!genre) error(404, 'That genre does not exist.');

	return { genre, albums: albums.slice(0, PAGE_SIZE), hasMore: albums.length > PAGE_SIZE, page };
};
