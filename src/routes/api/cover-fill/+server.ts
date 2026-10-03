import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { backendFor } from '$lib/server/backends';
import { config } from '$lib/server/config';
import { fillStatus, keepFilled, startFill, stopFill } from '$lib/server/coverfill';

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

/**
 * Has the fill repeated daily for this account, or stops it being repeated,
 * with `{ "daily": true | false }`. Held to the same gate as a start, and
 * switching it on starts a fill now.
 */
export const PUT: RequestHandler = async ({ locals, request }) => {
	const session = locals.session;
	if (!session) error(401, 'Not signed in');
	const body = (await request.json().catch(() => null)) as { daily?: unknown } | null;
	if (typeof body?.daily !== 'boolean') error(400, 'daily must be a boolean');
	if (config().coverCacheBytes === 0) error(409, 'The cover cache is switched off.');
	if ((await backendFor(session.account.backend).isAdmin(session.credential)) !== true) {
		error(403, 'The music server does not list this account as an administrator.');
	}
	await keepFilled(session.account.backend, body.daily ? session.account.id : null);
	if (body.daily) startFill(session.account, session.credential);
	return json({ daily: body.daily });
};

/** Stops the account's own fill. Covers already stored stay. */
export const DELETE: RequestHandler = ({ locals }) => {
	const session = locals.session;
	if (!session) error(401, 'Not signed in');
	stopFill(session.account.id);
	return json(fillStatus(session.account.id));
};
