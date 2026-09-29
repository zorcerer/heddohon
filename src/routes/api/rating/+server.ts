import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { backendFor } from '$lib/server/backends';
import { library } from '$lib/server/library';
import { forgetListings } from '$lib/server/listings';
import { forgetDetails } from '$lib/server/details';

/** Sets the listener's rating of a song or an album, 1 to 5, or clears it with 0. */
export const POST: RequestHandler = async (event) => {
	const session = event.locals.session;
	if (!session) error(401, 'Not signed in');

	const body = (await event.request.json().catch(() => null)) as { id?: unknown; rating?: unknown } | null;
	if (!body || typeof body.id !== 'string' || body.id.length === 0 || body.id.length >= 256) {
		error(400, 'id is required');
	}
	if (typeof body.rating !== 'number' || !Number.isInteger(body.rating) || body.rating < 0 || body.rating > 5) {
		error(400, 'rating must be a whole number from 0 to 5');
	}
	const { id, rating } = body as { id: string; rating: number };

	// The page offers no stars where this is missing; a request anyway is
	// asking for something the server does not have.
	const backend = backendFor(session.account.backend);
	if (!backend.setRating) error(404, 'This music server keeps no ratings');

	// `library` ends the account's sessions when the music server rejects the
	// stored credential, as a page load does.
	await library(event, (ctx) => backend.setRating!(ctx.credential, id, rating));
	// Album details carry the ratings of the album and its songs, and the
	// favourites listing those of its songs.
	forgetDetails(session.account.id);
	forgetListings(session.account.id, 'starred');
	return json({ id, rating });
};
