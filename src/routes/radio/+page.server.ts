import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { library } from '$lib/server/library';
import { radioEnabled, radioStations } from '$lib/server/radio';

/** The music server's internet radio stations. Not there for a server without them, or with `HEDDOHON_RADIO=false`. */
export const load: PageServerLoad = async (event) => {
	const session = event.locals.session;
	if (!session || !radioEnabled(session)) error(404, 'Not found');
	return {
		stations: await library(event, () => radioStations(session))
	};
};
