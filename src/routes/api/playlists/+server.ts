import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { backendFor, UpstreamError } from '$lib/server/backends';

const MAX_NAME = 200;
const MAX_SONGS = 1000;

/** The caller's playlists, for the "add to playlist" picker. */
export const GET: RequestHandler = async ({ locals }) => {
	const session = locals.session;
	if (!session) error(401, 'Not signed in');
	try {
		const playlists = await backendFor(session.account.backend).getPlaylists(session.credential);
		return json({ playlists });
	} catch (err) {
		if (err instanceof UpstreamError) error(502, err.message);
		throw err;
	}
};

export const POST: RequestHandler = async ({ locals, request }) => {
	const session = locals.session;
	if (!session) error(401, 'Not signed in');

	const body = (await request.json().catch(() => null)) as { name?: unknown; songIds?: unknown } | null;
	const name = typeof body?.name === 'string' ? body.name.trim() : '';
	if (!name) error(400, 'A playlist name is required');
	if (name.length > MAX_NAME) error(400, `Name must be ${MAX_NAME} characters or fewer`);

	const songIds = Array.isArray(body?.songIds)
		? body.songIds
				.filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length < 256)
				.slice(0, MAX_SONGS)
		: [];

	try {
		const id = await backendFor(session.account.backend).createPlaylist(session.credential, name, songIds);
		return json({ id, name, added: songIds.length }, { status: 201 });
	} catch (err) {
		if (err instanceof UpstreamError) error(err.status === 404 ? 404 : 502, err.message);
		throw err;
	}
};
