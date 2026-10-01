import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { autoEqEnabled, autoEqProfile } from '$lib/server/autoeq';

/**
 * The correction for one profile, by the id a search returned. An id the
 * index does not list answers 404 and is never asked for upstream.
 */
export const GET: RequestHandler = async ({ locals, url }) => {
	if (!locals.session) error(401, 'Not signed in');
	if (!autoEqEnabled()) error(404, 'Not found');
	const id = url.searchParams.get('id') ?? '';
	if (!id || id.length > 300) error(404, 'Not found');
	const profile = await autoEqProfile(id);
	if (profile === 'unknown') error(404, 'Not found');
	if (profile === 'failed') error(502, 'That correction could not be fetched. Try again later.');
	const { entry, preamp, filters } = profile;
	return json(
		{ id: entry.id, name: entry.name, source: entry.rig ? `${entry.source} on ${entry.rig}` : entry.source, preamp, filters },
		// The browser asks again once a day; see `refreshCorrection` in `processing.svelte.ts`.
		{ headers: { 'cache-control': 'private, max-age=3600' } }
	);
};
