import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { partyFor, REACTIONS, removedFrom, togetherEnabled } from '$lib/server/together';

/**
 * A listen-together link, for anyone who has it. A visitor signed in on the
 * host's music server is told they can join as a member, under the account's
 * name. Anyone else listens.
 */
export const load: PageServerLoad = async ({ params, locals }) => {
	if (togetherEnabled() && removedFrom(params.token, locals.session)) error(403, 'The host removed you from this listening session.');
	const party = togetherEnabled() ? partyFor(params.token, locals.session) : null;
	if (!party) error(404, 'This listening session has ended.');
	return {
		token: params.token,
		state: party.state,
		reactions: [...REACTIONS],
		queue: party.queue,
		queueTotal: party.queueTotal,
		viewer: locals.session ? { name: locals.session.account.username, standing: party.standing } : null
	};
};
