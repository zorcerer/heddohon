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
import { silentWav, startJellyfin, startSubsonic, toneWav } from './mocks.mjs';

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

	// Issue #330: one album now, from its menu.
	test('an administrator has an album measured again now, once at a time; anyone else is not offered it', async () => {
		const admin = new Client(app.url);
		await admin.signIn({ username: 'testuser', password: 'testpass', backend: 'subsonic' });
		const { default: Database } = await import('better-sqlite3');
		const measuredAt = () => {
			const db = new Database(join(app.dataDir, 'analysis.db'), { readonly: true });
			try {
				return Object.fromEntries(db.prepare("SELECT song_id, analysed_at FROM song_features WHERE song_id IN ('s1a', 's1b')").all().map((row) => [row.song_id, row.analysed_at]));
			} finally {
				db.close();
			}
		};
		const before = measuredAt();
		assert.equal(Object.keys(before).length, 2, 'the album was not measured by the library walk');

		const offer = await (await admin.request('/api/analysis/album/al1')).json();
		assert.deepEqual(offer, { offered: true, measured: 2, total: 2, waiting: false });

		const asked = await admin.request('/api/analysis/album/al1', { method: 'POST' });
		assert.equal(asked.status, 202);
		assert.equal((await admin.request('/api/analysis/album/al2', { method: 'POST' })).status, 409, 'a second album was taken while one waits');
		// Measured again, though the results were current.
		const deadline = Date.now() + 15_000;
		while (Date.now() < deadline) {
			const now = measuredAt();
			if (now.s1a > before.s1a && now.s1b > before.s1b) break;
			await new Promise((resolve) => setTimeout(resolve, 200));
		}
		const after = measuredAt();
		assert.ok(after.s1a > before.s1a && after.s1b > before.s1b, 'the album was not measured again');
		assert.equal((await (await admin.request('/api/analysis/album/al1')).json()).waiting, false);

		// An account the music server does not list as an administrator.
		subsonic.state.admin = false;
		try {
			assert.deepEqual(await (await admin.request('/api/analysis/album/al1')).json(), { offered: false });
			assert.equal((await admin.request('/api/analysis/album/al1', { method: 'POST' })).status, 403);
		} finally {
			subsonic.state.admin = true;
		}
		assert.equal((await fetch(`${app.url}/api/analysis/album/al1`)).status, 401);
		assert.equal((await admin.request('/api/analysis/album/no-such-album', { method: 'POST' })).status, 404);
	});

	// Issue #320: volume levelling from the measured loudness, where the tags give none.
	test('a song without ReplayGain is levelled from its measured loudness; tags and silence are left alone', async () => {
		const admin = new Client(app.url);
		await admin.signIn({ username: 'testuser', password: 'testpass', backend: 'subsonic' });
		const { default: Database } = await import('better-sqlite3');
		const loudness = (id) => {
			const db = new Database(join(app.dataDir, 'analysis.db'), { readonly: true });
			try {
				return db.prepare('SELECT loudness, analysed_at FROM song_features WHERE song_id = ?').get(id);
			} finally {
				db.close();
			}
		};
		// Album 2 measured again as a tone, so it has a level. Waits until nothing
		// of this account's is queued, before and after: the album the test above
		// asked for may still be under way, and a fixed 15s ran out on a loaded
		// machine on 2026-11-20, before the tone was measured.
		const settled = async () => {
			const deadline = Date.now() + 60_000;
			while ((await (await admin.request('/api/analysis/album/al2')).json()).waiting && Date.now() < deadline) {
				await new Promise((resolve) => setTimeout(resolve, 200));
			}
		};
		await settled();
		const before = loudness('s2a').analysed_at;
		subsonic.state.audio = { type: 'audio/wav', body: toneWav(40, 0.5) };
		try {
			assert.equal((await admin.request('/api/analysis/album/al2', { method: 'POST' })).status, 202);
			await settled();
		} finally {
			subsonic.state.audio = { type: 'audio/wav', body: silentWav(40) };
		}
		assert.notEqual(loudness('s2a').analysed_at, before, 'album 2 was not measured again');
		const measured = loudness('s2a').loudness;
		assert.ok(measured > -30 && measured < 0, `the tone measured ${measured} LUFS`);

		const tagged = { trackGain: -6.5, albumGain: -7, trackPeak: 0.98, albumPeak: 0.99 };
		// On the album just measured as a tone: the tags win over a measurement.
		subsonic.state.replayGains.set('s2b', tagged);
		const songs = async () => {
			const answer = await admin.request('/api/songs', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ ids: ['s2a', 's1a', 's2b'] })
			});
			return Object.fromEntries((await answer.json()).songs.map((song) => [song.id, song.replayGain]));
		};
		try {
			const gains = await songs();
			// To -18 LUFS, with no peak: the excerpt's is not the file's.
			assert.deepEqual(gains.s2a, { trackGain: Math.round((-18 - measured) * 100) / 100, albumGain: null, trackPeak: null, albumPeak: null, measured: true });
			assert.equal(gains.s1a, null, 'silence was given a gain');
			assert.deepEqual(gains.s2b, tagged, 'the tags gave way to the measurement');
		} finally {
			subsonic.state.replayGains.clear();
		}
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

	// Issue #321: albums that sound alike, where the music server's own shelf is short.
	test('fills a short "You might like" shelf with albums that sound alike, after the server\'s own, as the account sees them', async () => {
		const admin = new Client(app.url);
		await admin.signIn({ username: 'testuser', password: 'testpass', backend: 'subsonic' });
		const { default: Database } = await import('better-sqlite3');
		const measuredAt = (id) => {
			const db = new Database(join(app.dataDir, 'analysis.db'), { readonly: true });
			try {
				return db.prepare('SELECT analysed_at FROM song_features WHERE song_id = ?').get(id)?.analysed_at ?? 0;
			} finally {
				db.close();
			}
		};
		// Albums 0 and 1 a low tone, album 2 a high quiet one: 0 and 1 sound alike.
		const tones = { 0: toneWav(40, 0.5, 440), 1: toneWav(40, 0.5, 460), 2: toneWav(40, 0.15, 3000) };
		subsonic.state.audio = { type: 'audio/wav', body: (id) => tones[/^s(\d+)/.exec(id ?? '')?.[1]] ?? silentWav(40) };
		try {
			// Done once nothing of this account's waits, as its album menu reads it:
			// an album an earlier test asked for may still be under way.
			const settled = async (album) => {
				const deadline = Date.now() + 20_000;
				while ((await (await admin.request(`/api/analysis/album/${album}`)).json()).waiting && Date.now() < deadline) {
					await new Promise((resolve) => setTimeout(resolve, 200));
				}
			};
			for (const album of ['al0', 'al1', 'al2']) {
				await settled(album);
				const before = measuredAt(`s${album.slice(2)}b`);
				assert.equal((await admin.request(`/api/analysis/album/${album}`, { method: 'POST' })).status, 202);
				await settled(album);
				assert.notEqual(measuredAt(`s${album.slice(2)}b`), before, `${album} was not measured again`);
			}
		} finally {
			subsonic.state.audio = { type: 'audio/wav', body: silentWav(40) };
		}
		// The shelf is streamed into the page's own response; its cards are named
		// there, after the page's own album, which is left out.
		const shelf = async (album) => {
			const { html } = await admin.page(`/albums/${album}`);
			return ['Album 0', 'Album 1', 'Album 2']
				.filter((name) => name !== `Album ${album.slice(2)}`)
				.map((name) => [name, html.lastIndexOf(`"${name}"`)])
				.filter(([, at]) => at >= 0)
				.sort((a, b) => a[1] - b[1])
				.map(([name]) => name);
		};

		// The server's agents answer nothing: the shelf is album 0's sound-alike first.
		assert.equal((await shelf('al0'))[0], 'Album 1');

		// The server's own answer comes first: for album 1 it names album 2, and
		// the sound-alike album 0 follows it.
		subsonic.state.similarAlbums = 1;
		try {
			assert.deepEqual(await shelf('al1'), ['Album 2', 'Album 0']);
		} finally {
			subsonic.state.similarAlbums = 0;
		}

		// Album 0's songs are in a library this account cannot see: album 2's
		// shelf, for which album 0 sounds nearer than album 1 does not, leaves it out.
		subsonic.state.hidden.set('testuser', new Set(['s0a', 's0b']));
		try {
			const shown = await shelf('al2');
			assert.ok(!shown.includes('Album 0'), `a hidden album is on the shelf: ${shown.join(', ')}`);
			assert.ok(shown.includes('Album 1'), `the visible one is not: ${shown.join(', ')}`);
		} finally {
			subsonic.state.hidden.delete('testuser');
		}
	});

});
