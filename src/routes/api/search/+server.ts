import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { library } from '$lib/server/library';

const LIMIT = 24;
/** Past any title; the music server is not sent more. */
const MAX_QUERY = 200;

/**
 * Songs matching a query in the account's own library, for a page without a
 * loader to search through: a listen-together member looking for a track to
 * add. The search page searches in its loader.
 */
export const GET: RequestHandler = async (event) => {
	const query = (event.url.searchParams.get('q') ?? '').trim().slice(0, MAX_QUERY);
	if (query.length < 2) return json({ songs: [] });
	const results = await library(event, ({ backend, credential }) => backend.search(credential, query, LIMIT));
	return json({ songs: results.songs });
};
