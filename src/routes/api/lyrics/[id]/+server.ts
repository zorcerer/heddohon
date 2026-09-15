import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { backendFor, UpstreamError } from '$lib/server/backends';

export const GET: RequestHandler = async ({ locals, params }) => {
	const session = locals.session;
	if (!session) error(401, 'Not signed in');

	const backend = backendFor(session.account.backend);

	try {
		// The lookup needs artist and title as well as the id, because the older
		// Subsonic endpoint searches by name rather than by track.
		const [song] = await backend.getSongs(session.credential, [params.id]);
		if (!song) error(404, 'Track not found');

		const lyrics = await backend.getLyrics(session.credential, song);
		return json(
			{ lyrics },
			// Lyrics rarely change, and the dialog is reopened constantly.
			{ headers: { 'cache-control': 'private, max-age=3600' } }
		);
	} catch (err) {
		if (err instanceof UpstreamError) {
			// A server with no lyrics support should read as "no lyrics", not as a
			// broken page.
			if (err.kind === 'not_found' || err.kind === 'protocol') return json({ lyrics: null });
			error(err.status === 401 ? 401 : 502, err.message);
		}
		throw err;
	}
};
