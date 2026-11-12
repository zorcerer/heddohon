/**
 * Where sound analysis keeps what it measured (issue #315, part of #312):
 * `analysis.db`, a SQLite file of its own in the data directory, whichever
 * database the server runs on.
 *
 * Apart from the main database on purpose. The results can be made again, so
 * they stay out of the backup, which is built in memory and refused past
 * 512MB (`backup.ts`); the job's write a second never waits on a sign-in or a
 * queue being saved, and on PostgreSQL does not cross the network; and
 * starting again is removing one file.
 *
 * It holds numbers keyed by the music server's song ids, and no titles,
 * artists or albums: what exists and what it is called stays the music
 * server's to say. One row a song, shared by every account. What an account
 * is shown from it is checked against that account's own library first
 * (invariant 10).
 *
 * This module takes the file's path and imports nothing of the app's
 * configuration, so `tests/e2e/analysis-store.test.mjs` opens it directly.
 */
import Database from 'better-sqlite3';
import { rmSync } from 'node:fs';
import { FEATURES_VERSION, VECTOR_LENGTH } from './features.ts';
import type { SongFeatures } from './features.ts';

/**
 * Raised when the table's shape changes. The file is disposable, so a file
 * of another version is emptied and analysed again, with no migration.
 */
const SCHEMA_VERSION = 1;

