import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { accountOfProfileLink, pageOf } from '$lib/server/profilepage';

/** A profile page by its public link, for anyone holding it; see `profilepage.ts`. */
export const load: PageServerLoad = async ({ params }) => {
	const accountId = await accountOfProfileLink(params.token);
	const page = accountId ? await pageOf(accountId) : null;
	if (!page) error(404, 'Not found');
	// The handle is the account's name among the accounts here; the public page does not need it.
	return { page: { ...page, handle: '' }, token: params.token };
};
