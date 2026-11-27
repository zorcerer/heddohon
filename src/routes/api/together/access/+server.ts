import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { ACCESS_MODES, setAccess, togetherEnabled, type PartyAccessMode } from '#lib/server/together.ts';

/**
 * The host sets what the people with the link may do: `listen`, or `add`
 * (members add from their own library, guests look through the host's and add
 * from it). Takes effect at once, for everyone in the party.
 */
export const POST: RequestHandler = async ({ locals, request }) => {
	const session = locals.session;
	if (!session) error(401, 'Not signed in');
	if (!togetherEnabled()) error(404, 'Not found');
	const body = (await request.json().catch(() => null)) as {
		access?: unknown;
	} | null;
	if (!ACCESS_MODES.includes(body?.access as PartyAccessMode)) error(400, 'access is listen or add');
	const party = setAccess(session, body?.access as PartyAccessMode);
	if (!party) error(404, 'This browser hosts no listening session.');
	return json({ party });
};
