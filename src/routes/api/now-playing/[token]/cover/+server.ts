import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { accountById } from '$lib/server/auth';
import { backendFor } from '$lib/server/backends';
import { accountOfNowPlaying, coverOf } from '$lib/server/nowplaying';
import { nearestCoverSize, proxySharedMedia, streamRequestFrom } from '$lib/server/proxy';

/**
 * The cover of what the link's account is playing, read through its own
 * stored credential, as a shared link's are; 404 while nothing plays. The
 * request names no cover: the id is the one the account's browser reported.
 */
export const GET: RequestHandler = async (event) => {
	const accountId = await accountOfNowPlaying(event.params.token);
	const coverId = accountId ? coverOf(accountId) : null;
	const owner = accountId && coverId ? await accountById(accountId) : null;
	if (!owner || !coverId) error(404, 'Not found');
	const size = nearestCoverSize(event.url.searchParams.get('size'));
	const req = streamRequestFrom(event);
	return proxySharedMedia(event, 'cover', () => backendFor(owner.account.backend).openCover(owner.credential, coverId, size, req));
};
