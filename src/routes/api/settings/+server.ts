import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getSettings, saveSettings } from '$lib/server/settings';

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.session) error(401, 'Not signed in');
	return json(await getSettings(locals.session.account.id));
};

/** Partial update. Unknown or out-of-range fields are dropped by the sanitiser. */
export const PATCH: RequestHandler = async ({ locals, request }) => {
	if (!locals.session) error(401, 'Not signed in');
	const patch = await request.json().catch(() => null);
	if (patch === null) error(400, 'Expected a JSON body');
	return json(await saveSettings(locals.session.account.id, patch));
};
