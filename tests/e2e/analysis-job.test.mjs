/**
 * The sound analysis job (issue #318), run without the app: `queue.ts` given
 * stand-ins for the music server, the decoder and the analysis, the real
 * `analysis.db` store in a temporary directory, and a clock of its own that
 * a rest moves forward at once.
 *
 *   node --test tests/e2e/analysis-job.test.mjs
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, describe, test } from 'node:test';

const typescript = Boolean(process.features.typescript);
const skip = typescript ? false : `Node ${process.version} does not strip TypeScript types (22.18 and later do)`;
const queue = typescript ? await import('../../src/lib/server/analysis/queue.ts') : {};
const { AnalysisStore } = typescript ? await import('../../src/lib/server/analysis/store.ts') : {};
const { FEATURES_VERSION, VECTOR_LENGTH } = typescript ? await import('../../src/lib/server/analysis/features.ts') : {};
const { DecodeError } = typescript ? await import('../../src/lib/server/analysis/decode.ts') : {};

/** How long the stand-in analysis takes, by the job's clock. */
const SONG_MS = 2_000;

const dir = mkdtempSync(join(tmpdir(), 'hh-analysis-job-'));
after(() => rmSync(dir, { recursive: true, force: true }));
let files = 0;

/** A job and everything around it, with what it did written down. */
function harness({ songs = 20, settings = {}, enabled = true, sources = 1 } = {}) {
	const world = {
		now: 1_000_000,
		minute: 12 * 60,
		lastListened: 0,
		enabled,
		settings: { ...queue.DEFAULT_SETTINGS, ...settings },
		listed: 0,
		measured: [],
		rests: [],
		events: [],
		failOn: new Set(),
		decodeError: null,
		/** Songs whose excerpt from 30s in is empty: shorter than the music server says. */
		shortFiles: new Set(),
		decodes: [],
		listError: null,
		library: Array.from({ length: songs }, (_, i) => ({ id: `s${i}`, title: `Song ${i}`, artist: 'A', duration: 200, fileKey: `k${i}` }))
	};
	const store = new AnalysisStore(join(dir, `analysis-${++files}.db`));
	const makeSource = (backend) => ({
		backend,
		async songs() {
			world.listed++;
			if (world.listError) throw new Error(world.listError);
			return world.library.map((song) => ({ ...song }));
		},
		async audio(songId) {
			world.current = songId;
			if (world.failOn.has(songId)) throw new Error(`The music server answered 404 for ${songId}.`);
			return new ReadableStream({ start: (controller) => controller.close() });
		}
	});
	const made = Array.from({ length: sources }, (_, i) => makeSource(i === 0 ? 'subsonic' : 'jellyfin'));
	const deps = {
		enabled: () => world.enabled,
		sources: async () => made,
		store,
		settings: async () => world.settings,
		async decode(audio, options) {
			world.decodes.push(options.fromStart === true);
			if (world.decodeError) throw world.decodeError;
			if (world.current && world.shortFiles.has(world.current) && !options.fromStart) throw new DecodeError('empty', 'The file decoded to no audio.');
			return new Float32Array(16);
		},
		async analyse() {
			world.now += SONG_MS;
			return {
				version: FEATURES_VERSION,
				loudness: -12,
				peak: 0.9,
				tempo: 120,
				tempoConfidence: 3,
				key: { tonic: 0, minor: false },
				keyConfidence: 0.5,
				vector: new Float32Array(VECTOR_LENGTH)
			};
		},
		lastListened: () => world.lastListened,
		now: () => world.now,
		async sleep(ms) {
			world.rests.push(ms);
			world.now += ms;
			// Lets the test look in between steps.
			await new Promise((resolve) => setImmediate(resolve));
		},
		log: (event, fields) => world.events.push([event, fields]),
		minuteOfDay: () => world.minute
	};
	const originalPut = store.put.bind(store);
	store.put = (song, features) => {
		world.measured.push(song.songId);
		originalPut(song, features);
	};
	const job = new queue.AnalysisJob(deps);
	return { world, store, job, deps };
}

/** Runs the job until `done()` holds, at most `steps` rests, and stops it. */
async function runUntil(h, done, steps = 500) {
	h.job.start();
	for (let i = 0; i < steps && !done(); i++) await new Promise((resolve) => setImmediate(resolve));
	await h.job.stop();
}

