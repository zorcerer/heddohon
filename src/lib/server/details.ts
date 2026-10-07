/**
 * Album and artist details, remembered per account for one minute.
 *
 * Going back from an album to its artist ran the page's load again, and so did
 * "Play" on a page just loaded (`/api/tracks` reads the album a second time).
 *
 * A detail carries favourite state, so a star made through Heddohon drops
 * every detail held for the account (`/api/star`). A star made in another
 * player, a play count or a library scan can be a minute late.
 *
 * `memo.ts` has how entries are held and shared.
 */
import type { Album, AlbumDetail, ArtistDetail, Folder } from '$lib/types';
import type { LibraryContext } from './library';
import { Memo } from './memo';

const DETAIL_TTL_MS = 60_000;

/**
 * Entries held at once, oldest dropped first. An album of 20 tracks is about
 * 20KB and a large box set a few hundred, so 256 entries are tens of megabytes.
 */
const MAX_DETAILS = 256;

const details = new Memo(DETAIL_TTL_MS, MAX_DETAILS);

export function albumDetail({ backend, credential, accountId }: LibraryContext, id: string): Promise<AlbumDetail> {
	return details.get({ accountId, credential }, `album\u0000${id}`, () => backend.getAlbum(credential, id));
}

export function artistDetail({ backend, credential, accountId }: LibraryContext, id: string): Promise<ArtistDetail> {
	return details.get({ accountId, credential }, `artist\u0000${id}`, () => backend.getArtist(credential, id));
}

/** An artist's albums, without the biography and top songs `artistDetail` reads. */
export function albumsByArtist({ backend, credential, accountId }: LibraryContext, id: string): Promise<Album[]> {
	return details.get({ accountId, credential }, `albums\u0000${id}`, () => backend.getArtistAlbums(credential, id));
}

/** Albums by others that the artist is on, newest first, without the artist's own releases. */
export function appearsOn({ backend, credential, accountId }: LibraryContext, artist: ArtistDetail): Promise<Album[]> {
	return details.get({ accountId, credential }, `appears\u0000${artist.id}`, async () => {
		const own = new Set(artist.albums.map((album) => album.id));
		const albums = await backend.getAppearsOn(credential, artist.id, artist.name);
		return albums.filter((album) => !own.has(album.id)).sort((a, b) => (b.year ?? 0) - (a.year ?? 0));
	});
}

/**
 * A folder and what is in it, the top as `null`. On Subsonic a folder costs a
 * call for each level above it as well as its own.
 */
export function folderDetail({ backend, credential, accountId }: LibraryContext, id: string | null): Promise<Folder> {
	return details.get({ accountId, credential }, `folder\u0000${id ?? ''}`, () => backend.getFolder(credential, id));
}

/** Drops every detail held for an account, after a star or a credential that stopped working. */
export function forgetDetails(accountId: string): void {
	details.forgetAccount(accountId);
}
