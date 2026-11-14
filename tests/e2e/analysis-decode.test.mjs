/**
 * Reading a song for sound analysis (issue #316): the source, which lists
 * songs and reads audio and does nothing else, and the decode, which feeds
 * ffmpeg through a pipe and takes an excerpt.
 *
 * The decode tests need an ffmpeg: `HEDDOHON_TEST_FFMPEG`, or the one on the
 * path. CI builds the image's own (`tests/docker/ffmpeg.sh`) and points at
 * it. Without one they skip, saying so; the rest still run. The modules are
 * imported as TypeScript, which Node strips from 22.18 on.
 *
 *   node --test tests/e2e/analysis-decode.test.mjs
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, describe, test } from 'node:test';

const typescript = Boolean(process.features.typescript);
const skip = typescript ? false : `Node ${process.version} does not strip TypeScript types (22.18 and later do)`;
const { decodeExcerpt, excerptStart, DecodeError, ANALYSIS_RATE, EXCERPT_LENGTH } = typescript ? await import('../../src/lib/server/analysis/decode.ts') : {};
const { sourceFor, fileKeyOf } = typescript ? await import('../../src/lib/server/analysis/source.ts') : {};

const ROOT = resolve(import.meta.dirname, '../..');
const ffmpeg = (() => {
	const named = process.env.HEDDOHON_TEST_FFMPEG;
	const candidate = named || 'ffmpeg';
	return spawnSync(candidate, ['-version']).status === 0 ? candidate : null;
})();
const noFfmpeg = ffmpeg ? false : 'no ffmpeg: set HEDDOHON_TEST_FFMPEG, or put one on the path';

const WAV_RATE = 8000;
/** A 16-bit mono WAV: `parts` are `[seconds, hz, amplitude]`, one after another. */
function wav(parts) {
	const total = parts.reduce((sum, [seconds]) => sum + seconds * WAV_RATE, 0);
	const out = Buffer.alloc(44 + total * 2);
	out.write('RIFF', 0);
	out.writeUInt32LE(36 + total * 2, 4);
	out.write('WAVEfmt ', 8);
	out.writeUInt32LE(16, 16);
	out.writeUInt16LE(1, 20);
	out.writeUInt16LE(1, 22);
	out.writeUInt32LE(WAV_RATE, 24);
	out.writeUInt32LE(WAV_RATE * 2, 28);
	out.writeUInt16LE(2, 32);
	out.writeUInt16LE(16, 34);
	out.write('data', 36);
	out.writeUInt32LE(total * 2, 40);
	let at = 0;
	for (const [seconds, hz, amplitude] of parts) {
		for (let i = 0; i < seconds * WAV_RATE; i++, at++) {
			out.writeInt16LE(Math.round(32767 * amplitude * Math.sin((2 * Math.PI * hz * i) / WAV_RATE)), 44 + at * 2);
		}
	}
	return out;
}

/** `bytes` as a stream in 64KB pieces, counting what was read and whether the rest was cancelled. */
function streamOf(bytes) {
	const seen = { read: 0, cancelled: false };
	let at = 0;
	const stream = new ReadableStream({
		pull(controller) {
			if (at >= bytes.length) return controller.close();
			const chunk = bytes.subarray(at, at + 65536);
			at += chunk.length;
			seen.read = at;
			controller.enqueue(new Uint8Array(chunk));
		},
		cancel() {
			seen.cancelled = true;
		}
	});
	return { stream, seen };
}

const rms = (x) => Math.sqrt(x.reduce((sum, v) => sum + v * v, 0) / x.length);

describe('where the excerpt starts', { skip }, () => {
	test('30 seconds in where the song can spare them, the last 90 seconds where it cannot, the start of a short one', () => {
		assert.equal(excerptStart(300), 30);
		assert.equal(excerptStart(120), 30);
		assert.equal(excerptStart(100), 10);
		assert.equal(excerptStart(45), 0);
		assert.equal(excerptStart(null), 30);
		assert.equal(excerptStart(Number.NaN), 30);
	});
});

