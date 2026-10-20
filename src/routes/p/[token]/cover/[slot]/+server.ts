import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { accountById } from '$lib/server/auth';
import { backendFor } from '$lib/server/backends';
import { accountOfProfileLink, coverOfSlot } from '$lib/server/profilepage';
import { nearestCoverSize, proxySharedMedia, streamRequestFrom } from '$lib/server/proxy';

/**
 * A cover on a profile page reached by its public link, without a sign-in.
 * Read through the owner's stored credential by its place on the page
 * (`coverOfSlot`); the request names no cover.
 */
export const GET: RequestHandler = async (event) => {
	const accountId = await accountOfProfileLink(event.params.token);
	const coverId = accountId ? await coverOfSlot(accountId, event.params.slot) : null;
	const owner = accountId && coverId ? await accountById(accountId) : null;
	if (!owner || !coverId) error(404, 'Not found');
	const size = nearestCoverSize(event.url.searchParams.get('size'));
	const req = streamRequestFrom(event);
	return proxySharedMedia(event, 'cover', () => backendFor(owner.account.backend).openCover(owner.credential, coverId, size, req));
};
