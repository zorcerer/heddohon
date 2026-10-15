import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { backendFor } from '$lib/server/backends';
import { reportStatus, startReport } from '$lib/server/libraryreport';

/** Where the account's library report stands. The settings page asks while one is made. */
export const GET: RequestHandler = ({ locals }) => {
	const session = locals.session;
	if (!session) error(401, 'Not signed in');
	return json(reportStatus(session.account.id));
};

/**
 * Starts the library report; see `libraryreport.ts`. For an account the music
 * server lists as an administrator, asked of it on each start, as for the
 * cover fill: a report reads the whole library.
 */
export const POST: RequestHandler = async ({ locals }) => {
	const session = locals.session;
	if (!session) error(401, 'Not signed in');
	if ((await backendFor(session.account.backend).isAdmin(session.credential)) !== true) {
		error(403, 'The music server does not list this account as an administrator.');
	}
	if (!startReport(session.account, session.credential)) error(409, 'A library report is already being made.');
	return json(reportStatus(session.account.id));
};
