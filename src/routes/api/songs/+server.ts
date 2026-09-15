import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { backendFor, UpstreamError } from '$lib/server/backends';

const MAX_IDS = 1000;

/** Resolves song ids to full metadata. Used to rehydrate a persisted queue. */
export const POST: RequestHandler = async ({ locals, request }) => {
	const session = locals.session;
	if (!session) error(401, 'Not signed in');

	const body = (await request.json().catch(() => null)) as { ids?: unknown } | null;
	if (!body || !Array.isArray(body.ids)) error(400, 'ids must be an array');

	const ids = body.ids
		.filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length < 256)
		.slice(0, MAX_IDS);

	if (ids.length === 0) return json({ songs: [] });

	try {
		const songs = await backendFor(session.account.backend).getSongs(session.credential, ids);
		return json({ songs });
	} catch (err) {
		if (err instanceof UpstreamError) error(err.status === 404 ? 404 : 502, err.message);
		throw err;
	}
};
