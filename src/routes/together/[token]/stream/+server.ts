import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { sessionByHandle, tiedToSession } from '$lib/server/auth';
import { backendFor } from '$lib/server/backends';
import { proxySharedMedia, streamRequestFrom } from '$lib/server/proxy';
import { partyFor, togetherEnabled } from '$lib/server/together';

/**
 * The track the party is on, through the host's account, for a listener with
 * the link. `?song=` must name that track: it keeps each track's address
 * apart in the browser's cache, and a listener still asking for the last one
 * gets a 404 rather than the wrong audio. The file is sent as it is stored,
 * as a shared link's is, and the stream is cut when the host's session ends.
 */
const handler: RequestHandler = async (event) => {
	const party = togetherEnabled() ? partyFor(event.params.token) : null;
	const songId = event.url.searchParams.get('song');
	if (!party?.state || !songId || songId !== party.state.songId) error(404, 'Not found');
	const host = await sessionByHandle(party.accountId, party.session);
	if (!host) error(404, 'Not found');
	const req = streamRequestFrom(event);
	const response = await proxySharedMedia(event, 'stream', () =>
		backendFor(party.backend).openStream(host.credential, songId, req, null)
	);
	return tiedToSession(host, event.request.signal, response);
};

export const GET = handler;
export const HEAD = handler;