describe('decoding a song for analysis', { skip: skip || noFfmpeg }, () => {
	const scratch = mkdtempSync(join(tmpdir(), 'hh-decode-'));
	after(() => rmSync(scratch, { recursive: true, force: true }));

	test('takes 90 seconds from 30 seconds in, mono at 22.05kHz', async () => {
		// Quiet for 30 seconds, then louder: the excerpt holds only the louder part.
		const { stream } = streamOf(wav([[30, 440, 0.1], [100, 880, 0.4]]));
		const samples = await decodeExcerpt(stream, { ffmpeg, duration: 130 });
		assert.ok(Math.abs(samples.length - EXCERPT_LENGTH * ANALYSIS_RATE) < ANALYSIS_RATE / 10, `${samples.length} samples`);
		assert.ok(Math.abs(rms(samples) - 0.4 / Math.SQRT2) < 0.01, `rms ${rms(samples)}`);
	});

	test('takes a song shorter than the excerpt whole, from its start', async () => {
		const { stream } = streamOf(wav([[20, 440, 0.2]]));
		const samples = await decodeExcerpt(stream, { ffmpeg, duration: 20 });
		assert.ok(Math.abs(samples.length - 20 * ANALYSIS_RATE) < ANALYSIS_RATE / 10, `${samples.length} samples`);
		assert.ok(Math.abs(rms(samples) - 0.2 / Math.SQRT2) < 0.01);
	});

	test('stops reading the file once it has the excerpt', async () => {
		const bytes = wav([[600, 440, 0.2]]);
		const { stream, seen } = streamOf(bytes);
		await decodeExcerpt(stream, { ffmpeg, duration: 600 });
		assert.equal(seen.cancelled, true, 'the rest of the file was not cancelled');
		assert.ok(seen.read < bytes.length / 2, `${seen.read} of ${bytes.length} bytes were read`);
	});

	for (const name of ['tone.flac', 'tone.mp3']) {
		test(`decodes ${name}`, async () => {
			const { stream } = streamOf(readFileSync(join(ROOT, 'tests/docker/fixtures', name)));
			const samples = await decodeExcerpt(stream, { ffmpeg, duration: 1 });
			assert.ok(samples.length > 21000 && samples.length < 23500, `${samples.length} samples`);
			assert.ok(rms(samples) > 0.04 && rms(samples) < 0.05, `rms ${rms(samples)}`);
		});
	}

	test('says what ffmpeg said of a file that is not audio', async () => {
		const { stream } = streamOf(Buffer.from('this is not a song'.repeat(100)));
		await assert.rejects(decodeExcerpt(stream, { ffmpeg }), (err) => err instanceof DecodeError && err.kind === 'failed' && err.message.length > 0);
	});

	test('stops at once on the caller\'s signal, and reads no further', async () => {
		const { stream, seen } = streamOf(wav([[600, 440, 0.2]]));
		const stopper = new AbortController();
		const pending = decodeExcerpt(stream, { ffmpeg, duration: 600, signal: stopper.signal });
		stopper.abort();
		await assert.rejects(pending, (err) => err instanceof DecodeError && err.kind === 'aborted');
		assert.equal(seen.cancelled, true);
	});

	test('gives ffmpeg its fixed arguments and nothing of the song or the music server', async () => {
		// A stand-in that writes down its arguments and its environment's names.
		const fake = join(scratch, 'fake-ffmpeg');
		const said = join(scratch, 'said');
		writeFileSync(fake, `#!/bin/sh\nprintf '%s\\n' "$@" > "${said}"\nexit 1\n`);
		chmodSync(fake, 0o755);
		const { stream } = streamOf(wav([[1, 440, 0.2]]));
		await assert.rejects(decodeExcerpt(stream, { ffmpeg: fake, duration: 200 }));
		assert.deepEqual(readFileSync(said, 'utf8').trim().split('\n'), [
			'-nostdin', '-v', 'error', '-i', 'pipe:0', '-ss', '30', '-t', '90', '-vn', '-ac', '1', '-ar', '22050', '-f', 'f32le', 'pipe:1'
		]);
	});
});

