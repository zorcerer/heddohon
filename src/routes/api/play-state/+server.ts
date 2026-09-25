import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getPlayState, savePlayState } from '$lib/server/settings';

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.session) error(401, 'Not signed in');
	return json(await getPlayState(locals.session.account.id));
};

export const PUT: RequestHandler = async ({ locals, request }) => {
	if (!locals.session) error(401, 'Not signed in');
	const body = await request.json().catch(() => null);
	if (body === null) error(400, 'Expected a JSON body');
	return json(await savePlayState(locals.session.account.id, body));
};
