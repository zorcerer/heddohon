/**
 * Playlists in and out of Heddohon as files.
 *
 * Out: a playlist as M3U, naming each entry by its file where the music
 * server gives one or by its artist and title, or as CSV.
 *
 * In: the browser reads the file (`client/playlistfile.ts`: M3U, CSV and
 * tab-separated text, Spotify's JSON, Apple Music's XML) into a list of
 * tracks, and each is looked for here in the library through the account's
 * own credential (`matchTracks`). What comes back is a report; the playlist
 * is made afterwards through `/api/playlists` like any other.
 */
import type { MediaBackend, StoredCredential } from './backends';
import { mapLimited } from './backends/http';
import { csvLine } from './csv';
import type { PlaylistDetail, Song } from '$lib/types';

export const PLAYLIST_EXPORT_FORMATS = ['m3u', 'm3u-titles', 'csv'] as const;
export type PlaylistExportFormat = (typeof PLAYLIST_EXPORT_FORMATS)[number];

/** A line of an M3U file: nothing in it may start another line. */
function oneLine(text: string): string {
	return text.replace(/[\r\n]+/g, ' ');
}

function named(song: Song): string {
	return oneLine(song.artist ? `${song.artist} - ${song.title}` : song.title);
}

/**
 * The playlist as a file. `paths` holds each entry's file for `m3u`, where an
 * entry without one is named by artist and title as in `m3u-titles`.
 */
export function playlistFile(playlist: PlaylistDetail, format: PlaylistExportFormat, paths: (string | null)[] = []): string {
	if (format === 'csv') {
		return (
			csvLine(['title', 'artist', 'album', 'album_artist', 'duration_seconds', 'year', 'song_id']) +
			playlist.songs
				.map((song) =>
					csvLine([song.title, song.artist, song.album, song.albumArtist, Math.round(song.duration), song.year, song.id])
				)
				.join('')
		);
	}
	const lines = ['#EXTM3U', `#PLAYLIST:${oneLine(playlist.name)}`];
	playlist.songs.forEach((song, index) => {
		lines.push(`#EXTINF:${Math.round(song.duration) || -1},${named(song)}`);
		const path = format === 'm3u' ? paths[index] : null;
		lines.push(path ? oneLine(path) : named(song));
	});
	return `${lines.join('\n')}\n`;
}

/* ── Matching ──────────────────────────────────────────────────────────── */

/** A track read from an imported file. */
export interface WantedTrack {
	title: string;
	artist: string | null;
	album: string | null;
	/** Seconds. */
	duration: number | null;
}

/**
 * `exact`: the title, the artist (where the file names one) and the length
 * (where both have one, within 3 seconds) agree. `loose`: the title agrees
 * once what is in brackets, a "feat." and a "- Remastered" are left out, and
 * the artist or a length within 10 seconds agrees. `none`: nothing found.
 */
export type MatchQuality = 'exact' | 'loose' | 'none';

export interface TrackMatch {
	song: Song | null;
	quality: MatchQuality;
}

/** Tracks one import may ask for; a playlist write takes 1000 songs. */
export const MAX_IMPORT_TRACKS = 1000;
/** Songs read for each search. */
const CANDIDATES = 20;

/** Lower case, accents and punctuation gone, "&" read as "and". */
export function fold(text: string): string {
	return text
		.normalize('NFKD')
		.replace(/[̀-ͯ]/g, '')
		.toLowerCase()
		.replace(/&/g, ' and ')
		.replace(/[^\p{L}\p{N}]+/gu, ' ')
		.trim();
}

/** A title without what versions of one song differ by: brackets, a "feat.", a " - Remastered 2011". */
function bare(title: string): string {
	return title
		.replace(/\s*[([][^)\]]*[)\]]/g, '')
		.replace(/\s+(?:feat\.?|ft\.?|featuring)\s.*$/i, '')
		.replace(/\s+-\s+.*$/, '')
		.trim();
}

/** The names an imported artist field holds: "A, B & C feat. D" is four. */
function artistNames(artist: string): string[] {
	return artist
		.split(/\s*(?:,|;|&|\/|\bfeat\.?|\bft\.?|\bfeaturing\b|\band\b|\bx\b)\s*/i)
		.map(fold)
		.filter((name) => name.length > 0);
}

function sameArtist(wanted: string, song: Song): boolean {
	const theirs = [song.artist, song.albumArtist].filter((name): name is string => Boolean(name)).map(fold);
	const whole = fold(wanted);
	if (theirs.some((name) => name === whole || name.includes(whole) || (name.length >= 3 && whole.includes(name)))) return true;
	const names = artistNames(wanted);
	return names.length > 0 && theirs.some((name) => names.some((one) => one.length >= 2 && (name === one || name.includes(one))));
}

/** How `song` answers `wanted`, and a rank to choose between two of one quality (lower is better). */
function grade(wanted: WantedTrack, song: Song): { quality: MatchQuality; rank: number } {
	const off = wanted.duration && song.duration > 0 ? Math.abs(wanted.duration - song.duration) : null;
	const artist = wanted.artist ? sameArtist(wanted.artist, song) : null;
	const album = wanted.album && song.album ? fold(wanted.album) === fold(song.album) : false;
	const rank = (album ? 0 : 100) + (off ?? 50);
	const title = fold(wanted.title) === fold(song.title);
	if (title && artist !== false && (off === null || off <= 3) && (artist || off !== null)) return { quality: 'exact', rank };
	const near = title || (fold(bare(wanted.title)) !== '' && fold(bare(wanted.title)) === fold(bare(song.title)));
	if (near && (artist === true || (off !== null && off <= 10))) return { quality: 'loose', rank };
	return { quality: 'none', rank };
}

function best(wanted: WantedTrack, songs: Song[]): TrackMatch {
	let found: { song: Song; quality: MatchQuality; rank: number } | null = null;
	for (const song of songs) {
		if (song.live) continue;
		const { quality, rank } = grade(wanted, song);
		if (quality === 'none') continue;
		const better =
			!found || (quality === 'exact' && found.quality === 'loose') || (quality === found.quality && rank < found.rank);
		if (better) found = { song, quality, rank };
	}
	return found ? { song: found.song, quality: found.quality } : { song: null, quality: 'none' };
}

/**
 * Looks for each track in the library, 8 at a time: by its title without
 * brackets first, and where that finds no exact match and the file names an
 * artist, by the artist and the title (which Navidrome matches word by word;
 * Jellyfin matches the title alone and finds nothing more).
 */
export async function matchTracks(
	backend: MediaBackend,
	cred: StoredCredential,
	tracks: WantedTrack[],
	signal?: AbortSignal
): Promise<TrackMatch[]> {
	return mapLimited(
		tracks,
		async (wanted) => {
			const query = bare(wanted.title) || wanted.title;
			let match = best(wanted, await backend.searchSongs(cred, query, CANDIDATES));
			if (match.quality !== 'exact' && wanted.artist) {
				const again = best(wanted, await backend.searchSongs(cred, `${wanted.artist} ${query}`, CANDIDATES));
				if (again.quality === 'exact' || (again.quality === 'loose' && match.quality === 'none')) match = again;
			}
			return match;
		},
		undefined,
		signal
	);
}
