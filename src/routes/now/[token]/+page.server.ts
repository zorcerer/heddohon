import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { accountOfNowPlaying, nowPlaying } from '$lib/server/nowplaying';

/** The now-playing overlay, for an OBS browser source; see `nowplaying.ts`. */
export const load: PageServerLoad = async ({ params }) => {
	const accountId = await accountOfNowPlaying(params.token);
	if (!accountId) error(404, 'Not found');
	return { token: params.token, first: nowPlaying(accountId) };
};
