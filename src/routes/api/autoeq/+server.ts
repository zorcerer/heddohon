import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { autoEqEnabled, MAX_QUERY_LENGTH, searchAutoEq } from '$lib/server/autoeq';

/** Headphones in the AutoEq database whose name matches `?q=`. */
export const GET: RequestHandler = async ({ locals, url }) => {
	if (!locals.session) error(401, 'Not signed in');
	if (!autoEqEnabled()) error(404, 'Not found');
	const query = (url.searchParams.get('q') ?? '').trim();
	if (query.length < 2 || query.length > MAX_QUERY_LENGTH) return json({ results: [] });
	const results = await searchAutoEq(query);
	if (!results) error(502, 'The headphone database could not be reached. Try again later.');
	return json({ results });
};
