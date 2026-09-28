import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { backendFor, UpstreamError } from '$lib/server/backends';
import { mapLimited } from '$lib/server/backends/http';
import { remembered } from '$lib/server/listings';
import { albumDetail, albumsByArtist } from '$lib/server/details';
import type { LibraryContext } from '$lib/server/library';
import type { MixSeed, Song } from '$lib/types';

type Source = 'album' | 'playlist' | 'artist' | 'genre' | 'starred' | 'random' | 'mix';

const SOURCES: Source[] = ['album', 'playlist', 'artist', 'genre', 'starred', 'random', 'mix'];
const MIX_SEEDS: MixSeed[] = ['song', 'album', 'artist'];

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
		part?: unknown;
		of?: unknown;
	} | null;

	const source = body?.source;
	if (!SOURCES.includes(source as Source)) {
		error(400, `source must be one of ${SOURCES.join(', ')}`);
	}
	const id = typeof body?.id === 'string' && body.id.length < 256 ? body.id : null;
	const needsId = ['album', 'playlist', 'artist', 'genre', 'mix'].includes(source as Source);
	if (needsId && !id) {
		error(400, 'id is required for this source');
	}

	const backend = backendFor(session.account.backend);
	const cred = session.credential;
	// The album and artist reads go through the page caches (`details.ts`), so
	// "Play" on a page that has just loaded does not read the album again.
	const ctx: LibraryContext = { backend, credential: cred, accountId: session.account.id };

	try {
		let songs: Song[];
		// Set when the answer is part of the whole and the caller should ask for the rest.
		let more: boolean | undefined;
		switch (source) {
			case 'album':
				songs = (await albumDetail(ctx, id!)).songs;
				break;
			case 'playlist':
				songs = (await backend.getPlaylist(cred, id!)).songs;
				break;
			case 'artist': {
				// Every album by the artist, in release order, flattened.
				// `getArtistAlbums` rather than `getArtist`: the same album list,
				// without the biography and top songs that `getArtist` fetches
				// alongside it. On Subsonic those are `getArtistInfo2`, which
				// Navidrome answers from Last.fm, and `getTopSongs`, two calls
				// this route never read.
				const artistAlbums = await albumsByArtist(ctx, id!);
				// `part` splits the answer in two, the first album and the rest, so
				// that playing starts after one album lookup rather than after all
				// of them. On Subsonic each is its own call, eight at a time: an
				// artist with 40 albums was five rounds of upstream calls before the
				// first note. `/api/tracks` is asked twice, and the album list is
				// read once for each.
				const part = body?.part === 'first' || body?.part === 'rest' ? body.part : null;
				const chosen =
					part === 'first'
						? artistAlbums.slice(0, 1)
						: part === 'rest'
							? artistAlbums.slice(1)
							: artistAlbums;
				if (part === 'first') more = artistAlbums.length > 1;
				// Bounded: an artist can have hundreds of albums, and this is one
				// upstream call each.
				const albums = await mapLimited(chosen, (album) =>
					albumDetail(ctx, album.id).catch(() => null)
				);
				songs = albums.flatMap((album) => album?.songs ?? []);
				break;
			}
			case 'genre':
				// A sample rather than the whole genre, which on a large library is
				// thousands of tracks: 200 in random order is a long evening.
				songs = await backend.getGenreSongs(cred, id!, 200);
				break;
			case 'mix': {
				// What the mix is made from: a song, an album or an artist.
				const of = body?.of;
				if (!MIX_SEEDS.includes(of as MixSeed)) error(400, `of must be one of ${MIX_SEEDS.join(', ')}`);
				// 100 tracks, about five hours; a genre sample is 200. A mix is
				// ranked by likeness to its seed, so its tail is the least like it.
				songs = await backend.getInstantMix(cred, of as MixSeed, id!, 100);
				break;
			}
			case 'starred':
				songs = (await remembered(session.account.id, 'starred', () => backend.getStarred(cred))).songs;
				break;
			default: {
				const limit = typeof body?.limit === 'number' ? Math.min(200, Math.max(1, body.limit)) : 50;
				songs = await backend.getRandomSongs(cred, limit);
			}
		}
		return json(more === undefined ? { songs } : { songs, more });
	} catch (err) {
		if (err instanceof UpstreamError) error(err.status === 404 ? 404 : 502, err.message);
		throw err;
	}
};
