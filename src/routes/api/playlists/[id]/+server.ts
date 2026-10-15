import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { backendFor, UpstreamError } from '$lib/server/backends';
import { forgetSharedItems } from '$lib/server/shares';

const MAX_NAME = 200;

export const PATCH: RequestHandler = async ({ locals, params, request }) => {
	const session = locals.session;
	if (!session) error(401, 'Not signed in');

	// A new name, whether it is public, or both.
	const body = (await request.json().catch(() => null)) as { name?: unknown; public?: unknown } | null;
	const name = typeof body?.name === 'string' ? body.name.trim() : undefined;
	const isPublic = typeof body?.public === 'boolean' ? body.public : undefined;
	if (name === undefined && isPublic === undefined) error(400, 'A playlist name or public is required');
	if (name !== undefined && !name) error(400, 'A playlist name is required');
	if (name !== undefined && name.length > MAX_NAME) error(400, `Name must be ${MAX_NAME} characters or fewer`);

	try {
		const backend = backendFor(session.account.backend);
		if (name !== undefined) await backend.renamePlaylist(session.credential, params.id, name);
		if (isPublic !== undefined) await backend.setPlaylistPublic(session.credential, params.id, isPublic);
		// A link to this playlist serves the edit on its next request.
		forgetSharedItems(session.account.id);
		return json({ id: params.id, ...(name !== undefined ? { name } : {}), ...(isPublic !== undefined ? { public: isPublic } : {}) });
	} catch (err) {
		if (err instanceof UpstreamError) error(err.kind === 'forbidden' ? 403 : err.status === 404 ? 404 : 502, err.message);
		throw err;
	}
};

export const DELETE: RequestHandler = async ({ locals, params }) => {
	const session = locals.session;
	if (!session) error(401, 'Not signed in');
	try {
		await backendFor(session.account.backend).deletePlaylist(session.credential, params.id);
		forgetSharedItems(session.account.id);
		return json({ id: params.id, deleted: true });
	} catch (err) {
		if (err instanceof UpstreamError) error(err.kind === 'forbidden' ? 403 : err.status === 404 ? 404 : 502, err.message);
		throw err;
	}
};