/** The longest error kept for a song that failed. */
const ERROR_MAX = 300;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS song_features (
	backend TEXT NOT NULL,
	song_id TEXT NOT NULL,
	file_key TEXT NOT NULL,
	version INTEGER NOT NULL,
	analysed_at INTEGER NOT NULL,
	loudness REAL,
	peak REAL,
	tempo REAL,
	tempo_confidence REAL,
	key_tonic INTEGER,
	key_minor INTEGER,
	key_confidence REAL,
	vector BLOB,
	error TEXT,
	PRIMARY KEY (backend, song_id)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS info (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
`;

interface Row {
	file_key: string;
	version: number;
	analysed_at: number;
	loudness: number | null;
	peak: number | null;
	tempo: number | null;
	tempo_confidence: number | null;
	key_tonic: number | null;
	key_minor: number | null;
	key_confidence: number | null;
	vector: Buffer | null;
	error: string | null;
}

/** A song as the store knows it: which server's, and which file it was when measured. */
export interface SongRef {
	backend: string;
	songId: string;
	/**
	 * What changes when the file does (`source.ts` builds it from the size,
	 * the format and the length the music server reports). A row measured from
	 * another file is stale.
	 */
	fileKey: string;
}

export class AnalysisStore {
	readonly #file: string;
	#db: Database.Database | null = null;

	constructor(file: string) {
		this.#file = file;
	}

	/** Opened on first use, so a server that never analyses makes no file. */
	#open(): Database.Database {
		if (this.#db) return this.#db;
		const db = new Database(this.#file);
		db.pragma('journal_mode = WAL');
		db.pragma('synchronous = NORMAL');
		db.exec(SCHEMA);
		const version = db.prepare("SELECT value FROM info WHERE key = 'schema'").get() as { value: string } | undefined;
		if (version && Number(version.value) !== SCHEMA_VERSION) db.exec('DELETE FROM song_features');
		db.prepare("INSERT INTO info (key, value) VALUES ('schema', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(String(SCHEMA_VERSION));
		this.#db = db;
		return db;
	}

	/** Keeps what was measured for a song, over anything kept for it before. */
	put(song: SongRef, features: SongFeatures, at = Date.now()): void {
		if (features.vector.length !== VECTOR_LENGTH) throw new Error(`a vector of ${features.vector.length} values, not ${VECTOR_LENGTH}`);
		this.#open()
			.prepare(
				`INSERT INTO song_features (backend, song_id, file_key, version, analysed_at, loudness, peak, tempo, tempo_confidence, key_tonic, key_minor, key_confidence, vector, error)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
				 ON CONFLICT (backend, song_id) DO UPDATE SET
					file_key = excluded.file_key, version = excluded.version, analysed_at = excluded.analysed_at,
					loudness = excluded.loudness, peak = excluded.peak, tempo = excluded.tempo, tempo_confidence = excluded.tempo_confidence,
					key_tonic = excluded.key_tonic, key_minor = excluded.key_minor, key_confidence = excluded.key_confidence,
					vector = excluded.vector, error = NULL`
			)
			.run(
				song.backend,
				song.songId,
				song.fileKey,
				features.version,
				at,
				features.loudness,
				features.peak,
				features.tempo,
				features.tempoConfidence,
				features.key?.tonic ?? null,
				features.key ? Number(features.key.minor) : null,
				features.keyConfidence,
				Buffer.from(features.vector.buffer, features.vector.byteOffset, features.vector.byteLength)
			);
	}

	/**
	 * Records that a song could not be measured, so it is not tried again
	 * until its file changes, the analysis does, or an administrator retries
	 * (`retryFailed`).
	 */
	fail(song: SongRef, error: string, at = Date.now()): void {
		this.#open()
			.prepare(
				`INSERT INTO song_features (backend, song_id, file_key, version, analysed_at, error) VALUES (?, ?, ?, ?, ?, ?)
				 ON CONFLICT (backend, song_id) DO UPDATE SET
					file_key = excluded.file_key, version = excluded.version, analysed_at = excluded.analysed_at, error = excluded.error,
					loudness = NULL, peak = NULL, tempo = NULL, tempo_confidence = NULL, key_tonic = NULL, key_minor = NULL, key_confidence = NULL, vector = NULL`
			)
			.run(song.backend, song.songId, song.fileKey, FEATURES_VERSION, at, error.slice(0, ERROR_MAX));
	}

	#row(song: SongRef): Row | null {
		const row = this.#open().prepare('SELECT * FROM song_features WHERE backend = ? AND song_id = ?').get(song.backend, song.songId) as Row | undefined;
		// From another file, or by an earlier analysis: stale, as if never measured.
		if (!row || row.file_key !== song.fileKey || row.version !== FEATURES_VERSION) return null;
		return row;
	}

	/** Whether the song has a current row, measured or failed: the job skips it. */
	settled(song: SongRef): boolean {
		return this.#row(song) !== null;
	}

	/** What was measured for the song as it is now, or null: never measured, stale, or failed. */
	get(song: SongRef): SongFeatures | null {
		const row = this.#row(song);
		if (!row || row.error !== null || !row.vector) return null;
		// A copy: the blob's buffer is the driver's, and may not start on a 4-byte boundary.
		const vector = new Float32Array(VECTOR_LENGTH);
		new Uint8Array(vector.buffer).set(row.vector.subarray(0, VECTOR_LENGTH * 4));
		return {
			version: row.version,
			loudness: row.loudness ?? -70,
			peak: row.peak ?? 0,
			tempo: row.tempo,
			tempoConfidence: row.tempo_confidence ?? 1,
			key: row.key_tonic === null ? null : { tonic: row.key_tonic, minor: row.key_minor === 1 },
			keyConfidence: row.key_confidence ?? 0,
			vector
		};
	}

	/** The error a song failed with, or null where it did not fail. */
	errorOf(song: SongRef): string | null {
		return this.#row(song)?.error ?? null;
	}

	/** How many songs of a music server are measured by the current analysis, and how many failed. */
	counts(backend: string): { measured: number; failed: number } {
		const row = this.#open()
			.prepare(
				`SELECT COUNT(*) FILTER (WHERE error IS NULL) AS measured, COUNT(*) FILTER (WHERE error IS NOT NULL) AS failed
				 FROM song_features WHERE backend = ? AND version = ?`
			)
			.get(backend, FEATURES_VERSION) as { measured: number; failed: number };
		return row;
	}

	/** Forgets the failures of a music server, so the job tries those songs again. */
	retryFailed(backend: string): number {
		return this.#open().prepare('DELETE FROM song_features WHERE backend = ? AND error IS NOT NULL').run(backend).changes;
	}

	/** Removes the file and everything in it. The next use starts an empty one. */
	reset(): void {
		this.close();
		for (const suffix of ['', '-wal', '-shm']) rmSync(this.#file + suffix, { force: true });
	}

	close(): void {
		this.#db?.close();
		this.#db = null;
	}
}
