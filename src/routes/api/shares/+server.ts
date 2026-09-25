import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { backendFor, UpstreamError } from '$lib/server/backends';
import { destroyAllSessions } from '$lib/server/auth';
import {
	DEFAULT_SHARE_LIFETIME,
	ShareLimitError,
	createShare,
	describeShares,
	isShareLifetime
} from '$lib/server/shares';
import { log } from '$lib/server/log';
import { config } from '$lib/server/config';

/** The account's own live links, with the songs they point at. */
export const GET: RequestHandler = async ({ locals }) => {
	const session = locals.session;
	if (!session) error(401, 'Not signed in');
	return json({ shares: await describeShares(session) });
};

/**
 * Makes a link to one song.
 *
 * The response is the only place the token ever appears. The body carries a
 * path rather than an absolute URL: the browser already knows the origin it is
 * on, and the server's idea of it can be wrong behind a proxy.
 */
export const POST: RequestHandler = async ({ locals, request }) => {
	const session = locals.session;
	if (!session) error(401, 'Not signed in');
	if (!config().sharing) error(403, 'Sharing is turned off on this server');

	const body = (await request.json().catch(() => null)) as {
		songId?: unknown;
		days?: unknown;
	} | null;
	if (!body || typeof body.songId !== 'string' || body.songId.length === 0 || body.songId.length >= 256) {
		error(400, 'songId is required');
	}
	const days = body.days === undefined ? DEFAULT_SHARE_LIFETIME : body.days;
	if (!isShareLifetime(days)) error(400, 'days must be 1, 7 or 30');

	/*
	 * The song is looked up with the sharer's own credential first. A link is
	 * only ever made to something its owner can play, so an id guessed or
	 * copied from elsewhere does not become a row, and a typo is reported here
	 * rather than to whoever opens the link.
	 */
	try {
		const [song] = await backendFor(session.account.backend).getSongs(session.credential, [body.songId]);
		if (!song) error(404, 'That song is not in your library');
	} catch (err) {
		if (err instanceof UpstreamError) {
			if (err.kind === 'auth') {
				await destroyAllSessions(session.account.id);
				error(401, 'Your music server credentials are no longer valid. Please sign in again.');
			}
			error(err.kind === 'not_found' ? 404 : 502, err.kind === 'not_found' ? 'That song is not in your library' : err.message);
		}
		throw err;
	}

	try {
		const share = await createShare(session.account, body.songId, days);
		// The row id, never the token.
		log.info('share-created', { share: share.id, days });
		return json({ id: share.id, path: `/share/${share.token}`, expiresAt: share.expiresAt });
	} catch (err) {
		if (err instanceof ShareLimitError) error(429, err.message);
		throw err;
	}
};
