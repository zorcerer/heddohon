/**
 * The results of sound analysis as the rest of the server reads them: the one
 * `analysis.db`, and a song's volume levelling from its measured loudness
 * (issue #320).
 *
 * Kept apart from `job.ts`, which imports the backends to read the library:
 * the backends import this to level each song they map, and importing the job
 * from there would go round in a circle.
 */
import { join } from 'node:path';
import type { ReplayGain, Song } from '#lib/types.ts';
import { config } from '../config';
import { SoundIndex } from './similar.ts';
import { fileKeyOf } from './source.ts';
import { AnalysisStore } from './store.ts';

let results: AnalysisStore | null = null;

/** `analysis.db` in the data directory, opened on first use. */
export function analysisStore(): AnalysisStore {
	results ??= new AnalysisStore(join(config().dataDir, 'analysis.db'));
	return results;
}

/** Closes `analysis.db`, on shutdown. */
export function closeAnalysisStore(): void {
	results?.close();
}

/** The loudness ReplayGain 2.0 levels to. */
export const TARGET_LUFS = -18;

/**
 * The song with a track gain from its measured loudness, where the music
 * server sent none: tags win, and so does Jellyfin's own measurement. The
 * gain brings it to -18 LUFS, so -10 LUFS is -8 dB.
 *
 * No peak: the one measured is of a 90-second excerpt and not the file, so
 * it cannot promise the rest stays under full scale. Without one the player
 * only ever lowers a song (`#gainFor` in `player.svelte.ts`), and a quiet
 * song plays as it is. No album gain either: the player reads the track
 * gain wherever there is one, so an album gain beside it would not be read.
 *
 * Nothing while the server does not analyse, and nothing for a radio
 * station. The song came from the music server with the asking account's own
 * login, so the account can see it (SECURITY.md, **Sound analysis**).
 */
export function levelled(backend: string, song: Song): Song {
	if (song.replayGain || song.live) return song;
	let loudness: number | null;
	try {
		if (!config().analysis) return song;
		loudness = analysisStore().loudnessOf({ backend, songId: song.id, fileKey: fileKeyOf(song) });
	} catch {
		// A deployment still being set up, or a file that cannot be read: as unmeasured.
		return song;
	}
	if (loudness === null || loudness <= -70) return song;
	const gain: ReplayGain = {
		trackGain: Math.round((TARGET_LUFS - loudness) * 100) / 100,
		albumGain: null,
		trackPeak: null,
		albumPeak: null,
		measured: true
	};
	return { ...song, replayGain: gain };
}

/**
 * How long a sound-alike index is used before it is built again from
 * `analysis.db`, so songs the job measured since join it. Building one of
 * 50,000 songs reads 6.4MB and takes tens of milliseconds.
 */
const INDEX_MS = 5 * 60 * 1000;

const indexes = new Map<string, { index: SoundIndex; builtAt: number }>();

/**
 * The music server's songs by how they sound (issue #321), or null while the
 * server does not analyse or nothing of it is measured.
 */
export function soundIndex(backend: string): SoundIndex | null {
	try {
		if (!config().analysis) return null;
		let held = indexes.get(backend);
		if (!held || Date.now() - held.builtAt > INDEX_MS) {
			const { songIds, vectors } = analysisStore().vectors(backend);
			held = { index: new SoundIndex(songIds, vectors), builtAt: Date.now() };
			indexes.set(backend, held);
		}
		return held.index.size > 0 ? held.index : null;
	} catch {
		// A deployment still being set up, or a file that cannot be read: nothing measured.
		return null;
	}
}

/** Drops the indexes, after the results were removed. */
export function forgetSoundIndexes(): void {
	indexes.clear();
}
