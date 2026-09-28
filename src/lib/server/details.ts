/**
 * Album and artist details, remembered per account for one minute.
 *
 * Going back from an album to its artist, or from a track list to its album,
 * ran the page's load again, and so did the "Play" button on a page just
 * loaded (`/api/tracks` reads the album a second time). Inside the minute
 * those are answered from memory.
 *
 * A detail carries favourite state for the item and its songs, so a star made
 * through Heddohon drops every detail held for the account (`/api/star`). A
 * star made in another player, a play count or a library scan can be a
 * minute late.
 *
 * `memo.ts` has how entries are held and shared.
 */
import type { Album, AlbumDetail, ArtistDetail } from '$lib/types';
import type { LibraryContext } from './library';
import { Memo } from './memo';

const DETAIL_TTL_MS = 60_000;

/**
 * Entries held at once, oldest dropped first. An album of 20 tracks is in the
 * order of 20KB, and a large box set a few hundred, so 256 entries stays in
 * the tens of megabytes.
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

/** Drops every detail held for an account, after a star or a credential that stopped working. */
export function forgetDetails(accountId: string): void {
	details.forgetAccount(accountId);
}
