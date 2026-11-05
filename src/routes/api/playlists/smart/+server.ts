import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { UpstreamError } from '$lib/server/backends';
import { checkRules } from '$lib/smartrules';
import { smartFor } from '$lib/server/smartplaylists';
import { refusedCredential } from '$lib/server/library';

const MAX_NAME = 200;

/**
 * Makes a smart playlist: the body is `{ name, rules }`, the rules in the
 * editor's model (`lib/smartrules.ts`), checked here against the fields this
 * server can answer. Navidrome keeps them itself; on Jellyfin Heddohon does
 * (`smartplaylists.ts`), and the new playlist holds its songs once this answers.
 */
export const POST: RequestHandler = async ({ locals, request }) => {
	const session = locals.session;
	if (!session) error(401, 'Not signed in');

	const body = (await request.json().catch(() => null)) as { name?: unknown; rules?: unknown } | null;
	const name = typeof body?.name === 'string' ? body.name.trim() : '';
	if (!name) error(400, 'A playlist name is required');
	if (name.length > MAX_NAME) error(400, `Name must be ${MAX_NAME} characters or fewer`);
	const smart = smartFor(session);
	if (!smart) error(404, 'This music server has no smart playlists');
	const checked = checkRules(body?.rules, smart.fields);
	if ('error' in checked) error(400, checked.error);

	try {
		const id = await smart.create(name, checked.rules);
		return json({ id, name }, { status: 201 });
	} catch (err) {
		if (err instanceof UpstreamError) {
			await refusedCredential(locals, err);
			error(err.kind === 'forbidden' ? 403 : err.status === 404 ? 404 : 502, err.message);
		}
		throw err;
	}
};
