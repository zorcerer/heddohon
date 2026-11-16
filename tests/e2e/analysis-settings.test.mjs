/**
 * Sound analysis under Settings, Server (issue #319): `/api/analysis`, which
 * the section asks for the job's status and changes its settings through.
 * For an administrator of the music server alone. Runs the built app with no
 * ffmpeg on its path, so the job stops as soon as it has a song to read.
 *
 *   node --test tests/e2e/analysis-settings.test.mjs
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { Client, startApp } from './harness.mjs';
import { startJellyfin, startSubsonic } from './mocks.mjs';

const json = (body) => ({ method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const action = (name) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: name }) });

async function until(check, what, ms = 10_000) {
	const deadline = Date.now() + ms;
	for (;;) {
		const value = await check();
		if (value) return value;
		if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}

describe('/api/analysis', () => {
	let subsonic;
	let jellyfin;
	let app;
	let admin;
	// A directory with nothing in it as the app's path: no ffmpeg, wherever the suite runs.
	const emptyPath = mkdtempSync(join(tmpdir(), 'heddohon-no-ffmpeg-'));

	before(async () => {
		subsonic = await startSubsonic({ artistCount: 2 });
		jellyfin = await startJellyfin();
		// The default log level, which writes errors alone.
		app = await startApp({ subsonicUrl: subsonic.url, jellyfinUrl: jellyfin.url, env: { PATH: emptyPath, HEDDOHON_LOG_LEVEL: '' } });
		admin = new Client(app.url);
		assert.equal((await admin.signIn({ username: 'testuser', password: 'testpass', backend: 'subsonic' })).status, 303);
	});

	after(async () => {
		await app?.stop();
		await subsonic?.close();
		await jellyfin?.close();
		rmSync(emptyPath, { recursive: true, force: true });
	});

	const overview = async () => (await admin.request('/api/analysis')).json();

	test('answers only an administrator of the music server', async () => {
		assert.equal((await fetch(`${app.url}/api/analysis`)).status, 401);
		const listener = new Client(app.url);
		assert.equal((await listener.signIn({ username: 'jfuser', password: 'jfpass', backend: 'jellyfin' })).status, 303);
		assert.equal((await listener.request('/api/analysis')).status, 403);
		assert.equal((await listener.request('/api/analysis', json({ on: true }))).status, 403);
		assert.equal((await listener.request('/api/analysis', action('reset'))).status, 403);
		assert.equal((await overview()).on, false, 'a refused request switched it on');
	});

	test('says it is off, with the default settings, before it is switched on', async () => {
		const body = await overview();
		assert.equal(body.on, false);
		assert.equal(body.fromEnvironment, false);
		assert.equal(body.status?.state ?? 'off', 'off');
		assert.deepEqual(body.settings, { paused: false, pace: 'gentle', whileListening: 'pause', hours: null });
	});

	test('refuses a setting out of its bounds, and changes nothing', async () => {
		for (const bad of [
			[],
			{ paused: 'yes' },
			{ pace: 'fast' },
			{ whileListening: 'stop' },
			{ hours: { from: 0, to: 1440 } },
			{ hours: { from: -1, to: 60 } },
			{ hours: { from: 1.5, to: 60 } },
			{ hours: 'night' },
			{ on: 'true' }
		]) {
			assert.equal((await admin.request('/api/analysis', json(bad))).status, 400, JSON.stringify(bad));
		}
		assert.equal((await admin.request('/api/analysis', action('everything'))).status, 400);
		assert.deepEqual((await overview()).settings, { paused: false, pace: 'gentle', whileListening: 'pause', hours: null });
	});

	test('saves the settings and the switch, which survive in the data directory', async () => {
		const answer = await admin.request('/api/analysis', json({ on: true, paused: true, pace: 'background', whileListening: 'continue', hours: { from: 1380, to: 360 } }));
		assert.equal(answer.status, 200);
		const body = await answer.json();
		assert.equal(body.on, true);
		assert.deepEqual(body.settings, { paused: true, pace: 'background', whileListening: 'continue', hours: { from: 1380, to: 360 } });
		assert.deepEqual((await overview()).settings, body.settings);
		assert.equal(JSON.parse(readFileSync(join(app.dataDir, 'setup.json'), 'utf8')).HEDDOHON_ANALYSIS, 'true');
		// On, but with no account named, no album is offered or taken (issue #330).
		assert.deepEqual(await (await admin.request('/api/analysis/album/al1')).json(), { offered: false });
		assert.equal((await admin.request('/api/analysis/album/al1', { method: 'POST' })).status, 404);
		// One field at a time leaves the others.
		const next = await (await admin.request('/api/analysis', json({ hours: null, whileListening: 'pause' }))).json();
		assert.deepEqual(next.settings, { paused: true, pace: 'background', whileListening: 'pause', hours: null });
	});

	test('a stop is written to the log at the default level, and the status says why', async () => {
		const named = await admin.request('/settings?/saveAnalysisAccount', {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', 'x-sveltekit-action': 'true' },
			body: new URLSearchParams({ username: 'analyst', password: 'analyst-pass' }).toString()
		});
		assert.equal((await named.json()).type, 'success');
		await until(async () => (await overview()).status?.state === 'paused', 'the job to say it is paused');
		assert.doesNotMatch(app.output(), /analysis-/, 'a line below the error level was written');

		await admin.request('/api/analysis', json({ paused: false }));
		const stopped = await until(async () => {
			const body = await overview();
			return body.status?.state === 'stopped' && body;
		}, 'the job to stop without ffmpeg');
		assert.match(stopped.status.lastError.message, /ffmpeg/);
		assert.equal(stopped.status.failed, 0, 'a missing ffmpeg was blamed on a song');
		await until(() => /analysis-stopped/.test(app.output()), 'the stop in the log');
	});

	test('retries the failures and resets the results on request', async () => {
		const retried = await admin.request('/api/analysis', action('retry'));
		assert.equal(retried.status, 200);
		const file = join(app.dataDir, 'analysis.db');
		await admin.request('/api/analysis', json({ paused: true }));
		const reset = await admin.request('/api/analysis', action('reset'));
		assert.equal(reset.status, 200);
		assert.equal(existsSync(file), false, 'analysis.db is still there');
	});

	test('switched off, it says so at once', async () => {
		const body = await (await admin.request('/api/analysis', json({ on: false }))).json();
		assert.equal(body.on, false);
		assert.equal(body.status?.state ?? 'off', 'off');
		assert.equal(JSON.parse(readFileSync(join(app.dataDir, 'setup.json'), 'utf8')).HEDDOHON_ANALYSIS, undefined);
	});
});

describe('/api/analysis with HEDDOHON_ANALYSIS in the environment', () => {
	test('leaves the switch to the environment', async () => {
		const subsonic = await startSubsonic({ artistCount: 1 });
		const jellyfin = await startJellyfin();
		const app = await startApp({ subsonicUrl: subsonic.url, jellyfinUrl: jellyfin.url, env: { HEDDOHON_ANALYSIS: 'false' } });
		try {
			const admin = new Client(app.url);
			await admin.signIn({ username: 'testuser', password: 'testpass', backend: 'subsonic' });
			assert.equal((await admin.request('/api/analysis', json({ on: true }))).status, 409);
			const body = await (await admin.request('/api/analysis')).json();
			assert.equal(body.on, false);
			assert.equal(body.fromEnvironment, true);
		} finally {
			await app.stop();
			await subsonic.close();
			await jellyfin.close();
		}
	});
});
