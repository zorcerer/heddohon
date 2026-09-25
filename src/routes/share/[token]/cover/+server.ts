import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { backendFor } from '$lib/server/backends';
import { nearestCoverSize, proxySharedMedia, streamRequestFrom } from '$lib/server/proxy';
import { shareAccess, sharedSong } from '$lib/server/shares';

/**
 * The shared song's cover, for anyone holding the link.
 *
 * The cover id comes from the song as the sharer's account sees it now, never
 * from the request, so this cannot be pointed at another cover. It bypasses
 * the cover cache: that cache is read and written for signed-in accounts, and
 * an anonymous visitor has no business filling it.
 */
const handler: RequestHandler = async (event) => {
	const access = await shareAccess(event.params.token);
	if (!access) error(404, 'Not found');
	const { share, credential } = access;

	const song = await sharedSong(share, credential);
	const coverId = song?.coverArt;
	if (!coverId) error(404, 'Not found');

	const size = nearestCoverSize(event.url.searchParams.get('size'));
	const req = streamRequestFrom(event);
	return proxySharedMedia(event, 'cover', () =>
		backendFor(share.backend).openCover(credential, coverId, size, req)
	);
};

export const GET = handler;
export const HEAD = handler;
