import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { UpstreamError } from '#lib/server/backends/index.ts';
import { forgetSharedItems } from '#lib/server/shares.ts';
import { checkRules } from '#lib/smartrules.ts';
import { smartFor } from '#lib/server/smartplaylists.ts';
import { refusedCredential } from '#lib/server/library.ts';

/**
 * Replaces a smart playlist's rules: the body is `{ rules }`, as for a new
 * one. A playlist made by hand is not turned into a smart one (404), and one
 * whose rules a file on the music server defines is refused (409): Navidrome
 * takes the change and imports the file over it at its next scan.
 */
export const PUT: RequestHandler = async ({ locals, params, request }) => {
	const session = locals.session;
	if (!session) error(401, 'Not signed in');
	if (params.id.length === 0 || params.id.length >= 256) error(400, 'id is required');

	const body = (await request.json().catch(() => null)) as { rules?: unknown } | null;
	const smart = smartFor(session);
	if (!smart) error(404, 'This music server has no smart playlists');
	const checked = checkRules(body?.rules, smart.fields);
	if ('error' in checked) error(400, checked.error);

	try {
		const current = await smart.rules(params.id);
		if (!current) error(404, 'That playlist has no rules');
		if (current.fromFile) error(409, 'A file on the music server defines these rules; change them there');
		await smart.setRules(params.id, checked.rules);
		// A link to this playlist serves the new songs on its next request.
		forgetSharedItems(session.account.id);
		return json({ id: params.id, rules: checked.rules });
	} catch (err) {
		if (err instanceof UpstreamError) {
			await refusedCredential(locals, err);
			error(err.kind === 'forbidden' ? 403 : err.status === 404 ? 404 : 502, err.message);
		}
		throw err;
	}
};
