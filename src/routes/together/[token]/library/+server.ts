import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import type { AlbumSort, Artist } from '#lib/types.ts';
import { guestBrowse, togetherEnabled } from '#lib/server/together.ts';
import { asHost, guestAlbum, guestArtist, guestKey, guestSong, hostSession, refuseGuest } from '#lib/server/together-guests.ts';

const SEARCH_LIMIT = 30;
const ALBUM_PAGE = 60;
const MAX_QUERY = 200;
/** Album artists only: an artist on a track of someone else's album has no album of their own. */
const albumArtist = (artist: Artist) => artist.albumCount !== 0;
const SORTS: AlbumSort[] = ['recentlyAdded', 'alphabetical', 'byArtist', 'random'];

/**
 * The host's library, for a guest who joined under a name, while the host
 * lets the party add (`together-guests.ts`). One route, by `view`:
 *
 * - `search&q=`: tracks, albums and artists that match
 * - `artists`: every artist
 * - `artist&id=`: one artist's albums
 * - `albums&sort=&offset=`: a page of albums
 * - `album&id=`: one album with its tracks
 * - `genres`: every genre with albums
 * - `genre&id=&offset=`: a page of one genre's albums
 */
export const GET: RequestHandler = async ({ params, url, cookies }) => {
	if (!togetherEnabled()) error(404, 'Not found');
	const party = guestBrowse(params.token, guestKey(cookies));
	if (typeof party === 'string') refuseGuest(party);
	const host = await hostSession(party);
	const cred = host.credential;
	const id = url.searchParams.get('id') ?? '';
	const needId = () => {
		if (id.length === 0 || id.length > 255) error(400, 'id is required');
	};
	const headers = { 'cache-control': 'private, no-store' };

	switch (url.searchParams.get('view')) {
		case 'search': {
			const query = (url.searchParams.get('q') ?? '').trim().slice(0, MAX_QUERY);
			if (query.length < 2) return json({ songs: [], albums: [], artists: [] }, { headers });
			const found = await asHost(host, (backend) => backend.search(cred, query, SEARCH_LIMIT));
			return json(
				{
					songs: found.songs.map(guestSong),
					albums: found.albums.map(guestAlbum),
					artists: found.artists.filter(albumArtist).map(guestArtist)
				},
				{ headers }
			);
		}
		case 'artists': {
			const artists = await asHost(host, (backend) => backend.getArtists(cred));
			return json({ artists: artists.filter(albumArtist).map(guestArtist) }, { headers });
		}
		case 'artist': {
			needId();
			const albums = await asHost(host, (backend) => backend.getArtistAlbums(cred, id));
			return json({ albums: albums.map(guestAlbum) }, { headers });
		}
		case 'albums': {
			const wanted = url.searchParams.get('sort') as AlbumSort;
			const sort = SORTS.includes(wanted) ? wanted : 'recentlyAdded';
			const offset = Math.max(0, Math.min(100_000, Math.floor(Number(url.searchParams.get('offset')) || 0)));
			const albums = await asHost(host, (backend) => backend.getAlbums(cred, { sort, limit: ALBUM_PAGE, offset }));
			return json(
				{
					albums: albums.map(guestAlbum),
					more: albums.length === ALBUM_PAGE
				},
				{ headers }
			);
		}
		case 'album': {
			needId();
			const album = await asHost(host, (backend) => backend.getAlbum(cred, id));
			return json({ album: guestAlbum(album), songs: album.songs.map(guestSong) }, { headers });
		}
		case 'genres': {
			const genres = await asHost(host, (backend) => backend.getGenres(cred));
			return json({ genres: genres.map((genre) => ({ id: genre.id, name: genre.name, albumCount: genre.albumCount })) }, { headers });
		}
		case 'genre': {
			needId();
			const offset = Math.max(0, Math.min(100_000, Math.floor(Number(url.searchParams.get('offset')) || 0)));
			const albums = await asHost(host, (backend) => backend.getGenreAlbums(cred, id, ALBUM_PAGE, offset));
			return json({ albums: albums.map(guestAlbum), more: albums.length === ALBUM_PAGE }, { headers });
		}
		default:
			error(400, 'view is required');
	}
};
