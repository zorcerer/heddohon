import type { PageServerLoad } from './$types';
import { library, libraryContext } from '$lib/server/library';
import { log, reason } from '$lib/server/log';
import { appearsOn, artistDetail } from '$lib/server/details';
import { similarArtists } from '$lib/server/suggestions';

/**
 * How many cards the "You might like" shelf asks the music server for. The
 * grid wraps them to its width: four across beside an open player panel, seven
 * with it closed, at 1440px.
 */
const SUGGESTION_COUNT = 8;

export const load: PageServerLoad = async (event) => {
	const ctx = libraryContext(event.locals);
	const artist = await library(event, () => artistDetail(ctx, event.params.id));

	return {
		artist,
		// Streamed, and the rejection swallowed, as in the album page's loader.
		similar: similarArtists(ctx, artist.id, SUGGESTION_COUNT).catch((err) => {
			log.warn('similar-artists-failed', { artist: artist.id, detail: reason(err) });
			return [];
		}),
		// A search on Subsonic (`subsonic.ts`), so streamed as well.
		appearsOn: appearsOn(ctx, artist).catch((err) => {
			log.warn('appears-on-failed', { artist: artist.id, detail: reason(err) });
			return [];
		})
	};
};
