import type { PageServerLoad } from './$types';
import { library, libraryContext } from '$lib/server/library';
import { log, reason } from '$lib/server/log';
import { albumDetail, albumsByArtist } from '$lib/server/details';
import { similarAlbums } from '$lib/server/suggestions';

/**
 * How many cards the "You might like" shelf asks the music server for. The
 * grid wraps them to its width: four across beside an open player panel, seven
 * with it closed, at 1440px.
 */
const SUGGESTION_COUNT = 8;

export const load: PageServerLoad = async (event) => {
	const ctx = libraryContext(event.locals);
	const album = await library(event, () => albumDetail(ctx, event.params.id));

	/**
	 * The rest of the artist's catalogue, newest first, undated releases last.
	 * Capped like the suggestion shelf. The section heading links to the artist
	 * page, which has the full list.
	 */
	const artistAlbums = album.artistId
		? albumsByArtist(ctx, album.artistId)
				.then((albums) =>
					albums
						.filter((other) => other.id !== album.id)
						.sort((a, b) => (b.year ?? -Infinity) - (a.year ?? -Infinity))
						.slice(0, SUGGESTION_COUNT)
				)
				.catch((err) => {
					log.warn('artist-albums-failed', { album: album.id, detail: reason(err) });
					return [];
				})
		: Promise.resolve([]);

	return {
		album,
		// Streamed, as `similar` below is, and it needs the artist id that arrives
		// with the album: awaited, it would put two upstream calls in series ahead
		// of the first byte.
		artistAlbums,
		/*
		 * Streamed, not awaited. On Navidrome this reaches Last.fm, and a slow
		 * third party must not hold up the track list. SvelteKit sends the rest
		 * of the page and pushes this down the same response when it resolves.
		 *
		 * The rejection is swallowed here: an unhandled rejection on a streamed
		 * promise takes down the whole load.
		 */
		similar: similarAlbums(ctx, album.id, album.artistId, SUGGESTION_COUNT).catch((err) => {
			log.warn('similar-albums-failed', { album: album.id, detail: reason(err) });
			return [];
		})
	};
};
