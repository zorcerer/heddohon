import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { backendFor, UpstreamError } from '$lib/server/backends';
import type { Song } from '$lib/types';

type Source = 'album' | 'playlist' | 'artist' | 'starred' | 'random';

const SOURCES: Source[] = ['album', 'playlist', 'artist', 'starred', 'random'];

/**
 * Resolves a container to its tracks in play order, so "play this album" is one
 * request rather than a page navigation. Kept separate from the page loaders
 * because it is called from click handlers, not from render.
 */
export const POST: RequestHandler = async ({ locals, request }) => {
	const session = locals.session;
	if (!session) error(401, 'Not signed in');

	const body = (await request.json().catch(() => null)) as {
		source?: unknown;
		id?: unknown;
		limit?: unknown;
	} | null;

	const source = body?.source;
	if (!SOURCES.includes(source as Source)) {
		error(400, `source must be one of ${SOURCES.join(', ')}`);
	}
	const id = typeof body?.id === 'string' ? body.id : null;
	if ((source === 'album' || source === 'playlist' || source === 'artist') && !id) {
		error(400, 'id is required for this source');
	}

	const backend = backendFor(session.account.backend);
	const cred = session.credential;

	try {
		let songs: Song[];
		switch (source) {
			case 'album':
				songs = (await backend.getAlbum(cred, id!)).songs;
				break;
			case 'playlist':
				songs = (await backend.getPlaylist(cred, id!)).songs;
				break;
			case 'artist': {
				// Every album by the artist, in release order, flattened.
				const artist = await backend.getArtist(cred, id!);
				const albums = await Promise.all(
					artist.albums.map((album) => backend.getAlbum(cred, album.id).catch(() => null))
				);
				songs = albums.flatMap((album) => album?.songs ?? []);
				break;
			}
			case 'starred':
				songs = (await backend.getStarred(cred)).songs;
				break;
			default: {
				const limit = typeof body?.limit === 'number' ? Math.min(200, Math.max(1, body.limit)) : 50;
				songs = await backend.getRandomSongs(cred, limit);
			}
		}
		return json({ songs });
	} catch (err) {
		if (err instanceof UpstreamError) error(err.status === 404 ? 404 : 502, err.message);
		throw err;
	}
};
