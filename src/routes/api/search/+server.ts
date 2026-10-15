import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { library } from '$lib/server/library';

const LIMIT = 24;
/** Past any title; the music server is not sent more. */
const MAX_QUERY = 200;

/**
 * What matches a query in the account's own library, for what has no loader
 * of its own: Terminal's command line, and a listen-together member looking
 * for a track to add. The search page searches in its loader.
 */
export const GET: RequestHandler = async (event) => {
	const query = (event.url.searchParams.get('q') ?? '').trim().slice(0, MAX_QUERY);
	if (query.length < 2) return json({ songs: [], albums: [], artists: [] });
	const results = await library(event, ({ backend, credential }) => backend.search(credential, query, LIMIT));
	// The albums and artists too, for Terminal's command line (`commands.ts`).
	return json({ songs: results.songs, albums: results.albums, artists: results.artists });
};
