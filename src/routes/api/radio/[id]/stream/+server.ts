import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { tiedToSession } from '$lib/server/auth';
import { UpstreamError } from '$lib/server/backends';
import { openStation, RadioError, radioEnabled } from '$lib/server/radio';

/**
 * A station's stream, fetched by this server and passed on; see `radio.ts`.
 * The id is one from the music server's list for this account. What went
 * wrong is said in general terms: the station's address stays in the log.
 */
export const GET: RequestHandler = async ({ locals, params, request }) => {
	const session = locals.session;
	if (!session) error(401, 'Not signed in');
	if (!radioEnabled(session)) error(404, 'Not found');
	try {
		const response = await openStation(session, params.id, request.signal);
		return tiedToSession(session, request.signal, response);
	} catch (err) {
		if (err instanceof RadioError) {
			if (err.kind === 'unknown') error(404, 'Not found');
			if (err.kind === 'busy') error(429, 'Too many stations are playing on this account.');
			if (err.kind === 'refused') error(502, 'This station cannot be played through this server.');
			if (err.kind === 'not_audio') error(502, 'This station did not send an audio stream.');
			error(502, 'This station could not be reached.');
		}
		if (err instanceof UpstreamError) error(err.status === 401 ? 401 : 502, err.message);
		throw err;
	}
};
