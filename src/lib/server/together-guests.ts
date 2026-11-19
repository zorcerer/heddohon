/**
 * Guests of a listen-together party: visitors without an account on the host's
 * music server who join under a name, and, while the host allows it, look
 * through the host's library and add to the queue. `together.ts` keeps who
 * they are; this module has what the routes share.
 *
 * A guest looks through the library as the host's account sees it. That is
 * the host's choice, made in the dialog for this party and taken back with
 * one switch ("Listen only"), which refuses every look-up from then on. Only
 * what the page needs of each track, album and artist is sent: no paths,
 * covers, play counts, ratings or favourites of the host's.
 */
import { error, type Cookies, type RequestEvent } from '@sveltejs/kit';
import { sessionByHandle, type AuthenticatedSession } from './auth';
import { backendFor, UpstreamError } from './backends/index';
import type { Album, Artist, Song } from '#lib/types.ts';
import type { AddRefusal, GuestRefusal } from './together';

const COOKIE = 'hh_together_guest';
/** As long as a party can last; see `PARTY_TTL_MS`. */
const COOKIE_AGE_S = 12 * 60 * 60;

/** The cookie holds the guest's key for this party's pages and nothing else. */
export function guestKey(cookies: Cookies): string | null {
	return cookies.get(COOKIE) ?? null;
}

export function keepGuestKey(event: RequestEvent, token: string, key: string): void {
	event.cookies.set(COOKIE, key, {
		path: `/together/${token}`,
		httpOnly: true,
		sameSite: 'strict',
		secure: event.url.protocol === 'https:',
		maxAge: COOKIE_AGE_S
	});
}

export function refuseGuest(refusal: GuestRefusal | AddRefusal): never {
	if (refusal === 'unknown') error(404, 'This listening session has ended.');
	if (refusal === 'not_guest' || refusal === 'not_member') error(403, 'Join this listening session with a name first.');
	if (refusal === 'closed') error(403, 'The host lets everyone listen, and nothing more.');
	if (refusal === 'limited') error(429, 'Slow down a little and try again.');
	if (refusal === 'member_full') error(429, 'You have 50 tracks waiting in the queue. Add more once some have played.');
	error(429, 'The queue holds 500 added tracks. Add more once some have played.');
}

/** The host's session, for a look-up on its behalf; the party has ended without it. */
export async function hostSession(party: { accountId: string; session: string }): Promise<AuthenticatedSession> {
	const host = await sessionByHandle(party.accountId, party.session);
	if (!host) error(404, 'This listening session has ended.');
	return host;
}

/** Runs a look-up on the host's music server, as a guest's request is answered. */
export async function asHost<T>(host: AuthenticatedSession, ask: (backend: ReturnType<typeof backendFor>) => Promise<T>): Promise<T> {
	try {
		return await ask(backendFor(host.account.backend));
	} catch (err) {
		if (err instanceof UpstreamError && err.kind === 'not_found') error(404, 'Not found');
		if (err instanceof UpstreamError) error(502, 'The music server did not answer.');
		throw err;
	}
}

export interface GuestSong {
	id: string;
	title: string;
	artist: string | null;
	artistId: string | null;
	album: string | null;
	albumId: string | null;
	duration: number;
	track: number | null;
	disc: number | null;
}

export interface GuestAlbum {
	id: string;
	name: string;
	artist: string | null;
	artistId: string | null;
	year: number | null;
	songCount: number | null;
	duration: number | null;
	releaseTypes: string[] | null;
}

export interface GuestArtist {
	id: string;
	name: string;
	albumCount: number | null;
}

export const guestSong = (song: Song): GuestSong => ({
	id: song.id,
	title: song.title,
	artist: song.artist,
	artistId: song.artistId,
	album: song.album,
	albumId: song.albumId,
	duration: song.duration,
	track: song.track,
	disc: song.disc
});

export const guestAlbum = (album: Album): GuestAlbum => ({
	id: album.id,
	name: album.name,
	artist: album.artist,
	artistId: album.artistId,
	year: album.year,
	songCount: album.songCount,
	duration: album.duration,
	releaseTypes: album.releaseTypes ?? null
});

export const guestArtist = (artist: Artist): GuestArtist => ({
	id: artist.id,
	name: artist.name,
	albumCount: artist.albumCount
});
