import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { accountById } from '$lib/server/auth';
import { backendFor } from '$lib/server/backends';
import { accountOfHandle, coverOfSlot } from '$lib/server/profilepage';
import { nearestCoverSize, proxySharedMedia, streamRequestFrom } from '$lib/server/proxy';

/**
 * A cover on a profile page, for an account allowed to see the page: its
 * owner, or anyone signed in here where it is listed. Read through the
 * owner's stored credential, as a shared link's covers are, by its place on
 * the page; see `coverOfSlot`.
 */
export const GET: RequestHandler = async (event) => {
	const session = event.locals.session;
	if (!session) error(401, 'Not signed in');
	const accountId = await accountOfHandle(event.params.handle, session.account.id);
	const coverId = accountId ? await coverOfSlot(accountId, event.params.slot) : null;
	const owner = accountId && coverId ? await accountById(accountId) : null;
	if (!owner || !coverId) error(404, 'Not found');
	const size = nearestCoverSize(event.url.searchParams.get('size'));
	const req = streamRequestFrom(event);
	return proxySharedMedia(event, 'cover', () => backendFor(owner.account.backend).openCover(owner.credential, coverId, size, req));
};
