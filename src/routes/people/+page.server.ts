import type { PageServerLoad } from './$types';
import { error } from '@sveltejs/kit';
import { listedPages, ownPage, profilesOn } from '$lib/server/profilepage';

/** The profile pages listed to the accounts here, and a way to this account's own. */
export const load: PageServerLoad = async ({ locals }) => {
	if (!profilesOn()) error(404, 'Not found');
	const session = locals.session!;
	const [people, own] = await Promise.all([listedPages(), ownPage(session.account.id)]);
	return { people, ownHandle: own.handle };
};
