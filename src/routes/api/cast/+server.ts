import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { castPath } from '$lib/server/cast';

/** The saved queue's cap; see `/api/play-state`. */
const MAX_IDS = 1000;

/**
 * Cast addresses for tracks of the queue, asked for when this browser starts
 * casting and again for tracks it reaches later. Signing needs no upstream
 * call: an id the account cannot play gets an address that answers 404.
 */
export const POST: RequestHandler = async ({ locals, request }) => {
	const session = locals.session;
	if (!session) error(401, 'Not signed in');

	const body = (await request.json().catch(() => null)) as { ids?: unknown } | null;
	if (!body || !Array.isArray(body.ids) || body.ids.length === 0 || body.ids.length > MAX_IDS) {
		error(400, `ids must be an array of 1 to ${MAX_IDS}`);
	}
	if (!body.ids.every((id) => typeof id === 'string' && id.length > 0 && id.length < 256)) {
		error(400, 'each id must be 1 to 255 characters');
	}

	const urls: Record<string, string> = {};
	for (const id of body.ids as string[]) urls[id] = castPath(session, id);
	return json({ urls });
};
