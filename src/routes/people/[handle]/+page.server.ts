import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { accountOfHandle, MAX_BIO, pageOf, pageSettings } from '$lib/server/profilepage';

/** A profile page: the account's own, which it edits here, or another one listed here. */
export const load: PageServerLoad = async ({ locals, params }) => {
	const session = locals.session!;
	const accountId = await accountOfHandle(params.handle, session.account.id);
	const page = accountId ? await pageOf(accountId) : null;
	if (!accountId || !page) error(404, 'Not found');
	const own = accountId === session.account.id;
	return {
		page,
		own,
		settings: own ? await pageSettings(accountId) : null,
		maxBio: MAX_BIO,
		// Album and artist ids lead somewhere only on the viewer's own kind of music server.
		linked: page.backend === session.account.backend
	};
};
