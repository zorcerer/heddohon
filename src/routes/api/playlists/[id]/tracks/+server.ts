import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { backendFor, UpstreamError } from '$lib/server/backends';

const MAX_SONGS = 1000;

export const POST: RequestHandler = async ({ locals, params, request }) => {
	const session = locals.session;
	if (!session) error(401, 'Not signed in');

	const body = (await request.json().catch(() => null)) as { songIds?: unknown } | null;
	const songIds = Array.isArray(body?.songIds)
		? body.songIds.filter((id): id is string => typeof id === 'string' && id.length > 0).slice(0, MAX_SONGS)
		: [];
	if (songIds.length === 0) error(400, 'songIds must contain at least one track');

	try {
		await backendFor(session.account.backend).addToPlaylist(session.credential, params.id, songIds);
		return json({ id: params.id, added: songIds.length });
	} catch (err) {
		if (err instanceof UpstreamError) error(err.status === 404 ? 404 : 502, err.message);
		throw err;
	}
};

/**
 * Removal is by position, because that is the only identity both music servers
 * agree on — and because the same track can legitimately appear twice in one
 * playlist, so a song id would be ambiguous.
 */
export const DELETE: RequestHandler = async ({ locals, params, request }) => {
	const session = locals.session;
	if (!session) error(401, 'Not signed in');

	const body = (await request.json().catch(() => null)) as { indices?: unknown } | null;
	const indices = Array.isArray(body?.indices)
		? body.indices.filter(
				(index): index is number => typeof index === 'number' && Number.isInteger(index) && index >= 0
			)
		: [];
	if (indices.length === 0) error(400, 'indices must contain at least one position');

	try {
		await backendFor(session.account.backend).removeFromPlaylist(session.credential, params.id, indices);
		return json({ id: params.id, removed: indices.length });
	} catch (err) {
		if (err instanceof UpstreamError) error(err.status === 404 ? 404 : 502, err.message);
		throw err;
	}
};
