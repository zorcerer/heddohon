import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { sessionByHandle } from '$lib/server/auth';
import { backendFor, UpstreamError } from '$lib/server/backends';
import { library } from '$lib/server/library';
import type { Song } from '$lib/types';
import { admit, enqueue, togetherEnabled, withdraw, type AddRefusal } from '$lib/server/together';

function refuse(refusal: AddRefusal): never {
	if (refusal === 'unknown') error(404, 'This listening session has ended.');
	if (refusal === 'not_member') error(403, 'Join this listening session to add to its queue.');
	if (refusal === 'limited') error(429, 'One track every 2 seconds.');
	if (refusal === 'member_full') error(429, 'You have 50 tracks waiting in the queue. Add more once some have played.');
	error(429, 'The queue holds 500 added tracks. Add more once some have played.');
}

/**
 * A member adds a track to the host's queue.
 *
 * The id is looked up twice. First with the member's own credential: a member
 * adds what their account can read, so an id cannot be used to probe the
 * host's library. Then with the host's: everyone's audio comes through the
 * host's account, so a track it cannot read is refused here and not when its
 * turn comes. The track goes to the host's browser as the host's account
 * reads it.
 */
export const POST: RequestHandler = async (event) => {
	if (!togetherEnabled()) error(404, 'Not found');
	const session = event.locals.session;
	if (!session) error(401, 'Not signed in');
	const body = (await event.request.json().catch(() => null)) as { songId?: unknown } | null;
	const songId = body?.songId;
	if (typeof songId !== 'string' || songId.length === 0 || songId.length > 255) error(400, 'songId is required');

	const party = admit(event.params.token, session);
	if (typeof party === 'string') refuse(party);

	const [own] = await library(event, ({ backend, credential }) => backend.getSongs(credential, [songId]));
	if (!own) error(404, 'Not in your library');

	const host = await sessionByHandle(party.accountId, party.session);
	if (!host) error(404, 'This listening session has ended.');
	let song: Song | undefined;
	try {
		[song] = await backendFor(host.account.backend).getSongs(host.credential, [songId]);
	} catch (err) {
		if (err instanceof UpstreamError && err.kind !== 'not_found') error(502, 'The music server did not answer.');
		if (!(err instanceof UpstreamError)) throw err;
	}
	if (!song) error(404, "Not in the host's library");

	const added = enqueue(event.params.token, session, song);
	if (typeof added === 'string') refuse(added);
	return json(added);
};

/** A member takes back a track they added that has not played yet. */
export const DELETE: RequestHandler = async ({ params, locals, request }) => {
	if (!togetherEnabled()) error(404, 'Not found');
	const session = locals.session;
	if (!session) error(401, 'Not signed in');
	const body = (await request.json().catch(() => null)) as { entry?: unknown } | null;
	if (!body || typeof body.entry !== 'string' || body.entry.length > 64) error(400, 'entry is required');
	if (!withdraw(params.token, session, body.entry)) error(404, 'Not a track you added');
	return json({ removed: true });
};
