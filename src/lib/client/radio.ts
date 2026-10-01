/**
 * An internet radio station as something the player can hold.
 *
 * The player's queue is a list of songs, so a station stands in it as one:
 * `live`, with its name for a title and no length. The player reads `live`
 * wherever a station differs from a file: its stream comes from
 * `/api/radio/<id>/stream`, it cannot be sought, it is not buffered ahead or
 * crossfaded, nothing about it is reported to the music server, and it is
 * left out of the saved queue.
 */
import type { RadioStation, Song } from '$lib/types';

const PREFIX = 'radio:';

/** Where the element fetches a station from; `server/radio.ts` passes its stream on. */
export function radioStreamUrl(songId: string): string {
	return `/api/radio/${encodeURIComponent(songId.slice(PREFIX.length))}/stream`;
}

/** The queue's id for a station, which no library track has. */
export function radioSongId(station: RadioStation): string {
	return `${PREFIX}${station.id}`;
}

export function stationSong(station: RadioStation): Song {
	return {
		id: radioSongId(station),
		title: station.name,
		albumId: null,
		album: null,
		artistId: null,
		artist: 'Internet radio',
		albumArtist: null,
		duration: 0,
		track: null,
		disc: null,
		year: null,
		genre: null,
		coverArt: null,
		starred: false,
		starredAt: null,
		playCount: null,
		rating: null,
		quality: {
			format: null,
			bitrateKbps: null,
			bitDepth: null,
			sampleRateHz: null,
			channels: null,
			sizeBytes: null,
			highResolution: false,
			lossless: false
		},
		replayGain: null,
		live: true
	};
}
