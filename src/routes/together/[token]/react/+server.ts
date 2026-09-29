import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { react, REACTIONS, togetherEnabled } from '$lib/server/together';

/**
 * A reaction from a listener, relayed to everyone in the party. Only one of
 * the fixed set, only from a listener whose stream is open, and one a second.
 */
export const POST: RequestHandler = async ({ params, request }) => {
	if (!togetherEnabled()) error(404, 'Not found');
	const body = (await request.json().catch(() => null)) as { listener?: unknown; emoji?: unknown } | null;
	if (!body || typeof body.listener !== 'string' || body.listener.length > 64) error(400, 'listener is required');
	if (!REACTIONS.includes(body.emoji as (typeof REACTIONS)[number])) error(400, 'not a reaction this offers');
	const result = react(params.token, body.listener, body.emoji as string);
	if (result === 'unknown') error(404, 'Not listening');
	if (result === 'limited') error(429, 'One reaction a second');
	return json({ sent: true });
};
