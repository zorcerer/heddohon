/**
 * How sound analysis reaches the library (issue #316, part of #312): through
 * the music server's API, as playback does. Heddohon needs no access to the
 * music folder or the host for it.
 *
 * An `AnalysisSource` does two things and no others: it lists the songs the
 * analysis account can see, and it reads one song's original bytes. It holds
 * the credential it was made with inside itself and hands it to nothing, so
 * what the analysis can do on the music server is what these two methods do.
 * The credential it is made with is the analysis account's, opened in one
 * place (`account.ts`); nothing else builds one.
 *
 * This module imports types only, so `tests/e2e/analysis-decode.test.mjs`
 * runs it against a stand-in for the music server.
 */
import type { MediaBackend, StoredCredential } from '../backends/types';
import type { BackendKind, Song } from '#lib/types.ts';

/** A song as the analysis needs it. The title and artist are for the status and the log, and are not stored. */
export interface AnalysisSong {
	id: string;
	title: string;
	artist: string | null;
	/** Seconds, as the music server reports it. */
	duration: number;
	/** What changes when the file does: its size, format and length. A stored result with another key is stale (`store.ts`). */
	fileKey: string;
}

export interface AnalysisSource {
	readonly backend: BackendKind;
	/**
	 * Every song the analysis account can see. On a Subsonic server other than
	 * Navidrome this can be empty: the listing is `search3` with an empty
	 * query, which the API does not promise answers with everything.
	 */
	songs(): Promise<AnalysisSong[]>;
	/**
	 * The song's file as the music server holds it, never transcoded. The
	 * caller reads the body or cancels it. Rejects where the music server
	 * refuses, as `openStream` does.
	 */
	audio(songId: string, signal?: AbortSignal): Promise<ReadableStream<Uint8Array>>;
}

/** The part of a music server's adapter the analysis uses. */
export type AnalysisBackend = Pick<MediaBackend, 'kind' | 'forEachSong' | 'openStream'>;

export function fileKeyOf(song: Song): string {
	return `${song.quality.sizeBytes ?? '?'}:${song.quality.format ?? '?'}:${Math.round(song.duration)}`;
}

/**
 * A source reading as `credential`. Called by `account.ts` with the analysis
 * account's credential, and by tests with a stand-in.
 */
export function sourceFor(backend: AnalysisBackend, credential: StoredCredential): AnalysisSource {
	return {
		backend: backend.kind,
		async songs() {
			const found: AnalysisSong[] = [];
			await backend.forEachSong(credential, (page) => {
				for (const song of page) {
					// A radio station has no file to measure.
					if (song.live) continue;
					found.push({ id: song.id, title: song.title, artist: song.artist ?? null, duration: song.duration, fileKey: fileKeyOf(song) });
				}
			});
			return found;
		},
		async audio(songId, signal) {
			const response = await backend.openStream(credential, songId, { method: 'GET', signal });
			if (response.status < 200 || response.status >= 300 || !response.body) {
				void response.body?.cancel().catch(() => undefined);
				throw new Error(`The music server answered ${response.status} for the song's audio.`);
			}
			return response.body;
		}
	};
}
