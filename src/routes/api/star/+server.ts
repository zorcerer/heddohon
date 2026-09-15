import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { backendFor, UpstreamError } from '$lib/server/backends';
import type { StarKind } from '$lib/types';

const KINDS: StarKind[] = ['song', 'album', 'artist'];

export const POST: RequestHandler = async ({ locals, request }) => {
	const session = locals.session;
	if (!session) error(401, 'Not signed in');

	const body = (await request.json().catch(() => null)) as {
		id?: unknown;
		kind?: unknown;
		starred?: unknown;
	} | null;

	if (!body || typeof body.id !== 'string') error(400, 'id is required');
	if (!KINDS.includes(body.kind as StarKind)) error(400, `kind must be one of ${KINDS.join(', ')}`);
	if (typeof body.starred !== 'boolean') error(400, 'starred must be a boolean');

	try {
		await backendFor(session.account.backend).setStarred(
			session.credential,
			body.id,
			body.kind as StarKind,
			body.starred
		);
		return json({ id: body.id, starred: body.starred });
	} catch (err) {
		if (err instanceof UpstreamError) error(err.status === 404 ? 404 : 502, err.message);
		throw err;
	}
};
