import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { admitGuest, enqueueGuest, guestsEnabled, withdrawGuest } from '#lib/server/together.ts';
import { asHost, guestKey, hostSession, refuseGuest } from '#lib/server/together-guests.ts';

/**
 * A guest adds a track to the host's queue, while the host lets the party add.
 * The track is looked up as the host's account reads it: a guest adds from
 * the host's library, and everyone's audio comes through the host's account.
 */
export const POST: RequestHandler = async (event) => {
	if (!guestsEnabled()) error(404, 'Not found');
	const body = (await event.request.json().catch(() => null)) as {
		songId?: unknown;
	} | null;
	const songId = body?.songId;
	if (typeof songId !== 'string' || songId.length === 0 || songId.length > 255) error(400, 'songId is required');
	const key = guestKey(event.cookies);
	const party = admitGuest(event.params.token, key);
	if (party === 'limited') error(429, 'One track every 2 seconds.');
	if (typeof party === 'string') refuseGuest(party);
	const host = await hostSession(party);
	const [song] = await asHost(host, (backend) => backend.getSongs(host.credential, [songId]));
	if (!song) error(404, "Not in the host's library");
	const added = enqueueGuest(event.params.token, key, song);
	if (typeof added === 'string') refuseGuest(added);
	return json(added);
};

/** A guest takes back a track they added that has not played yet. */
export const DELETE: RequestHandler = async ({ params, request, cookies }) => {
	if (!guestsEnabled()) error(404, 'Not found');
	const body = (await request.json().catch(() => null)) as {
		entry?: unknown;
	} | null;
	if (!body || typeof body.entry !== 'string' || body.entry.length > 64) error(400, 'entry is required');
	if (!withdrawGuest(params.token, guestKey(cookies), body.entry)) error(404, 'Not a track you added');
	return json({ removed: true });
};
