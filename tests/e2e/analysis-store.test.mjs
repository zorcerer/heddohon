/**
 * `analysis.db`, where sound analysis keeps what it measured (issue #315):
 * rows written and read back, what makes a row stale, failures, the counts,
 * a reset, and that the table has no column for a title.
 *
 * It imports `src/lib/server/analysis/store.ts` itself, which Node runs with
 * its types stripped from 22.18 on. On an older Node the tests skip.
 *
 *   node --test tests/e2e/analysis-store.test.mjs
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

const typescript = Boolean(process.features.typescript);
const { AnalysisStore } = typescript ? await import('../../src/lib/server/analysis/store.ts') : {};
const { FEATURES_VERSION, VECTOR_LENGTH } = typescript ? await import('../../src/lib/server/analysis/features.ts') : {};
const skip = typescript ? false : `Node ${process.version} does not strip TypeScript types (22.18 and later do)`;

const measured = (seed = 1) => ({
	version: FEATURES_VERSION,
	loudness: -11.5,
	peak: 0.97,
	tempo: 123.4,
	tempoConfidence: 3.2,
	key: { tonic: 2, minor: true },
	keyConfidence: 0.71,
	vector: Float32Array.from({ length: VECTOR_LENGTH }, (_, i) => seed + i / 8)
});

describe('the analysis store', { skip }, () => {
	let dir;
	let file;
	let store;

	before(() => {
		dir = mkdtempSync(join(tmpdir(), 'hh-analysis-'));
		file = join(dir, 'analysis.db');
		store = new AnalysisStore(file);
	});

	after(() => {
		store?.close();
		if (dir) rmSync(dir, { recursive: true, force: true });
	});

	const song = { backend: 'subsonic', songId: 's1a', fileKey: '1000:flac:180' };

	test('makes no file until something is kept', () => {
		assert.equal(existsSync(file), false);
	});

	test('gives back what was measured, value for value', () => {
		store.put(song, measured());
		assert.deepEqual(store.get(song), measured());
		assert.equal(store.settled(song), true);
		assert.equal(store.errorOf(song), null);
	});

	test('keeps a song with no tempo and no key as that', () => {
		const quiet = { backend: 'subsonic', songId: 'quiet', fileKey: 'k' };
		store.put(quiet, { ...measured(2), tempo: null, key: null, keyConfidence: 0 });
		const back = store.get(quiet);
		assert.equal(back.tempo, null);
		assert.equal(back.key, null);
	});

	test('answers nothing for a song whose file has changed, and takes the new measurement', () => {
		const changed = { ...song, fileKey: '2000:flac:180' };
		assert.equal(store.get(changed), null);
		assert.equal(store.settled(changed), false);
		store.put(changed, measured(5));
		assert.deepEqual(store.get(changed), measured(5));
		assert.equal(store.get(song), null, 'the old file still answers');
		store.put(song, measured());
	});

	test('answers nothing for a row an earlier analysis made', () => {
		const old = { backend: 'subsonic', songId: 'old', fileKey: 'k' };
		store.put(old, { ...measured(), version: FEATURES_VERSION - 1 });
		assert.equal(store.get(old), null);
		assert.equal(store.settled(old), false);
	});

	test('one server\'s song id is not another\'s', () => {
		assert.equal(store.get({ ...song, backend: 'jellyfin' }), null);
	});

	test('remembers a failure, bounded, until it is retried', () => {
		const broken = { backend: 'subsonic', songId: 'broken', fileKey: 'k' };
		store.fail(broken, 'x'.repeat(1000));
		assert.equal(store.settled(broken), true, 'a failed song would be tried again at once');
		assert.equal(store.get(broken), null);
		assert.equal(store.errorOf(broken).length, 300);
		assert.deepEqual(store.counts('subsonic'), { measured: 2, failed: 1 });
		assert.equal(store.retryFailed('subsonic'), 1);
		assert.equal(store.settled(broken), false);
		assert.deepEqual(store.counts('subsonic'), { measured: 2, failed: 0 });
	});

	test('a measurement after a failure clears it', () => {
		const flaky = { backend: 'subsonic', songId: 'flaky', fileKey: 'k' };
		store.fail(flaky, 'the music server answered 503');
		store.put(flaky, measured(3));
		assert.equal(store.errorOf(flaky), null);
		assert.deepEqual(store.get(flaky), measured(3));
	});

	test('refuses a vector of the wrong length', () => {
		assert.throws(() => store.put(song, { ...measured(), vector: new Float32Array(3) }), /vector/);
	});

	test('survives being closed and opened again', () => {
		store.close();
		store = new AnalysisStore(file);
		assert.deepEqual(store.get(song), measured());
	});

	test('has no column for a title, an artist or an album', async () => {
		store.close();
		const { default: Database } = await import('better-sqlite3');
		const db = new Database(file, { readonly: true });
		const columns = db.prepare('PRAGMA table_info(song_features)').all().map((column) => column.name);
		db.close();
		store = new AnalysisStore(file);
		assert.deepEqual(columns, [
			'backend', 'song_id', 'file_key', 'version', 'analysed_at', 'loudness', 'peak', 'tempo', 'tempo_confidence',
			'key_tonic', 'key_minor', 'key_confidence', 'vector', 'error'
		]);
	});

	test('a reset removes the file and leaves a working, empty store', () => {
		store.reset();
		assert.equal(existsSync(file), false);
		assert.equal(existsSync(file + '-wal'), false);
		assert.equal(store.get(song), null);
		assert.deepEqual(store.counts('subsonic'), { measured: 0, failed: 0 });
		store.put(song, measured());
		assert.deepEqual(store.get(song), measured());
	});
});
