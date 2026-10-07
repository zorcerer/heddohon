import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { sessionByHandle } from '$lib/server/auth';
import { backendFor } from '$lib/server/backends';
import { nearestCoverSize, proxySharedMedia, streamRequestFrom } from '$lib/server/proxy';
import { partyFor, togetherEnabled } from '$lib/server/together';

/** The cover of the track the party is on; `?song=` as for the stream. */
const handler: RequestHandler = async (event) => {
	const party = togetherEnabled() ? partyFor(event.params.token, event.locals.session) : null;
	const songId = event.url.searchParams.get('song');
	const coverId = party?.state?.coverArt;
	if (!party?.state || !coverId || songId !== party.state.songId) error(404, 'Not found');
	const host = await sessionByHandle(party.accountId, party.session);
	if (!host) error(404, 'Not found');
	const size = nearestCoverSize(event.url.searchParams.get('size'));
	const req = streamRequestFrom(event);
	return proxySharedMedia(event, 'cover', () => backendFor(party.backend).openCover(host.credential, coverId, size, req));
};

export const GET = handler;
export const HEAD = handler;
