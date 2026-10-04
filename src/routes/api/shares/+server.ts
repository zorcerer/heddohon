import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { backendFor, UpstreamError } from '$lib/server/backends';
import { destroyAllSessions } from '$lib/server/auth';
import {
	DEFAULT_SHARE_LIFETIME,
	ShareLimitError,
	createShare,
	describeShares,
	isShareKind,
	isShareLifetime,
	ownsPlaylist
} from '$lib/server/shares';
import { log } from '$lib/server/log';
import { config } from '$lib/server/config';

/** The account's own live links, with what they point at. */
export const GET: RequestHandler = async ({ locals }) => {
	const session = locals.session;
	if (!session) error(401, 'Not signed in');
	return json({ shares: await describeShares(session) });
};

/**
 * Makes a link to a song, an album or a playlist.
 *
 * The body is `{ kind, id, days }`. `{ songId, days }`, from before albums and
 * playlists could be shared, still makes a song link. The response is the only
 * place the token appears. It carries a path, not an absolute URL: the
 * server's idea of the origin can be wrong behind a proxy.
 */
export const POST: RequestHandler = async ({ locals, request }) => {
	const session = locals.session;
	if (!session) error(401, 'Not signed in');
	if (!config().sharing) error(403, 'Sharing is turned off on this server');

	const body = (await request.json().catch(() => null)) as {
		kind?: unknown;
		id?: unknown;
		songId?: unknown;
		days?: unknown;
	} | null;
	const kind = body?.kind === undefined ? 'song' : body.kind;
	if (!isShareKind(kind)) error(400, 'kind must be song, album or playlist');
	const id = body?.id ?? body?.songId;
	if (typeof id !== 'string' || id.length === 0 || id.length >= 256) error(400, 'id is required');
	const days = body?.days === undefined ? DEFAULT_SHARE_LIFETIME : body.days;
	if (!isShareLifetime(days)) error(400, 'days must be 1, 7 or 30');

	// The item is looked up with the sharer's own credential first. A link is
	// made only to something its owner can play, so a guessed or copied id does
	// not become a row, and a typo is reported here and not to whoever opens
	// the link.
	const missing = `That ${kind} is not in your library`;
	try {
		const backend = backendFor(session.account.backend);
		if (kind === 'album') await backend.getAlbum(session.credential, id);
		else if (kind === 'playlist') {
			const playlist = await backend.getPlaylist(session.credential, id);
			if (!ownsPlaylist(playlist, session.account.username)) error(403, 'Only your own playlists can be shared');
		}
		else if (!(await backend.getSongs(session.credential, [id]))[0]) error(404, missing);
	} catch (err) {
		if (err instanceof UpstreamError) {
			if (err.kind === 'auth') {
				await destroyAllSessions(session.account.id);
				error(401, 'Your music server credentials are no longer valid. Please sign in again.');
			}
			error(err.kind === 'not_found' ? 404 : 502, err.kind === 'not_found' ? missing : err.message);
		}
		throw err;
	}

	try {
		const share = await createShare(session.account, kind, id, days);
		// The row id, never the token.
		log.info('share-created', { share: share.id, kind, days });
		return json({ id: share.id, path: `/share/${share.token}`, expiresAt: share.expiresAt });
	} catch (err) {
		if (err instanceof ShareLimitError) error(429, err.message);
		throw err;
	}
};
