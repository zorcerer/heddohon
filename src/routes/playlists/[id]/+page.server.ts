import type { PageServerLoad } from './$types';
import { library } from '$lib/server/library';

export const load: PageServerLoad = async (event) => {
	const playlist = await library(event, ({ backend, credential }) =>
		backend.getPlaylist(credential, event.params.id)
	);
	return { playlist };
};
