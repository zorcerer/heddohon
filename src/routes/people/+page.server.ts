import type { PageServerLoad } from './$types';
import { listedPages, ownPage } from '$lib/server/profilepage';

/** The profile pages listed to the accounts here, and a way to this account's own. */
export const load: PageServerLoad = async ({ locals }) => {
	const session = locals.session!;
	const [people, own] = await Promise.all([listedPages(), ownPage(session.account.id)]);
	return { people, ownHandle: own.handle };
};
