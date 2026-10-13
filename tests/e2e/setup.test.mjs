/**
 * The first-run setup: a deployment started without its secret or its music
 * server, the code it prints, and what the code allows.
 *
 *   npm run build && npm run test:e2e
 *
 * Each test starts an app of its own: the setup ends the state it tests.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { Client, startApp } from './harness.mjs';
import { startSubsonic } from './mocks.mjs';

let subsonic;
before(async () => {
	subsonic = await startSubsonic({ artistCount: 3 });
});
after(async () => {
	await subsonic?.close();
});

/** The harness gives every app a secret and both servers. Empty is unset. */
const NOT_SET_UP = { HEDDOHON_SECRET: '', HEDDOHON_SUBSONIC_URL: '', HEDDOHON_JELLYFIN_URL: '' };
const unconfigured = (env = {}, dataDir = null) => startApp({ env: { ...NOT_SET_UP, ...env }, dataDir });

const CODE = /\b([0-9A-HJKMNP-TV-Z]{5}(?:-[0-9A-HJKMNP-TV-Z]{5}){3})\b/;
const codeOf = (app) => app.output().match(CODE)?.[1] ?? null;
const call = (client, body, extra) => client.json('/api/setup', 'POST', body, extra);

describe('a deployment that is not set up', () => {
	test('prints a code as it starts, serves the setup page and nothing else, and passes its health check', async () => {
		const app = await unconfigured();
		try {
			// Before any page was asked for: the harness has only polled /healthz.
			const code = codeOf(app);
			assert.ok(code, `no code in the output:\n${app.output()}`);
			assert.equal(code.replace(/-/g, '').length, 20);

			const health = await fetch(`${app.url}/healthz`);
			assert.equal(health.status, 200, 'a failing probe has the container restarted, and the code with it');
			assert.equal((await health.json()).status, 'setup');

			const client = new Client(app.url);
			const home = await client.page('/');
			assert.equal(home.response.status, 303);
			assert.equal(home.response.headers.get('location'), '/setup');
			const login = await client.page('/login');
			assert.equal(login.response.headers.get('location'), '/setup');
			const api = await client.request('/api/settings', { headers: { accept: 'application/json' } });
			assert.equal(api.status, 503);
			assert.deepEqual(await api.json(), { error: 'setup_required' });

			const { response, html } = await client.page('/setup');
			assert.equal(response.status, 200);
			assert.match(html, /Set up Heddohon/);
			assert.match(response.headers.get('cache-control'), /no-store/);
			assert.ok(response.headers.get('content-security-policy'), 'the setup page has no policy');
			// The page says nothing of what is missing, and the code is not in it.
			assert.ok(!html.includes(code) && !html.includes(code.replace(/-/g, '')));
			assert.ok(!/"secret":|"upstream":/.test(html), 'the page tells what is missing before the code');
			// Nor in the log files, which outlive the start the code is good for.
			assert.ok(!app.output().includes('setup-code'), app.output());
		} finally {
			await app.stop();
		}
	});

	test('every call is refused without the code, and a wrong code is refused as often as it is tried', async () => {
		const app = await unconfigured();
		try {
			const code = codeOf(app);
			const client = new Client(app.url);
			subsonic.calls.reset();
			for (const body of [
				{ action: 'check' },
				{ action: 'check', code: '' },
				{ action: 'check', code: 'AAAAA-AAAAA-AAAAA-AAAAA' },
				{ action: 'check', code: code.slice(0, -1) },
				{ action: 'check', code: `${code}0` },
				{ action: 'check', code: ['x'] },
				{ action: 'probe', kind: 'subsonic', url: subsonic.url },
				{ action: 'probe', kind: 'subsonic', url: subsonic.url, code: 'AAAAA-AAAAA-AAAAA-AAAAA' },
				{ action: 'save', values: { subsonicUrl: subsonic.url } }
			]) {
				const response = await call(client, body);
				assert.equal(response.status, 401, JSON.stringify(body));
				assert.deepEqual(await response.json(), { error: 'wrong_code' });
			}
			assert.equal(subsonic.calls.get('ping'), 0, 'an address was asked without the code');

			// Thirty more wrong ones, and the right one is still taken: a count
			// that locked the page would let anyone who can reach it lock the
			// operator out.
			for (let i = 0; i < 30; i++) await call(client, { action: 'check', code: `WRONG-WRONG-WRONG-${String(i).padStart(5, '0')}` });
			const right = await call(client, { action: 'check', code });
			assert.equal(right.status, 200);
			assert.deepEqual(await right.json(), { ok: true, missing: { secret: true, upstream: true } });
			// As typed: lower case, without the hyphens.
			assert.equal((await call(client, { action: 'check', code: code.toLowerCase().replace(/-/g, ' ') })).status, 200);

			// Not as a form, which a page on another origin can post.
			for (const type of ['application/x-www-form-urlencoded', 'text/plain']) {
				const form = await client.request('/api/setup', {
					method: 'POST',
					headers: { 'content-type': type },
					body: JSON.stringify({ action: 'check', code })
				});
				assert.ok([403, 415].includes(form.status), `${type}: ${form.status}`);
			}
			// A body larger than the setup has any use for.
			const large = await call(client, { action: 'check', code, pad: 'x'.repeat(20_000) });
			assert.equal(large.status, 413);
			assert.equal((await client.request('/api/setup', { headers: { accept: 'application/json' } })).status, 503);
		} finally {
			await app.stop();
		}
	});

	test('the probe says whether a music server answers, and returns nothing else of what the address sent', async () => {
		// A host that is not a music server and holds something worth reading.
		const other = createServer((req, res) => {
			if (req.url.startsWith('/redirect')) {
				res.writeHead(302, { location: `${subsonic.url}/rest/ping.view` });
				return res.end();
			}
			if (req.url.startsWith('/endless')) {
				res.writeHead(200, { 'content-type': 'application/json' });
				const timer = setInterval(() => res.write('x'.repeat(64 * 1024)), 5);
				res.on('close', () => clearInterval(timer));
				return;
			}
			res.writeHead(200, { 'content-type': 'application/json' });
			res.end(JSON.stringify({ secret: 'internal-admin-token', 'not-subsonic': true }));
		});
		await new Promise((done) => other.listen(0, '127.0.0.1', done));
		const otherUrl = `http://127.0.0.1:${other.address().port}`;
		const app = await unconfigured();
		try {
			const code = codeOf(app);
			const client = new Client(app.url);
			const ask = async (kind, url) => (await call(client, { action: 'probe', code, kind, url })).json();

			const found = await ask('subsonic', subsonic.url);
			assert.equal(found.ok, true);
			assert.deepEqual(Object.keys(found).sort(), ['ok', 'server']);
			assert.match(found.server, /^[\w .+-]{1,90}$/);

			const notOne = await ask('subsonic', otherUrl);
			assert.deepEqual(notOne, { ok: false, why: 'not_a_music_server' });
			assert.ok(!JSON.stringify(notOne).includes('internal-admin-token'));
			assert.deepEqual(await ask('jellyfin', subsonic.url), { ok: false, why: 'not_a_music_server' });
			// A redirect to a real server is not followed.
			assert.equal((await ask('subsonic', `${otherUrl}/redirect`)).ok, false);
			// Nothing listening.
			assert.deepEqual(await ask('subsonic', 'http://127.0.0.1:9'), { ok: false, why: 'unreachable' });
			// Not an address the configuration would take.
			for (const url of ['file:///etc/passwd', 'ftp://127.0.0.1/', 'not a url', `${subsonic.url}/?x=1`, 'x'.repeat(3000), 7]) {
				assert.deepEqual(await ask('subsonic', url), { ok: false, why: 'address' }, String(url).slice(0, 40));
			}
			assert.equal((await call(client, { action: 'probe', code, kind: 'postgres', url: subsonic.url })).status, 400);

			// An address that never stops sending is cut off and answered.
			const started = Date.now();
			const endless = await ask('subsonic', `${otherUrl}/endless`);
			assert.equal(endless.ok, false);
			assert.ok(Date.now() - started < 4000, `the endless answer was read for ${Date.now() - started}ms`);
		} finally {
			await app.stop();
			await new Promise((done) => other.close(done));
			other.closeAllConnections?.();
		}
	});

	test('saving ends the setup: the file is this user\'s alone, the routes are gone, and a restart keeps the key', async () => {
		const dataDir = mkdtempSync(join(tmpdir(), 'heddohon-setup-'));
		// The harness names a default theme, and the environment would win over the one saved.
		const env = { HEDDOHON_DEFAULT_THEME: '' };
		let app = await unconfigured(env, dataDir);
		try {
			const code = codeOf(app);
			const client = new Client(app.url);

			const nothing = await call(client, { action: 'save', code, values: { theme: 'paper' } });
			assert.equal(nothing.status, 400, 'saved without a music server');
			const bad = await call(client, { action: 'save', code, values: { subsonicUrl: 'file:///etc/passwd' } });
			assert.equal(bad.status, 400);
			assert.equal((await bad.json()).field, 'subsonicUrl');

			const saved = await call(client, {
				action: 'save',
				code,
				values: {
					subsonicUrl: `${subsonic.url}/`,
					subsonicLabel: '  <b>Home</b>  ',
					theme: 'paper',
					sharing: false,
					downloads: 'yes',
					// Not what the setup may save.
					HEDDOHON_DATABASE_URL: 'postgres://evil.example/x',
					HEDDOHON_RADIO_PRIVATE: 'true',
					__proto__: { HEDDOHON_SECRET: 'x'.repeat(40) }
				}
			});
			assert.equal(saved.status, 200);
			const body = await saved.json();
			assert.equal(body.ok, true);
			assert.ok(body.secret.length >= 64, 'the key is shorter than the 48 bytes the README asks for');
			assert.match(saved.headers.get('cache-control'), /no-store/);

			const file = join(dataDir, 'setup.json');
			assert.equal(statSync(file).mode & 0o777, 0o600);
			const kept = JSON.parse(readFileSync(file, 'utf8'));
			assert.deepEqual(kept, {
				HEDDOHON_SECRET: body.secret,
				HEDDOHON_SUBSONIC_URL: subsonic.url,
				HEDDOHON_SUBSONIC_LABEL: '<b>Home</b>',
				HEDDOHON_DEFAULT_THEME: 'paper',
				HEDDOHON_SHARING: 'false'
			});
			// The key is on the page once, and in no log.
			assert.ok(!app.output().includes(body.secret));

			// Set up: the code is spent and the routes answer as any other.
			assert.equal((await call(client, { action: 'check', code })).status, 401);
			assert.deepEqual(await (await call(client, { action: 'check', code })).json(), { error: 'not_authenticated' });
			assert.equal((await client.page('/setup')).response.headers.get('location'), '/login?next=%2Fsetup');
			assert.equal((await (await fetch(`${app.url}/healthz`)).json()).status, 'ok');

			// The saved server is the one signed in to, under its name, written as text.
			const login = await client.page('/login');
			assert.match(login.html, /to &lt;b>Home&lt;\/b></);
			assert.ok(!login.html.includes('<b>Home</b>'));
			assert.ok(!login.html.includes(new URL(subsonic.url).host), 'the address of the music server is on the sign-in page');
			assert.match(login.html, /data-theme="light"/);
			const signIn = await client.signIn({ username: 'testuser', password: 'testpass', backend: 'subsonic' });
			assert.equal(signIn.status, 303, app.output());
			assert.equal((await client.request('/api/settings', { headers: { accept: 'application/json' } })).status, 200);

			// Started again on the same data: no setup, no code, and the session
			// made under the generated key still opens.
			await app.stop({ keepData: true });
			app = await unconfigured(env, dataDir);
			assert.equal(codeOf(app), null, 'a set-up deployment printed a code');
			assert.equal((await (await fetch(`${app.url}/healthz`)).json()).status, 'ok');
			const again = new Client(app.url);
			again.cookies = client.cookies;
			assert.equal((await again.request('/api/settings', { headers: { accept: 'application/json' } })).status, 200);
		} finally {
			await app.stop();
		}
	});

	test('the environment wins over what was saved, and an address is not saved where it names the server', async () => {
		const dataDir = mkdtempSync(join(tmpdir(), 'heddohon-setup-'));
		// The music server is in the environment, and the secret is not.
		let app = await startApp({ subsonicUrl: subsonic.url, env: { HEDDOHON_SECRET: '', HEDDOHON_JELLYFIN_URL: '' }, dataDir });
		try {
			const code = codeOf(app);
			const client = new Client(app.url);
			assert.deepEqual(await (await call(client, { action: 'check', code })).json(), { ok: true, missing: { secret: true, upstream: false } });
			const saved = await call(client, { action: 'save', code, values: { subsonicUrl: 'http://127.0.0.1:9', jellyfinUrl: 'http://127.0.0.1:9' } });
			assert.equal(saved.status, 200);
			const kept = JSON.parse(readFileSync(join(dataDir, 'setup.json'), 'utf8'));
			assert.deepEqual(Object.keys(kept), ['HEDDOHON_SECRET']);
			assert.equal((await client.signIn({ username: 'testuser', password: 'testpass', backend: 'subsonic' })).status, 303);

			// A secret in the environment is the one used: the session made under
			// the saved one no longer opens.
			await app.stop({ keepData: true });
			app = await startApp({ subsonicUrl: subsonic.url, env: { HEDDOHON_JELLYFIN_URL: '' }, dataDir });
			const again = new Client(app.url);
			again.cookies = client.cookies;
			assert.equal((await again.request('/api/settings', { headers: { accept: 'application/json' } })).status, 401);
		} finally {
			await app.stop();
		}
	});

	test('with HEDDOHON_SETUP=false, and with a saved file that cannot be read, it is a misconfiguration as before', async () => {
		const off = await startAppUnhealthy({ ...NOT_SET_UP, HEDDOHON_SETUP: 'false' });
		try {
			assert.equal(codeOf(off), null);
			const health = await fetch(`${off.url}/healthz`);
			assert.equal(health.status, 503);
			assert.equal((await health.json()).status, 'misconfigured');
			assert.equal((await new Client(off.url).page('/setup')).response.status, 500);
			assert.equal((await call(new Client(off.url), { action: 'check', code: 'x' })).status, 500);
		} finally {
			await off.stop();
		}

		// A file that is not what the setup writes is not an empty one: the
		// setup is not offered again over it.
		const dataDir = mkdtempSync(join(tmpdir(), 'heddohon-setup-'));
		writeFileSync(join(dataDir, 'setup.json'), '{ not json');
		const broken = await startAppUnhealthy(NOT_SET_UP, dataDir);
		try {
			assert.equal(codeOf(broken), null);
			assert.equal((await (await fetch(`${broken.url}/healthz`)).json()).status, 'misconfigured');
			assert.equal((await new Client(broken.url).page('/setup')).response.status, 500);
		} finally {
			await broken.stop();
		}
	});
});

