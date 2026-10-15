import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { setupPending } from '$lib/server/setup';

/**
 * The first-run setup page. It exists while the deployment is missing its
 * secret or its music server. Set up, it is behind the session gate like any
 * page, and sends whoever reaches it on: a bookmark of it, or the tab the
 * setup was done in.
 */
export const load: PageServerLoad = ({ locals, url }) => {
	if (setupPending() === null) redirect(303, locals.session ? '/' : '/login');
	// What is missing is told to whoever has the code, and not here.
	return {
		// The address this server believes it is served on. Where the browser's
		// differs, sign-in will be refused until `ORIGIN` says the browser's.
		serverOrigin: url.origin
	};
};
