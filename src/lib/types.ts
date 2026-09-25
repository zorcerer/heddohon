/**
 * The vocabulary the UI speaks. Both the Subsonic and the Jellyfin adapters
 * translate into these shapes, so no component ever branches on backend kind.
 */

export type BackendKind = 'subsonic' | 'jellyfin';

/** What the server knows about the audio itself, used for the quality badge. */
export interface AudioQuality {
	/** Container/codec hint, e.g. `flac`, `mp3`, `opus`. */
	format: string | null;
	/** Average bitrate in kbps as reported upstream. */
	bitrateKbps: number | null;
	/** e.g. 16, 24, 32. Null when the server does not report it. */
	bitDepth: number | null;
	/** e.g. 44100, 96000, 192000. */
	sampleRateHz: number | null;
	channels: number | null;
	/** File size in bytes, when known. */
	sizeBytes: number | null;
	/** True when depth >= 24 or rate > 48 kHz on a lossless codec. */
	highResolution: boolean;
	lossless: boolean;
}

/**
 * Loudness correction the server reports for a file, in dB and as linear
 * peaks. Any field is null when the file or the server does not carry it.
 */
export interface ReplayGain {
	trackGain: number | null;
	albumGain: number | null;
	trackPeak: number | null;
	albumPeak: number | null;
}

export interface Song {
	id: string;
	title: string;
	albumId: string | null;
	album: string | null;
	artistId: string | null;
	artist: string | null;
	albumArtist: string | null;
	/** Seconds. */
	duration: number;
	track: number | null;
	disc: number | null;
	year: number | null;
	genre: string | null;
	coverArt: string | null;
	starred: boolean;
	/** Epoch millis it was starred, where the server reports it (Subsonic does, Jellyfin does not). */
	starredAt: number | null;
	playCount: number | null;
	quality: AudioQuality;
	/** Null when the server reports no loudness data for the file. */
	replayGain: ReplayGain | null;
}

export interface Album {
	id: string;
	name: string;
	artistId: string | null;
	artist: string | null;
	year: number | null;
	genre: string | null;
	songCount: number | null;
	/** Seconds. */
	duration: number | null;
	coverArt: string | null;
	starred: boolean;
	/** Epoch millis it was starred, where the server reports it. */
	starredAt: number | null;
	/** Epoch millis the album was added to the library, when known. */
	createdAt: number | null;
}

export interface AlbumDetail extends Album {
	songs: Song[];
}

export interface Artist {
	id: string;
	name: string;
	albumCount: number | null;
	coverArt: string | null;
	starred: boolean;
	/** Epoch millis it was starred, where the server reports it. */
	starredAt: number | null;
}

export interface ArtistDetail extends Artist {
	albums: Album[];
	biography: string | null;
	topSongs: Song[];
}

/**
 * A genre as the music server names it. `id` is what the server looks albums
 * up by: the name itself on Subsonic, an item id on Jellyfin.
 */
export interface Genre {
	id: string;
	name: string;
	albumCount: number | null;
	songCount: number | null;
}

export interface Playlist {
	id: string;
	name: string;
	comment: string | null;
	songCount: number | null;
	duration: number | null;
	coverArt: string | null;
	owner: string | null;
	isPublic: boolean;
	/** Epoch millis the playlist was created, when the server reports it. */
	createdAt: number | null;
	/** Epoch millis it was last modified. */
	changedAt: number | null;
}

export interface PlaylistDetail extends Playlist {
	songs: Song[];
}

export interface SearchResults {
	albums: Album[];
	artists: Artist[];
	songs: Song[];
}

export type AlbumSort =
	| 'recentlyAdded'
	| 'recentlyPlayed'
	| 'mostPlayed'
	| 'alphabetical'
	| 'byArtist'
	| 'byYear'
	| 'random'
	| 'starred';

/** One line of lyrics. `timeMs` is present only for synced lyrics. */
export interface LyricLine {
	timeMs: number | null;
	text: string;
}

export interface Lyrics {
	/** True when every line carries a timestamp and can follow playback. */
	synced: boolean;
	lines: LyricLine[];
	/** Whatever the server knows about where these came from. */
	artist: string | null;
	title: string | null;
	/** Where the words came from, when not the music server. */
	source?: 'lrclib';
}

export type PlaylistSort = 'recentlyUpdated' | 'recentlyAdded' | 'alphabetical' | 'trackCount' | 'duration';

export interface AlbumQuery {
	sort: AlbumSort;
	limit: number;
	offset: number;
}

/** What every entity type can be favourited as. */
export type StarKind = 'song' | 'album' | 'artist';
