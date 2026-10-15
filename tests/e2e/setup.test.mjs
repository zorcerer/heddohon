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
import { createServer, request as httpRequest } from 'node:http';
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
			assert.deepEqual(await right.json(), { ok: true, missing: { secret: true, upstream: true }, environment: { origin: true, coverCache: false, mcp: false } });
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
					mcp: true,
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
				HEDDOHON_SHARING: 'false',
				HEDDOHON_MCP: 'true'
			});
			// The key is on the page once, and in no log.
			assert.ok(!app.output().includes(body.secret));
			// Saved on, the MCP endpoint is there, and asks for a token.
			assert.equal((await fetch(`${app.url}/api/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401);

			// Set up: the code is spent. For the half hour the page may still take
			// the key out of the file, the endpoint answers that call alone, and
			// says of every other that there is no such thing.
			for (const action of ['check', 'probe', 'save']) {
				assert.equal((await call(client, { action, code, kind: 'subsonic', url: subsonic.url, values: {} })).status, 404, action);
			}
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

	test('the page that finished the setup can take the key out of the file, once, and the server goes on with it until it restarts', async () => {
		const dataDir = mkdtempSync(join(tmpdir(), 'heddohon-setup-'));
		const file = join(dataDir, 'setup.json');
		let app = await unconfigured({}, dataDir);
		try {
			const client = new Client(app.url);
			const saved = await (await call(client, { action: 'save', code: codeOf(app), values: { subsonicUrl: subsonic.url } })).json();
			assert.ok(saved.secret && saved.forgetToken, 'the page was given no way to remove the key');
			assert.ok(!app.output().includes(saved.forgetToken));
			assert.equal((await client.signIn({ username: 'testuser', password: 'testpass', backend: 'subsonic' })).status, 303);

			// Not without the token, not with the setup's code, and not with the key itself.
			for (const token of [undefined, '', 'x'.repeat(32), codeOf(app), saved.secret]) {
				const refused = await call(new Client(app.url), { action: 'forget', token });
				assert.equal(refused.status, 401, String(token).slice(0, 12));
			}
			assert.equal(JSON.parse(readFileSync(file, 'utf8')).HEDDOHON_SECRET, saved.secret);
			// The setup's other calls are gone, as they were.
			assert.equal((await call(new Client(app.url), { action: 'save', code: codeOf(app), values: {} })).status, 404);

			const removed = await call(new Client(app.url), { action: 'forget', token: saved.forgetToken });
			assert.equal(removed.status, 200);
			const kept = JSON.parse(readFileSync(file, 'utf8'));
			assert.ok(!('HEDDOHON_SECRET' in kept), 'the key is still in the file');
			assert.equal(kept.HEDDOHON_SUBSONIC_URL, subsonic.url, 'the rest of the setup went with it');
			assert.equal(statSync(file).mode & 0o777, 0o600);
			// Once: the token is spent, and the endpoint is behind the session gate again.
			const again = await call(new Client(app.url), { action: 'forget', token: saved.forgetToken });
			assert.equal(again.status, 401);
			assert.deepEqual(await again.json(), { error: 'not_authenticated' });

			// The server goes on: the session opens, a new one can be made, and a
			// change an administrator saves does not lose the key either.
			assert.equal((await client.request('/api/settings', { headers: { accept: 'application/json' } })).status, 200);
			assert.equal((await new Client(app.url).signIn({ username: 'testuser', password: 'testpass', backend: 'subsonic' })).status, 303);
			assert.equal((await (await fetch(`${app.url}/healthz`)).json()).status, 'ok');

			// Started again with the key in the environment, the session made under it still opens.
			await app.stop({ keepData: true });
			app = await unconfigured({ HEDDOHON_SECRET: saved.secret }, dataDir);
			assert.equal(codeOf(app), null);
			const later = new Client(app.url);
			later.cookies = client.cookies;
			assert.equal((await later.request('/api/settings', { headers: { accept: 'application/json' } })).status, 200);

			// Started again without it anywhere, the setup is asked for once more, for the key alone.
			await app.stop({ keepData: true });
			app = await unconfigured({}, dataDir);
			const code = codeOf(app);
			assert.ok(code, 'a deployment with no key anywhere did not ask for its setup');
			assert.deepEqual((await (await call(new Client(app.url), { action: 'check', code })).json()).missing, { secret: true, upstream: false });
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
			assert.deepEqual((await (await call(client, { action: 'check', code })).json()).missing, { secret: true, upstream: false });
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

/**
 * A request with headers `fetch` will not send as given (`Host`), and the
 * `Set-Cookie` lines as they came.
 */
function raw(base, path, { method = 'GET', headers = {}, body } = {}) {
	return new Promise((done, fail) => {
		const url = new URL(path, base);
		const request = httpRequest(
			{ host: url.hostname, port: url.port, path: url.pathname + url.search, method, headers: { ...headers, ...(body ? { 'content-length': Buffer.byteLength(body) } : {}) } },
			(response) => {
				let text = '';
				response.on('data', (chunk) => (text += chunk));
				response.on('end', () => done({ status: response.statusCode, headers: response.headers, cookies: response.headers['set-cookie'] ?? [], text }));
			}
		);
		request.on('error', fail);
		request.end(body);
	});
}

describe('the addresses a deployment is opened at', () => {
	/**
	 * As the image runs: production, no ORIGIN, and the cookie rule left to
	 * work it out. `undefined` leaves the variable out of the child's
	 * environment; the adapter refuses an empty ORIGIN.
	 */
	const AS_THE_IMAGE = { ...NOT_SET_UP, ORIGIN: undefined, NODE_ENV: 'production', HEDDOHON_COOKIE_SECURE: '', HEDDOHON_DEFAULT_THEME: '' };
	const form = (fields) => new URLSearchParams(fields).toString();
	const signIn = (base, { host, origin }) =>
		raw(base, '/login', {
			method: 'POST',
			headers: { host, origin, 'content-type': 'application/x-www-form-urlencoded', accept: 'text/html' },
			body: form({ username: 'testuser', password: 'testpass', backend: 'subsonic', next: '/' })
		});

	test('a setup done on a plain http address on the local network can be signed in to there, and nowhere else is let in by it', async () => {
		const dataDir = mkdtempSync(join(tmpdir(), 'heddohon-setup-'));
		const app = await unconfigured(AS_THE_IMAGE, dataDir);
		try {
			const here = app.url; // http://127.0.0.1:port
			const host = new URL(here).host;
			const client = new Client(here);
			const code = codeOf(app);
			assert.deepEqual((await (await call(client, { action: 'check', code })).json()).environment, { origin: false, coverCache: false, mcp: false });

			for (const origin of ['https://a.example/path', 'ftp://a.example', 'https://user:pw@a.example', 'not an address']) {
				const bad = await call(client, { action: 'save', code, values: { subsonicUrl: subsonic.url, origin } });
				assert.equal(bad.status, 400, origin);
				assert.equal((await bad.json()).field, 'origin', origin);
			}
			const size = await call(client, { action: 'save', code, values: { subsonicUrl: subsonic.url, coverCacheMb: 70_000 } });
			assert.equal((await size.json()).field, 'coverCacheMb');

			const saved = await call(client, { action: 'save', code, values: { subsonicUrl: subsonic.url, origin: `${here}  http://music.example.com`, coverCacheMb: 64 } });
			assert.equal(saved.status, 200, app.output());
			// The operator is told which saved address gets a cookie without Secure:
			// the one on the local network, and not the one on a public name.
			assert.deepEqual((await saved.json()).withoutSecure, [here]);
			const kept = JSON.parse(readFileSync(join(dataDir, 'setup.json'), 'utf8'));
			assert.equal(kept.ORIGIN, `${here} http://music.example.com`);
			assert.equal(kept.HEDDOHON_COVER_CACHE_MB, '64');

			// Signed in to on the saved address, with a cookie the browser will send back over http.
			const local = await signIn(here, { host, origin: here });
			assert.equal(local.status, 303, local.text);
			const session = local.cookies.find((line) => /session/i.test(line));
			assert.ok(session, local.cookies.join('\n'));
			assert.ok(!/;\s*secure/i.test(session) && !session.startsWith('__Host-'), `a Secure cookie on plain http: ${session}`);
			assert.match(session, /httponly/i);
			const cookie = session.split(';')[0];

			// Another site is refused as before: its Origin is not the address the request arrived on.
			const settings = (headers) => raw(here, '/api/settings', { method: 'PATCH', headers: { host, cookie, 'content-type': 'application/json', ...headers }, body: '{}' });
			assert.equal((await settings({ origin: here })).status, 200);
			assert.equal((await settings({ origin: 'http://evil.example' })).status, 403);
			assert.equal((await settings({ origin: `https://${host}` })).status, 403, 'the https form of a saved http address');
			assert.equal((await settings({})).status, 403, 'a write with no Origin');
			// Nor by naming the address in the headers the server keeps for itself.
			const forged = await settings({ origin: 'http://evil.example', 'x-heddohon-protocol': 'http', 'x-heddohon-host': 'evil.example' });
			assert.equal(forged.status, 403, 'a client set the address the request is served on');
			// Nor by the headers a proxy uses, which this server reads from nobody:
			// it has no list of addresses that are let through, and saying to
			// come from 127.0.0.1 changes nothing.
			const asLocal = await settings({
				origin: 'http://evil.example',
				'x-forwarded-for': '127.0.0.1',
				'x-forwarded-host': host,
				'x-forwarded-proto': 'http',
				'x-real-ip': '127.0.0.1',
				forwarded: `for=127.0.0.1;host=${host};proto=http`
			});
			assert.equal(asLocal.status, 403, 'forwarded headers let another site write');
			const noSession = await raw(here, '/api/settings', { headers: { host, accept: 'application/json', 'x-forwarded-for': '127.0.0.1', 'x-real-ip': '127.0.0.1', forwarded: 'for=127.0.0.1' } });
			assert.equal(noSession.status, 401, 'a request that says it is from 127.0.0.1 was let in without a session');
			// Nor by a form, which SvelteKit's own check still refuses.
			const crossForm = await signIn(here, { host, origin: 'http://evil.example' });
			assert.equal(crossForm.status, 403);

			// A saved http address on a public name is served as http, and its cookie stays Secure.
			const named = await signIn(here, { host: 'music.example.com', origin: 'http://music.example.com' });
			assert.equal(named.status, 303, named.text);
			assert.match(named.cookies.find((line) => /session/i.test(line)) ?? '', /;\s*secure/i);

			// A host nothing was saved for is taken to be https, as it always was.
			const proxied = await signIn(here, { host: 'other.example.com', origin: 'https://other.example.com' });
			assert.equal(proxied.status, 303, proxied.text);
			assert.match(proxied.cookies.find((line) => /session/i.test(line)) ?? '', /;\s*secure/i);
			assert.equal((await signIn(here, { host: 'other.example.com', origin: 'http://other.example.com' })).status, 403);

			// The cover cache is the size asked for, and the administrator's form names the address too.
			const page = await raw(here, '/settings/__data.json', { headers: { host, cookie } });
			assert.equal(page.status, 200);
			assert.match(page.text, /"withoutSecure"/);
			assert.ok(page.text.includes(String(64 * 1024 * 1024)), 'the cover cache is not 64 MB');
		} finally {
			await app.stop();
		}
	});

	test('without a saved address a plain http deployment still refuses sign-in, as before', async () => {
		const app = await unconfigured(AS_THE_IMAGE);
		try {
			const code = codeOf(app);
			assert.equal((await call(new Client(app.url), { action: 'save', code, values: { subsonicUrl: subsonic.url, origin: '' } })).status, 200);
			const host = new URL(app.url).host;
			assert.equal((await signIn(app.url, { host, origin: app.url })).status, 403);
		} finally {
			await app.stop();
		}
	});

	test('an administrator changes the addresses and the cover cache from Settings, and cannot leave out the address they are on', async () => {
		const dataDir = mkdtempSync(join(tmpdir(), 'heddohon-setup-'));
		const app = await unconfigured(AS_THE_IMAGE, dataDir);
		try {
			const here = app.url;
			const host = new URL(here).host;
			const code = codeOf(app);
			await call(new Client(here), { action: 'save', code, values: { subsonicUrl: subsonic.url, origin: here } });
			const cookie = (await signIn(here, { host, origin: here })).cookies.find((line) => /session/i.test(line)).split(';')[0];
			const save = (fields, origin = here) =>
				raw(here, '/settings?/saveServer', {
					method: 'POST',
					headers: { host, cookie, origin, 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', 'x-sveltekit-action': 'true' },
					body: form(fields)
				});
			const kept = () => JSON.parse(readFileSync(join(dataDir, 'setup.json'), 'utf8'));

			// Without the address this is sent from, every later change would be refused.
			const without = await save({ origins: 'https://music.example.com', coverCacheMb: '32' });
			assert.match(without.text, /has to stay in the list/);
			assert.equal(kept().ORIGIN, here);
			assert.match((await save({ origins: `${here}\nhttps://music.example.com/x`, coverCacheMb: '32' })).text, /nothing after the host/);
			assert.match((await save({ origins: here, coverCacheMb: '-1' })).text, /whole number of megabytes/);

			const both = await save({ origins: `${here}\nhttps://music.example.com`, coverCacheMb: '32' });
			assert.match(both.text, /"type":"success"/, both.text);
			assert.equal(kept().ORIGIN, `${here} https://music.example.com`);
			assert.equal(kept().HEDDOHON_COVER_CACHE_MB, '32');
			assert.equal(statSync(join(dataDir, 'setup.json')).mode & 0o777, 0o600);
			// At once, without a restart: the new address signs in, and the cache is 32 MB.
			assert.equal((await signIn(here, { host: 'music.example.com', origin: 'https://music.example.com' })).status, 303);
			assert.ok((await raw(here, '/settings/__data.json', { headers: { host, cookie } })).text.includes(String(32 * 1024 * 1024)));

			// An account the music server does not list as an administrator is refused.
			subsonic.state.admin = false;
			try {
				const refused = await save({ origins: here, coverCacheMb: '8' });
				assert.match(refused.text, /Only an administrator/);
				assert.equal(kept().HEDDOHON_COVER_CACHE_MB, '32');
				assert.ok(!(await raw(here, '/settings/__data.json', { headers: { host, cookie } })).text.includes('maxCoverCacheMb'), 'the form is offered to an account that is not an administrator');
			} finally {
				subsonic.state.admin = true;
			}
		} finally {
			await app.stop();
		}
	});

	test('what the environment gives is not changed from Settings', async () => {
		const dataDir = mkdtempSync(join(tmpdir(), 'heddohon-setup-'));
		const app = await startApp({ subsonicUrl: subsonic.url, env: { HEDDOHON_JELLYFIN_URL: '', HEDDOHON_COVER_CACHE_MB: '16' }, dataDir });
		try {
			const client = new Client(app.url);
			assert.equal((await client.signIn({ username: 'testuser', password: 'testpass', backend: 'subsonic' })).status, 303);
			const answer = await client.request('/settings?/saveServer', {
				method: 'POST',
				headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', 'x-sveltekit-action': 'true' },
				body: form({ origins: 'https://elsewhere.example', coverCacheMb: '999' })
			});
			assert.match(await answer.text(), /"type":"success"/);
			// Nothing of either was saved, and both are as the environment has them.
			let kept = {};
			try {
				kept = JSON.parse(readFileSync(join(dataDir, 'setup.json'), 'utf8'));
			} catch {
				// No file: nothing was saved.
			}
			assert.deepEqual([kept.ORIGIN, kept.HEDDOHON_COVER_CACHE_MB], [undefined, undefined]);
			const data = await (await client.request('/settings/__data.json')).text();
			assert.ok(data.includes(String(16 * 1024 * 1024)));
			assert.equal((await client.json('/api/settings', 'PATCH', {}, { origin: 'https://elsewhere.example' })).status, 403);
		} finally {
			await app.stop();
		}
	});
});
