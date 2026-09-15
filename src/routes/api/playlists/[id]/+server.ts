import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { backendFor, UpstreamError } from '$lib/server/backends';

const MAX_NAME = 200;

export const PATCH: RequestHandler = async ({ locals, params, request }) => {
	const session = locals.session;
	if (!session) error(401, 'Not signed in');

	const body = (await request.json().catch(() => null)) as { name?: unknown } | null;
	const name = typeof body?.name === 'string' ? body.name.trim() : '';
	if (!name) error(400, 'A playlist name is required');
	if (name.length > MAX_NAME) error(400, `Name must be ${MAX_NAME} characters or fewer`);

	try {
		await backendFor(session.account.backend).renamePlaylist(session.credential, params.id, name);
		return json({ id: params.id, name });
	} catch (err) {
		if (err instanceof UpstreamError) error(err.status === 404 ? 404 : 502, err.message);
		throw err;
	}
};

export const DELETE: RequestHandler = async ({ locals, params }) => {
	const session = locals.session;
	if (!session) error(401, 'Not signed in');
	try {
		await backendFor(session.account.backend).deletePlaylist(session.credential, params.id);
		return json({ id: params.id, deleted: true });
	} catch (err) {
		if (err instanceof UpstreamError) error(err.status === 404 ? 404 : 502, err.message);
		throw err;
	}
};
