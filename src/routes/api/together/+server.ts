import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { endParty, hostedBy, joinedBy, startParty, togetherEnabled } from '$lib/server/together';

/** The party this browser hosts, and the one this account has joined as a member, or null for each. */
export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.session) error(401, 'Not signed in');
	if (!togetherEnabled()) error(404, 'Not found');
	return json({ party: hostedBy(locals.session), joined: joinedBy(locals.session) });
};

/** Starts listening together, or returns the party this browser already hosts. */
export const POST: RequestHandler = async ({ locals }) => {
	if (!locals.session) error(401, 'Not signed in');
	if (!togetherEnabled()) error(404, 'Not found');
	const party = startParty(locals.session);
	if (!party) error(503, 'Too many listening sessions are open on this server. Try again later.');
	return json({ party });
};

/** Ends the party this browser hosts; its listeners are told. */
export const DELETE: RequestHandler = async ({ locals }) => {
	if (!locals.session) error(401, 'Not signed in');
	if (!togetherEnabled()) error(404, 'Not found');
	return json({ ended: endParty(locals.session) });
};
