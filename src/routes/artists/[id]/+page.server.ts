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
	const artist = await library(event, () => ctx.backend.getArtist(ctx.credential, event.params.id));

	return {
		artist,
		// Streamed, and the rejection swallowed, for the reasons set out in the
		// album page's loader.
		similar: ctx.backend
			.getSimilarArtists(ctx.credential, artist.id, SUGGESTION_COUNT)
			.catch((err) => {
				log.warn('similar-artists-failed', { artist: artist.id, detail: reason(err) });
				return [];
			})
	};
};
