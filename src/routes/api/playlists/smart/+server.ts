import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { backendFor, UpstreamError } from '$lib/server/backends';
import { destroyAllSessions } from '$lib/server/auth';
import { checkRules, toCriteria } from '$lib/smartrules';

const MAX_NAME = 200;

/**
 * Makes a smart playlist on the music server: the body is `{ name, rules }`,
 * the rules in the editor's model (`lib/smartrules.ts`), checked here and
 * sent in the server's format. Navidrome alone keeps them.
 */
export const POST: RequestHandler = async ({ locals, request }) => {
	const session = locals.session;
	if (!session) error(401, 'Not signed in');

	const body = (await request.json().catch(() => null)) as { name?: unknown; rules?: unknown } | null;
	const name = typeof body?.name === 'string' ? body.name.trim() : '';
	if (!name) error(400, 'A playlist name is required');
	if (name.length > MAX_NAME) error(400, `Name must be ${MAX_NAME} characters or fewer`);
	const checked = checkRules(body?.rules);
	if ('error' in checked) error(400, checked.error);

	const smart = backendFor(session.account.backend).smartPlaylists;
	if (!smart) error(404, 'This music server has no smart playlists');
	try {
		const id = await smart.create(session.credential, name, toCriteria(checked.rules));
		return json({ id, name }, { status: 201 });
	} catch (err) {
		if (err instanceof UpstreamError) {
			if (err.kind === 'auth') {
				await destroyAllSessions(session.account.id);
				error(401, 'Your music server credentials are no longer valid. Sign in again.');
			}
			error(err.kind === 'forbidden' ? 403 : err.status === 404 ? 404 : 502, err.message);
		}
		throw err;
	}
};