/**
 * `startApp` waits for a healthy probe, which a misconfigured app never
 * gives. This waits for any answer.
 */
async function startAppUnhealthy(env, dataDir = null) {
	const { spawn } = await import('node:child_process');
	const { createServer: createNet } = await import('node:net');
	const { resolve } = await import('node:path');
	const { rmSync } = await import('node:fs');
	const port = await new Promise((done) => {
		const probe = createNet();
		probe.listen(0, '127.0.0.1', () => {
			const { port } = probe.address();
			probe.close(() => done(port));
		});
	});
	const url = `http://127.0.0.1:${port}`;
	const dir = dataDir ?? mkdtempSync(join(tmpdir(), 'heddohon-setup-'));
	const child = spawn(process.execPath, [resolve(import.meta.dirname, '../../build/index.js')], {
		env: { PATH: process.env.PATH, HOST: '127.0.0.1', PORT: String(port), ORIGIN: url, HEDDOHON_DATA_DIR: dir, HEDDOHON_LOG_LEVEL: 'warn', ...env },
		stdio: ['ignore', 'pipe', 'pipe']
	});
	let output = '';
	child.stdout.on('data', (chunk) => (output += chunk));
	child.stderr.on('data', (chunk) => (output += chunk));
	const deadline = Date.now() + 15_000;
	for (;;) {
		try {
			await fetch(`${url}/healthz`);
			break;
		} catch {
			if (Date.now() > deadline) throw new Error(`The app did not answer within 15s:\n${output}`);
			await new Promise((done) => setTimeout(done, 100));
		}
	}
	return {
		url,
		output: () => output,
		async stop() {
			if (child.exitCode === null) {
				const exited = new Promise((done) => child.once('exit', done));
				child.kill('SIGTERM');
				await exited;
			}
			rmSync(dir, { recursive: true, force: true });
		}
	};
}
