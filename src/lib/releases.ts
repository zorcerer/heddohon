/**
 * What kind of release an album is, for the artist page, which lists albums,
 * EPs, singles, live records and compilations apart.
 *
 * Where the music server says, that is used: OpenSubsonic's `releaseTypes`,
 * which Navidrome fills from the RELEASETYPE tag in MusicBrainz's words. A
 * record can carry several ("Album" and "Live"). A compilation or a live
 * record is listed as that first, then an EP or a single, and anything else is
 * an album.
 *
 * Where it does not say (untagged files, and Jellyfin), the kind is read from
 * the record's size, by the rule the stores use: up to three tracks under half
 * an hour is a single, four to six under half an hour is an EP. Without a
 * track count and a length it is an album.
 */
import type { Album } from './types';

export type ReleaseKind = 'album' | 'ep' | 'single' | 'live' | 'compilation';

/** The kinds in the order the artist page lists them, with their headings. */
export const RELEASE_GROUPS: ReadonlyArray<{ kind: ReleaseKind; title: string }> = [
	{ kind: 'album', title: 'Albums' },
	{ kind: 'ep', title: 'EPs' },
	{ kind: 'single', title: 'Singles' },
	{ kind: 'live', title: 'Live' },
	{ kind: 'compilation', title: 'Compilations' }
];

const SHORT_SECONDS = 30 * 60;

export function releaseKind(album: Pick<Album, 'releaseTypes' | 'songCount' | 'duration'>): ReleaseKind {
	const types = (album.releaseTypes ?? []).map((type) => type.trim().toLowerCase()).filter(Boolean);
	if (types.length > 0) {
		if (types.includes('compilation')) return 'compilation';
		if (types.includes('live')) return 'live';
		if (types.includes('ep')) return 'ep';
		if (types.includes('single')) return 'single';
		return 'album';
	}
	const { songCount, duration } = album;
	if (!songCount || !duration || duration >= SHORT_SECONDS) return 'album';
	if (songCount <= 3) return 'single';
	if (songCount <= 6) return 'ep';
	return 'album';
}