describe('decoding without ffmpeg', { skip }, () => {
	test('says ffmpeg is missing, and cancels the download', async () => {
		const { stream, seen } = streamOf(wav([[1, 440, 0.2]]));
		await assert.rejects(decodeExcerpt(stream, { ffmpeg: '/nonexistent/ffmpeg' }), (err) => err instanceof DecodeError && err.kind === 'missing');
		assert.equal(seen.cancelled, true);
	});
});

describe('the analysis source', { skip }, () => {
	const quality = (sizeBytes, format) => ({ format, bitrateKbps: null, bitDepth: null, sampleRateHz: null, channels: 2, sizeBytes, highResolution: false, lossless: true });
	const credential = { kind: 'subsonic', username: 'analysis', password: 'a-long-secret' };

	/** A stand-in for a music server's adapter that writes down what it was asked. */
	function backend({ status = 200 } = {}) {
		const asked = [];
		let cancelled = false;
		return {
			asked,
			wasCancelled: () => cancelled,
			kind: 'subsonic',
			async forEachSong(cred, onPage) {
				asked.push(['forEachSong', cred]);
				onPage([
					{ id: 's1', title: 'One', artist: 'A', duration: 180.4, quality: quality(1000, 'flac') },
					{ id: 'radio', title: 'Station', artist: null, duration: 0, quality: quality(null, null), live: true }
				]);
				onPage([{ id: 's2', title: 'Two', artist: null, duration: 61, quality: quality(null, 'mp3') }]);
			},
			async openStream(cred, songId, req, transcode) {
				asked.push(['openStream', cred, songId, req.method, transcode]);
				return {
					status,
					headers: new Headers(),
					body: new ReadableStream({
						start: (controller) => controller.enqueue(new Uint8Array([1, 2, 3])),
						cancel: () => void (cancelled = true)
					})
				};
			}
		};
	}

	test('lists every song with a file, each with what marks its file', async () => {
		const server = backend();
		const songs = await sourceFor(server, credential).songs();
		assert.deepEqual(songs, [
			{ id: 's1', title: 'One', artist: 'A', duration: 180.4, fileKey: '1000:flac:180' },
			{ id: 's2', title: 'Two', artist: null, duration: 61, fileKey: '?:mp3:61' }
		]);
	});

	test('a file of another size, format or length has another key', () => {
		const song = { duration: 180, quality: quality(1000, 'flac') };
		const key = fileKeyOf(song);
		assert.notEqual(fileKeyOf({ ...song, quality: quality(1001, 'flac') }), key);
		assert.notEqual(fileKeyOf({ ...song, quality: quality(1000, 'mp3') }), key);
		assert.notEqual(fileKeyOf({ ...song, duration: 181 }), key);
	});

	test('reads the original file, never a transcode', async () => {
		const server = backend();
		const body = await sourceFor(server, credential).audio('s1');
		assert.deepEqual(server.asked, [['openStream', credential, 's1', 'GET', undefined]]);
		assert.deepEqual([...(await body.getReader().read()).value], [1, 2, 3]);
	});

	test('fails, and lets the answer go, where the music server refuses', async () => {
		const server = backend({ status: 403 });
		await assert.rejects(sourceFor(server, credential).audio('s1'), /answered 403/);
		assert.equal(server.wasCancelled(), true);
	});

	test('is two methods and the server\'s kind: the credential cannot be read back from it', () => {
		const source = sourceFor(backend(), credential);
		assert.deepEqual(Object.keys(source).sort(), ['audio', 'backend', 'songs']);
		assert.equal(JSON.stringify(source).includes('a-long-secret'), false);
	});
});
