import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { accountOfNowPlaying, nowPlaying } from '$lib/server/nowplaying';

/**
 * What the link's account is playing, as JSON, without a sign-in: for Home
 * Assistant's REST sensor or a script. `{ "playing": false }` while nothing
 * plays or it is paused. See `nowplaying.ts`.
 */
export const GET: RequestHandler = async ({ params }) => {
	const accountId = await accountOfNowPlaying(params.token);
	if (!accountId) error(404, 'Not found');
	return json(nowPlaying(accountId), { headers: { 'cache-control': 'no-store' } });
};
