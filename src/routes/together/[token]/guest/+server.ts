import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { guestName, joinAsGuest, togetherEnabled } from '#lib/server/together.ts';
import { guestKey, keepGuestKey } from '#lib/server/together-guests.ts';

/**
 * Joins the party as a guest under a name, from a page whose event stream is
 * open: for a visitor without an account on the host's music server. The name
 * is shown to the host, who can remove the guest, and next to what the guest
 * adds. The guest's key is kept in a cookie for this party's pages, so a
 * reload keeps the name and the additions.
 */
export const POST: RequestHandler = async (event) => {
	if (!togetherEnabled()) error(404, 'Not found');
	const body = (await event.request.json().catch(() => null)) as {
		listener?: unknown;
		name?: unknown;
	} | null;
	if (!body || typeof body.listener !== 'string' || body.listener.length > 64) error(400, 'listener is required');
	const name = guestName(body.name);
	if (!name) error(400, 'A name is required.');
	const joined = joinAsGuest(event.params.token, body.listener, event.locals.session, guestKey(event.cookies), name);
	if (joined === 'unknown') error(404, 'Not listening');
	if (joined === 'refused') error(403, 'You cannot join this listening session as a guest.');
	keepGuestKey(event, event.params.token, joined.key);
	return json({ member: joined.member });
};
