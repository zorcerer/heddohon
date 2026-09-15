import type { PageServerLoad } from './$types';
import { library, libraryContext } from '$lib/server/library';
import { log, reason } from '$lib/server/log';

/**
 * How many cards the "You might like" shelf asks the music server for. The
 * grid wraps them to the width it has, so this caps the shelf rather than
 * fixing its shape: four across beside an open player panel, seven with it
 * closed, at 1440px.
 */
const SUGGESTION_COUNT = 8;

export const load: PageServerLoad = async (event) => {
	const ctx = libraryContext(event.locals);
	const album = await library(event, () => ctx.backend.getAlbum(ctx.credential, event.params.id));

	/**
	 * The rest of the artist's catalogue, newest first, with undated releases
	 * last rather than treated as year 0. Capped at the same count as the
	 * suggestion shelf; the section heading links to the artist page, which
	 * carries the full list.
	 */
	const artistAlbums = album.artistId
		? ctx.backend
				.getArtistAlbums(ctx.credential, album.artistId)
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
		// Streamed for the same reason as `similar` below, and for one more: it
		// needs the artist id, which only arrives with the album above, so
		// awaiting it would put two upstream calls in series ahead of the first
		// byte instead of none.
		artistAlbums,
		/*
		 * Streamed rather than awaited. On Navidrome this reaches Last.fm, and a
		 * third party that is slow or down must not hold up the track list, which
		 * is the reason the page exists. SvelteKit sends the rest of the page
		 * immediately and pushes this down the same response when it resolves.
		 *
		 * The rejection is swallowed here rather than left to the page: an
		 * unhandled rejection on a streamed promise takes down the whole load,
		 * and a missing shelf is not worth a 500.
		 */
		similar: ctx.backend
			.getSimilarAlbums(ctx.credential, album.id, album.artistId, SUGGESTION_COUNT)
			.catch((err) => {
				log.warn('similar-albums-failed', { album: album.id, detail: reason(err) });
				return [];
			})
	};
};
