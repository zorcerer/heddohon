import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { backendFor, UpstreamError } from '$lib/server/backends';
import { lrclibLyrics } from '$lib/server/lrclib';

export const GET: RequestHandler = async ({ locals, params }) => {
	const session = locals.session;
	if (!session) error(401, 'Not signed in');

	const backend = backendFor(session.account.backend);

	try {
		// The lookup needs artist and title too: the older Subsonic endpoint
		// searches by name.
		const [song] = await backend.getSongs(session.credential, [params.id]);
		if (!song) error(404, 'Track not found');

		let lyrics = await backend.getLyrics(session.credential, song);
		// The server's lyrics win when synced. Otherwise LRCLIB is asked, when on:
		// its synced lyrics replace the server's plain ones, and its plain ones
		// only fill a gap.
		if (!lyrics?.synced) {
			const fallback = await lrclibLyrics(song);
			if (fallback && (fallback.synced || !lyrics)) lyrics = fallback;
		}
		return json(
			{ lyrics },
			// Lyrics rarely change, and the dialog is reopened constantly.
			{ headers: { 'cache-control': 'private, max-age=3600' } }
		);
	} catch (err) {
		if (err instanceof UpstreamError) {
			// A server without lyrics support reads as "no lyrics".
			if (err.kind === 'not_found' || err.kind === 'protocol') return json({ lyrics: null });
			error(err.status === 401 ? 401 : 502, err.message);
		}
		throw err;
	}
};
