import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { revokeShare } from '$lib/server/shares';
import { log } from '$lib/server/log';

/**
 * Withdraws one of the caller's own links. Somebody else's id answers exactly
 * as an unknown one does.
 */
export const DELETE: RequestHandler = async ({ locals, params }) => {
	const session = locals.session;
	if (!session) error(401, 'Not signed in');
	if (params.id.length > 64 || !await revokeShare(session.account.id, params.id)) {
		error(404, 'No such link');
	}
	log.info('share-revoked', { share: params.id });
	return json({ id: params.id, revoked: true });
};