describe('the analysis job', { skip }, () => {
	test('measures every song once, and not again after a restart', async () => {
		const h = harness();
		await runUntil(h, () => h.job.status().state === 'done');
		assert.equal(h.world.measured.length, 20);
		assert.deepEqual(new Set(h.world.measured).size, 20);
		const status = h.job.status();
		assert.equal(status.measured, 20);
		assert.equal(status.total, 20);
		assert.equal(status.finishInMs, null);

		const restarted = new queue.AnalysisJob({ ...h.deps, store: h.store });
		const before = h.world.measured.length;
		restarted.start();
		for (let i = 0; i < 50 && restarted.status().state !== 'done'; i++) await new Promise((resolve) => setImmediate(resolve));
		await restarted.stop();
		assert.equal(h.world.measured.length, before, 'a song was measured again after the restart');
	});

	test('measures a song again when its file changes', async () => {
		const h = harness({ songs: 3 });
		await runUntil(h, () => h.job.status().state === 'done');
		h.world.library[1].fileKey = 'k1-changed';
		h.job.forget();
		await runUntil(h, () => h.world.measured.length === 4);
		assert.deepEqual(h.world.measured, ['s0', 's1', 's2', 's1']);
	});

	test('rests as long as a song took at the gentle pace, not at all at full, and to every 3 minutes in the background', async () => {
		for (const [pace, rest] of [['gentle', SONG_MS], ['full', 0], ['background', queue.BACKGROUND_EVERY_MS - SONG_MS]]) {
			const h = harness({ songs: 3, settings: { pace } });
			await runUntil(h, () => h.world.measured.length === 3);
			const between = h.world.rests.slice(0, 2);
			// At full pace the first rest is the idle one once all three are done.
			if (pace === 'full') assert.equal(h.world.rests[0], queue.IDLE_MS, `${pace} rested ${h.world.rests[0]} between songs`);
			else assert.deepEqual(between, [rest, rest], `${pace} rested ${between}`);
		}
	});

	test('measures nothing while paused', async () => {
		const h = harness({ settings: { paused: true } });
		await runUntil(h, () => h.world.rests.length >= 5);
		assert.equal(h.world.measured.length, 0);
		assert.equal(h.job.status().state, 'paused');
		assert.equal(h.world.listed, 0, 'it listed the library while paused');
	});

	test('waits while someone listens, and goes on after 60 seconds of quiet', async () => {
		const h = harness({ songs: 2 });
		h.world.lastListened = h.world.now - 10_000;
		h.job.start();
		for (let i = 0; i < 5 && h.job.status().state !== 'throttled'; i++) await new Promise((resolve) => setImmediate(resolve));
		assert.equal(h.job.status().state, 'throttled');
		assert.equal(h.world.measured.length, 0);
		for (let i = 0; i < 50 && h.world.measured.length < 2; i++) await new Promise((resolve) => setImmediate(resolve));
		await h.job.stop();
		assert.equal(h.world.rests[0], 50_000, 'it did not wait for the rest of the 60 seconds');
		assert.equal(h.world.measured.length, 2);
	});

	test('carries on while someone listens when told to', async () => {
		const h = harness({ songs: 2, settings: { whileListening: 'continue' } });
		h.world.lastListened = h.world.now;
		await runUntil(h, () => h.world.measured.length === 2);
		assert.equal(h.world.measured.length, 2);
	});

	test('keeps to its hours, past midnight too', async () => {
		assert.equal(queue.withinHours({ from: 120, to: 420 }, 300), true);
		assert.equal(queue.withinHours({ from: 120, to: 420 }, 600), false);
		assert.equal(queue.withinHours({ from: 1380, to: 360 }, 30), true);
		assert.equal(queue.withinHours({ from: 1380, to: 360 }, 720), false);
		assert.equal(queue.withinHours(null, 720), true);

		const h = harness({ settings: { hours: { from: 120, to: 420 } } });
		await runUntil(h, () => h.world.rests.length >= 3);
		assert.equal(h.job.status().state, 'outside-hours');
		assert.equal(h.world.measured.length, 0);
	});

	test('does nothing with the feature off, and stops within the song under way when it is turned off', async () => {
		const off = harness({ enabled: false });
		await runUntil(off, () => off.world.rests.length >= 3);
		assert.equal(off.job.status().state, 'off');
		assert.equal(off.world.listed, 0);

		const h = harness({ songs: 20 });
		h.job.start();
		for (let i = 0; i < 100 && h.world.measured.length < 3; i++) await new Promise((resolve) => setImmediate(resolve));
		h.world.enabled = false;
		const at = h.world.measured.length;
		for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
		await h.job.stop();
		assert.ok(h.world.measured.length <= at + 1, `${h.world.measured.length - at} songs after it was turned off`);
		assert.equal(h.job.status().state, 'off');
	});

	test('records a song that fails, says why, and goes on to the next', async () => {
		const h = harness({ songs: 3 });
		h.world.failOn.add('s1');
		await runUntil(h, () => h.job.status().state === 'done');
		assert.deepEqual(h.world.measured, ['s0', 's2']);
		const status = h.job.status();
		assert.equal(status.failed, 1);
		assert.equal(status.lastError.title, 'Song 1');
		assert.match(status.lastError.message, /404/);
		assert.match(h.store.errorOf({ backend: 'subsonic', songId: 's1', fileKey: 'k1' }), /404/);
		assert.ok(h.world.events.some(([event]) => event === 'analysis-song-failed'));
	});

	test('reads a song from its start where the excerpt from 30 seconds in is empty', async () => {
		const h = harness({ songs: 2 });
		h.world.shortFiles.add('s1');
		await runUntil(h, () => h.job.status().state === 'done');
		assert.deepEqual(h.world.measured, ['s0', 's1']);
		assert.deepEqual(h.world.decodes, [false, false, true]);
		assert.equal(h.job.status().failed, 0);
	});

	test('stops, and blames no song, when there is no ffmpeg', async () => {
		const h = harness({ songs: 3 });
		h.world.decodeError = new DecodeError('missing', 'No ffmpeg to decode with.');
		await runUntil(h, () => h.job.status().state === 'stopped');
		assert.equal(h.job.status().failed, 0);
		assert.match(h.job.status().lastError.message, /No ffmpeg/);
		assert.equal(h.world.rests.at(-1), queue.RETRY_MS);
	});

	test('stops when the library will not list, and tries again later', async () => {
		const h = harness();
		h.world.listError = 'the music server answered 503';
		await runUntil(h, () => h.job.status().state === 'stopped');
		assert.match(h.job.status().lastError.message, /503/);
		h.world.listError = null;
		await runUntil(h, () => h.job.status().state === 'done');
		assert.equal(h.world.measured.length, 20);
	});

	test('survives a step that throws, says why, and tries again', async () => {
		const h = harness({ songs: 2 });
		let throws = true;
		const settings = h.deps.settings;
		h.deps.settings = async () => {
			if (throws) throw new Error('Heddohon is not set up');
			return settings();
		};
		const job = new queue.AnalysisJob(h.deps);
		job.start();
		for (let i = 0; i < 20 && job.status().state !== 'stopped'; i++) await new Promise((resolve) => setImmediate(resolve));
		assert.equal(job.status().state, 'stopped');
		assert.match(job.status().lastError.message, /not set up/);
		throws = false;
		for (let i = 0; i < 100 && h.world.measured.length < 2; i++) await new Promise((resolve) => setImmediate(resolve));
		await job.stop();
		assert.equal(h.world.measured.length, 2);
	});

	test('says how far it is, the song under way, the pace and the time left', async () => {
		const h = harness({ songs: 10 });
		h.job.start();
		for (let i = 0; i < 200 && h.world.measured.length < 4; i++) await new Promise((resolve) => setImmediate(resolve));
		await h.job.stop();
		const status = h.job.status();
		assert.equal(status.total, 10);
		assert.equal(status.measured, 4);
		assert.equal(status.lastHour, 4);
		// 6 songs left at 4 an hour: 1.5 hours.
		assert.equal(status.finishInMs, 1.5 * 60 * 60 * 1000);
	});

	test('reads each music server with an account, one song at a time', async () => {
		const h = harness({ songs: 2, sources: 2 });
		await runUntil(h, () => h.job.status().state === 'done');
		assert.equal(h.world.measured.length, 4);
		assert.equal(h.job.status().total, 4);
	});
});
