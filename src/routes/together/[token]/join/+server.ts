import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { join, togetherEnabled } from '$lib/server/together';

/**
 * Joins the party as a member, from a page whose event stream is open: the
 * account is shown to the host by name and may add to the queue. For an
 * account signed in on the host's music server that the host has not removed.
 */
export const POST: RequestHandler = async ({ params, locals, request }) => {
	if (!togetherEnabled()) error(404, 'Not found');
	const session = locals.session;
	if (!session) error(401, 'Not signed in');
	const body = (await request.json().catch(() => null)) as { listener?: unknown } | null;
	if (!body || typeof body.listener !== 'string' || body.listener.length > 64) error(400, 'listener is required');
	const member = join(params.token, body.listener, session);
	if (member === 'unknown') error(404, 'Not listening');
	if (member === 'refused') error(403, 'This account cannot add to this listening session.');
	return json({ member });
};
