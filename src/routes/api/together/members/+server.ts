import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { removeMember, togetherEnabled } from '$lib/server/together';

/** The host removes a member from the party this browser hosts, for the rest of it. */
export const DELETE: RequestHandler = async ({ locals, request }) => {
	const session = locals.session;
	if (!session) error(401, 'Not signed in');
	if (!togetherEnabled()) error(404, 'Not found');
	const body = (await request.json().catch(() => null)) as { member?: unknown } | null;
	if (!body || typeof body.member !== 'string' || body.member.length > 64) error(400, 'member is required');
	if (!removeMember(session, body.member)) error(404, 'Not a member of the party this browser hosts');
	return json({ removed: true });
};
