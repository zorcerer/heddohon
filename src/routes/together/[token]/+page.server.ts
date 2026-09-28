import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { partyFor, REACTIONS, togetherEnabled } from '$lib/server/together';

/** A listen-together link, for anyone who has it. */
export const load: PageServerLoad = async ({ params }) => {
	const party = togetherEnabled() ? partyFor(params.token) : null;
	if (!party) error(404, 'This listening session has ended.');
	return { token: params.token, state: party.state, reactions: [...REACTIONS] };
};
