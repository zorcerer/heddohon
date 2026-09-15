/**
 * Lyrics fetching and the state behind the lyrics view.
 *
 * Results are memoised per track: the view is opened and closed far more often
 * than a track changes, and a lyric never changes under you mid-song.
 */
import type { Lyrics, Song } from '$lib/types';

const cache = new Map<string, Lyrics | null>();
const MAX_CACHE_ENTRIES = 80;

async function fetchLyrics(songId: string): Promise<Lyrics | null> {
	const cached = cache.get(songId);
	if (cached !== undefined) return cached;

	const response = await fetch(`/api/lyrics/${encodeURIComponent(songId)}`, {
		headers: { accept: 'application/json' }
	});
	if (!response.ok) throw new Error(`Could not load lyrics (${response.status})`);

	const payload = (await response.json()) as { lyrics: Lyrics | null };
	if (cache.size >= MAX_CACHE_ENTRIES) {
		const oldest = cache.keys().next().value;
		if (oldest !== undefined) cache.delete(oldest);
	}
	cache.set(songId, payload.lyrics);
	return payload.lyrics;
}

class LyricsWindow {
	open = $state(false);
	loading = $state(false);
	error = $state<string | null>(null);
	lyrics = $state<Lyrics | null>(null);
	/** The track the loaded lyric belongs to, so a track change refetches. */
	songId = $state<string | null>(null);
	/**
	 * Set while the reader is scrolling the lyrics themselves. Following the
	 * playhead would otherwise drag the view back every few seconds, which makes
	 * it impossible to read ahead or look back at a verse.
	 */
	following = $state(true);

	toggle(song: Song | null) {
		if (this.open) this.close();
		else this.show(song);
	}

	show(song: Song | null) {
		this.open = true;
		this.following = true;
		void this.load(song);
	}

	close() {
		this.open = false;
	}

	async load(song: Song | null) {
		if (!song) {
			this.lyrics = null;
			this.songId = null;
			return;
		}
		if (this.songId === song.id && this.lyrics !== null) return;

		// A new track starts at the top, so resume following whatever the reader
		// was doing on the last one.
		this.following = true;
		this.songId = song.id;
		this.loading = true;
		this.error = null;
		try {
			const result = await fetchLyrics(song.id);
			// A slower request for a track we have since moved past must not
			// overwrite the sheet for the track now playing.
			if (this.songId === song.id) this.lyrics = result;
		} catch (err) {
			if (this.songId === song.id) {
				this.error = err instanceof Error ? err.message : 'Could not load lyrics';
			}
		} finally {
			if (this.songId === song.id) this.loading = false;
		}
	}
}

export const lyricsWindow = new LyricsWindow();

/**
 * The index of the line that should be highlighted at this moment, or -1.
 * Lines are in ascending time order, so this is the last line already reached.
 */
export function activeLineIndex(lyrics: Lyrics | null, positionSeconds: number): number {
	if (!lyrics?.synced) return -1;
	const positionMs = positionSeconds * 1000;
	let active = -1;
	for (let i = 0; i < lyrics.lines.length; i += 1) {
		const time = lyrics.lines[i].timeMs;
		if (time === null || time > positionMs) break;
		active = i;
	}
	return active;
}
