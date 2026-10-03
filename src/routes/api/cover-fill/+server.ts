import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { backendFor } from '$lib/server/backends';
import { config } from '$lib/server/config';
import { fillStatus, startFill, stopFill } from '$lib/server/coverfill';

/** Where the account's fill stands. The settings page asks while one runs. */
export const GET: RequestHandler = ({ locals }) => {
	const session = locals.session;
	if (!session) error(401, 'Not signed in');
	return json(fillStatus(session.account.id));
};

/**
 * Starts caching every cover in the library; see `coverfill.ts`.
 *
 * For an account the music server lists as an administrator, asked of the
 * music server on each start. Clearing the cache is open to every account,
 * since all it costs is covers fetched once more. A fill has the music server
 * render every cover in the library and takes the disk budget, so an answer of
 * "not known" (a Subsonic server without `getUser`) is refused with the rest.
 */
export const POST: RequestHandler = async ({ locals }) => {
	const session = locals.session;
	if (!session) error(401, 'Not signed in');
	if (config().coverCacheBytes === 0) error(409, 'The cover cache is switched off.');
	if ((await backendFor(session.account.backend).isAdmin(session.credential)) !== true) {
		error(403, 'The music server does not list this account as an administrator.');
	}
	const status = startFill(session.account, session.credential);
	if (!status) error(409, 'Another administrator is already caching every cover.');
	return json(status);
};

/** Stops the account's own fill. Covers already stored stay. */
export const DELETE: RequestHandler = ({ locals }) => {
	const session = locals.session;
	if (!session) error(401, 'Not signed in');
	stopFill(session.account.id);
	return json(fillStatus(session.account.id));
};
