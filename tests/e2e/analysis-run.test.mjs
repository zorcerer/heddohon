/**
 * Sound analysis end to end in the built app (issue #318): with the feature on
 * and an analysis account named, the job lists the mock Navidrome's library
 * as that account, decodes each song with ffmpeg in a child process and
 * measures it in a worker thread, and `analysis.db` ends up with a row for
 * every song.
 *
 * Needs `npm run build` first, and an ffmpeg: `HEDDOHON_TEST_FFMPEG`, or the
 * one on the path. Without one it skips.
 *
 *   node --test tests/e2e/analysis-run.test.mjs
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { Client, startApp } from './harness.mjs';
import { silentWav, startJellyfin, startSubsonic } from './mocks.mjs';

const ffmpeg = process.env.HEDDOHON_TEST_FFMPEG || 'ffmpeg';
const hasFfmpeg = spawnSync(ffmpeg, ['-version']).status === 0;
const skip = hasFfmpeg ? false : 'no ffmpeg: set HEDDOHON_TEST_FFMPEG, or put one on the path';

/** The mock Navidrome's library: two songs for each artist. */
const ARTISTS = 3;
const SONGS = ARTISTS * 2;

describe('sound analysis in the running app', { skip }, () => {
	let subsonic;
	let jellyfin;
	let app;

	before(async () => {
		subsonic = await startSubsonic({ artistCount: ARTISTS });
		subsonic.state.audio = { type: 'audio/wav', body: silentWav(40) };
		jellyfin = await startJellyfin();
		// The app finds ffmpeg on its path, as the image's is.
		const path = ffmpeg.includes('/') ? `${dirname(ffmpeg)}:${process.env.PATH}` : process.env.PATH;
		app = await startApp({ subsonicUrl: subsonic.url, jellyfinUrl: jellyfin.url, env: { HEDDOHON_ANALYSIS: 'true', PATH: path } });
	});

	after(async () => {
		await app?.stop();
		await subsonic?.close();
		await jellyfin?.close();
	});

	test('measures every song in the library once the account is named, reading only as that account', async () => {
		const admin = new Client(app.url);
		assert.equal((await admin.signIn({ username: 'testuser', password: 'testpass', backend: 'subsonic' })).status, 303);
		const saved = await admin.request('/settings?/saveAnalysisAccount', {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', 'x-sveltekit-action': 'true' },
			body: new URLSearchParams({ username: 'analyst', password: 'analyst-pass' }).toString()
		});
		assert.equal((await saved.json()).type, 'success');
		const seenBefore = subsonic.state.seen.length;

		const file = join(app.dataDir, 'analysis.db');
		const { default: Database } = await import('better-sqlite3');
		const rows = () => {
			if (!existsSync(file)) return [];
			const db = new Database(file, { readonly: true });
			try {
				return db.prepare('SELECT song_id, error, loudness, vector FROM song_features').all();
			} catch {
				return [];
			} finally {
				db.close();
			}
		};
		// Naming the account wakes the job; at the gentle pace six songs of
		// silence take a few seconds.
		const deadline = Date.now() + 30_000;
		while (rows().length < SONGS && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 500));
		const found = rows();
		assert.equal(found.length, SONGS, `${found.length} of ${SONGS} songs analysed`);
		assert.deepEqual(found.filter((row) => row.error !== null).map((row) => row.error), [], 'a song failed');
		// The mock's audio is silence: no level, and a vector of 32 floats.
		assert.ok(found.every((row) => row.loudness === -70 && row.vector.length === 32 * 4));
		const asked = new Set(subsonic.state.seen.slice(seenBefore));
		asked.delete(null);
		assert.deepEqual([...asked], ['analyst'], `the music server was asked as ${[...asked].join(', ')}`);
	});

	// Issue #333: what was measured, for the player's Track details.
	test('gives an account what was measured of a song it can see, and nothing of one it cannot', async () => {
		const listener = new Client(app.url);
		await listener.signIn({ username: 'testuser', password: 'testpass', backend: 'subsonic' });
		const { default: Database } = await import('better-sqlite3');
		const db = new Database(join(app.dataDir, 'analysis.db'), { readonly: true });
		const [{ song_id: id }] = db.prepare('SELECT song_id FROM song_features LIMIT 1').all();
		db.close();

		assert.equal((await fetch(`${app.url}/api/sound/${encodeURIComponent(id)}`)).status, 401);
		const answer = await listener.request(`/api/sound/${encodeURIComponent(id)}`);
		assert.equal(answer.status, 200);
		// Silence: no beat, no key, and the floor of the loudness scale.
		assert.deepEqual(await answer.json(), { sound: { tempo: null, key: null, loudness: -70 } });
		assert.equal((await listener.request('/api/sound/no-such-song')).status, 404);
		assert.equal((await listener.request(`/api/sound/${'x'.repeat(256)}`)).status, 404);
	});
});
