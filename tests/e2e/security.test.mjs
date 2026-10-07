/**
 * The security posture, checked over every route the app has.
 *
 *   npm run build && npm run test:e2e
 *
 * The routes are read from `src/routes`, so a route added later is held to the
 * same rules without a test of its own: a session for everything outside the
 * public list, the origin check on every write, the hardening headers on
 * every answer, and no music-server address in any of them. `app.test.mjs`
 * and `run.sh` check single routes in depth.
 */
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { Client, startApp } from './harness.mjs';
import { startJellyfin, startSubsonic } from './mocks.mjs';

const ROUTES = resolve(import.meta.dirname, '../../src/routes');

/**
 * Routes reachable without a session, as `PUBLIC_ROUTES` in `hooks.server.ts`
 * lists them. Written out here, so making a route public takes a change to
 * this file as well.
 */
const PUBLIC = ['/login', '/healthz', '/share', '/cast', '/together', '/manifest.webmanifest', '/.well-known/assetlinks.json', '/api/plugin/navidrome'];
const isPublic = (path) => PUBLIC.some((route) => path === route || path.startsWith(`${route}/`));

/** Public documents that say nothing of any account: the same answer for every visitor. */
const ACCOUNT_FREE = ['/manifest.webmanifest', '/.well-known/assetlinks.json'];

const WRITES = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Every route as an address and the methods it answers. A parameter is `x`, or `1` where it is a position. */
function routes() {
	const found = new Map();
	const add = (dir, method) => {
		const path =
			'/' +
			relative(ROUTES, dir)
				.split(/[\\/]/)
				.filter((segment) => segment && !segment.startsWith('[['))
				.map((segment) => (segment === '[n]' ? '1' : segment.startsWith('[') ? 'x' : segment))
				.join('/');
		if (!found.has(path)) found.set(path, new Set());
		found.get(path).add(method);
	};
	const walk = (dir) => {
		for (const name of readdirSync(dir)) {
			const file = join(dir, name);
			if (statSync(file).isDirectory()) walk(file);
			else if (name === '+page.svelte') add(dir, 'GET');
			else if (name === '+page.server.ts' && /export const actions\b/.test(readFileSync(file, 'utf8'))) add(dir, 'POST');
			else if (name === '+server.ts') {
				const methods = [...readFileSync(file, 'utf8').matchAll(/export const (GET|HEAD|POST|PUT|PATCH|DELETE)\b/g)].map((m) => m[1]);
				assert.ok(methods.length > 0, `${file} exports no method this test can read`);
				for (const method of methods) add(dir, method);
			}
		}
	};
	walk(ROUTES);
	return [...found].flatMap(([path, methods]) => [...methods].map((method) => ({ path, method })));
}

const ALL = routes();

let subsonic;
let jellyfin;
let app;
/** Signed in to the Subsonic mock. */
let user;
/** Every answer the sweeps below got, for the checks that hold for all of them. */
const answers = [];

before(async () => {
	subsonic = await startSubsonic();
	jellyfin = await startJellyfin();
	app = await startApp({ subsonicUrl: subsonic.url, jellyfinUrl: jellyfin.url });
	user = new Client(app.url);
	const signedIn = await user.signIn({ username: 'testuser', password: 'testpass', backend: 'subsonic' });
	assert.equal(signedIn.status, 303, app.output());
});

after(async () => {
	await app?.stop();
	await subsonic?.close();
	await jellyfin?.close();
});

/**
 * One request, with its text kept where it is a page or JSON. A stream (audio,
 * a cover, server-sent events) is cancelled unread: an event stream never ends.
 */
async function ask(client, { path, method }, options = {}) {
	const api = path.startsWith('/api/');
	const response = await client.request(path, {
		method,
		headers: { accept: api ? 'application/json' : 'text/html', ...(WRITES.has(method) ? { 'content-type': 'application/json' } : {}) },
		body: WRITES.has(method) ? '{}' : undefined,
		...options
	});
	const type = response.headers.get('content-type') ?? '';
	let text = '';
	if (/html|json|text\/plain|xml/.test(type)) text = await response.text();
	else await response.body?.cancel();
	const answer = { path, method, response, text };
	answers.push(answer);
	return answer;
}

describe('every route', () => {
	test('is found: the walk reads the routes there are', () => {
		assert.ok(ALL.length >= 60, `only ${ALL.length} routes and methods found under src/routes`);
		for (const path of ['/api/stream/x', '/share/x/stream/1', '/folders', '/settings']) {
			assert.ok(ALL.some((route) => route.path === path), `${path} was not found`);
		}
	});

	test('outside the public list refuses a visitor without a session', async () => {
		for (const route of ALL.filter((route) => !isPublic(route.path))) {
			const { response, text } = await ask(new Client(app.url), route);
			const label = `${route.method} ${route.path}`;
			if (route.path.startsWith('/api/')) {
				assert.equal(response.status, 401, label);
				if (route.method !== 'HEAD') assert.deepEqual(JSON.parse(text), { error: 'not_authenticated' }, label);
			} else {
				assert.equal(response.status, 303, label);
				assert.match(response.headers.get('location') ?? '', /^\/login\?next=/, label);
			}
		}
	});

	test('on the public list gives a visitor without a session nothing of an account', async () => {
		// `/share/x` is a page too: it says the link does not open, in the same
		// words for a link withdrawn, expired or never made.
		const open = new Set([...ACCOUNT_FREE, '/login', '/healthz', '/share/x']);
		for (const route of ALL.filter((route) => isPublic(route.path) && !WRITES.has(route.method))) {
			const { response, text } = await ask(new Client(app.url), route);
			const label = `${route.method} ${route.path}`;
			// A link's token is the authority, and `x` is no token: every route
			// under a link answers as for a link that does not exist.
			assert.equal(response.status, open.has(route.path) ? 200 : 404, label);
			assert.equal(response.headers.get('set-cookie'), null, label);
			if (route.path === '/share/x') assert.ok(!text.includes('/share/x/stream'), 'a link that does not exist offers audio');
		}
	});

	test('under /api without the session gate is the Navidrome plugin\'s alone, and is not there without its token', async () => {
		const writes = ALL.filter((route) => isPublic(route.path) && route.path.startsWith('/api/'));
		assert.deepEqual(writes, [{ path: '/api/plugin/navidrome', method: 'POST' }]);
		// This app has no HEDDOHON_NAVIDROME_PLUGIN_TOKEN: with or without a
		// session, and whatever is sent as a token, the route is not found.
		for (const client of [new Client(app.url), user]) {
			const { response, text } = await ask(client, writes[0], {
				headers: { 'content-type': 'application/json', authorization: 'Bearer anything' },
				body: JSON.stringify({ v: 1, type: 'poll' })
			});
			assert.equal(response.status, 404);
			assert.deepEqual(JSON.parse(text), { error: 'not_found' });
		}
	});

	test('refuses a write from another origin, and one with no Origin, before anything else', async () => {
		const writes = ALL.filter((route) => WRITES.has(route.method));
		assert.ok(writes.length >= 30, `only ${writes.length} writes found`);
		for (const route of writes) {
			for (const origin of ['https://evil.example', null]) {
				const { response, text } = await ask(user, route, { origin });
				const label = `${route.method} ${route.path} from ${origin}`;
				assert.equal(response.status, 403, label);
				assert.deepEqual(JSON.parse(text), { error: 'cross_origin_forbidden' }, label);
			}
		}
	});

	test('answers a signed-in browser without a server error', async () => {
		// Ids of `x` name nothing, so most of these are a 404 or a 400: the
		// error pages are answers too, and are checked with the rest below.
		for (const route of ALL.filter((route) => !WRITES.has(route.method))) {
			const { response } = await ask(user, route);
			assert.ok(response.status < 500 || response.status === 502, `${route.method} ${route.path} answered ${response.status}\n${app.output()}`);
		}
	});

	test('carries the hardening headers on every answer', () => {
		assert.ok(answers.length >= 200, `only ${answers.length} answers were collected`);
		for (const { path, method, response } of answers) {
			const label = `${method} ${path} (${response.status})`;
			assert.equal(response.headers.get('x-content-type-options'), 'nosniff', label);
			assert.equal(response.headers.get('x-frame-options'), 'SAMEORIGIN', label);
			assert.equal(response.headers.get('referrer-policy'), 'same-origin', label);
			assert.match(response.headers.get('strict-transport-security') ?? '', /max-age=31536000/, label);
			assert.match(response.headers.get('permissions-policy') ?? '', /camera=\(\)/, label);
			assert.equal(response.headers.get('cross-origin-opener-policy'), 'same-origin', label);
			assert.ok(response.headers.has('cache-control'), `${label} has no cache-control`);
			// Only the two documents that are the same for everybody may be kept by
			// a shared cache.
			if (!ACCOUNT_FREE.includes(path)) assert.match(response.headers.get('cache-control') ?? '', /private|no-store/, label);
			if ((response.headers.get('content-type') ?? '').startsWith('text/html')) {
				assert.match(response.headers.get('content-security-policy') ?? '', /default-src 'none'/, label);
			}
		}
	});

	test('names no music server address, in a body or a header', () => {
		const hidden = [subsonic.url, jellyfin.url].flatMap((url) => [new URL(url).host, `:${new URL(url).port}`]);
		for (const { path, method, response, text } of answers) {
			const headers = [...response.headers].map(([name, value]) => `${name}: ${value}`).join('\n');
			for (const address of hidden) {
				assert.ok(!text.includes(address), `${method} ${path} (${response.status}) names ${address} in its body`);
				assert.ok(!headers.includes(address), `${method} ${path} (${response.status}) names ${address} in a header`);
			}
		}
	});
});

/** The `Set-Cookie` line for `name`, as its value and its lower-cased attributes. */
function cookieOf(response, name) {
	const line = response.headers.getSetCookie().find((entry) => entry.startsWith(`${name}=`));
	if (!line) return null;
	const [pair, ...attributes] = line.split(';').map((part) => part.trim());
	return { value: pair.slice(name.length + 1), attributes: attributes.map((attribute) => attribute.toLowerCase()) };
}

/** Signs in with a bare `fetch`, so the `Set-Cookie` lines are there to read. */
function signInRaw(url) {
	return fetch(`${url}/login`, {
		method: 'POST',
		redirect: 'manual',
		headers: { origin: url, accept: 'text/html', 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({ username: 'testuser', password: 'testpass', backend: 'subsonic', next: '/' }).toString()
	});
}

const home = (url, cookie) => fetch(`${url}/`, { redirect: 'manual', headers: { accept: 'text/html', ...(cookie ? { cookie } : {}) } });

describe('the session cookie', () => {
	test('over plain http is HttpOnly and SameSite=Lax, under the bare name', async () => {
		const cookie = cookieOf(await signInRaw(app.url), 'heddohon_session');
		assert.ok(cookie, 'no session cookie was set');
		assert.match(cookie.value, /^[A-Za-z0-9_-]{43}$/, 'the token is not 256 bits of base64url');
		for (const attribute of ['httponly', 'samesite=lax', 'path=/']) assert.ok(cookie.attributes.includes(attribute), attribute);
		assert.ok(!cookie.attributes.includes('secure'));
		assert.ok(!cookie.attributes.some((attribute) => attribute.startsWith('domain=')));
	});

	describe('where it is Secure', () => {
		let secure;
		let token;

		before(async () => {
			secure = await startApp({ subsonicUrl: subsonic.url, jellyfinUrl: jellyfin.url, env: { HEDDOHON_COOKIE_SECURE: 'true' } });
		});
		after(() => secure?.stop());

		test('is named __Host-, with Secure and no Domain, and so is the known-device cookie', async () => {
			const response = await signInRaw(secure.url);
			assert.equal(response.status, 303, secure.output());
			// The bare name is only ever cleared here: one left from before the
			// deployment became Secure.
			const bare = cookieOf(response, 'heddohon_session');
			assert.ok(bare === null || (bare.value === '' && bare.attributes.includes('max-age=0')), 'the bare name was set as well');
			for (const name of ['__Host-heddohon_session', '__Host-heddohon_device']) {
				const cookie = cookieOf(response, name);
				assert.ok(cookie, `${name} was not set`);
				for (const attribute of ['httponly', 'secure', 'samesite=lax', 'path=/']) assert.ok(cookie.attributes.includes(attribute), `${name}: ${attribute}`);
				assert.ok(!cookie.attributes.some((attribute) => attribute.startsWith('domain=')), `${name} has a Domain`);
			}
			token = cookieOf(response, '__Host-heddohon_session').value;
		});

		test('opens the app under its own name only: the bare name a sibling origin could plant is not read', async () => {
			assert.equal((await home(secure.url, `__Host-heddohon_session=${token}`)).status, 200);
			assert.equal((await home(secure.url, `heddohon_session=${token}`)).status, 303);
			assert.equal((await home(secure.url, null)).status, 303);
		});

		test('is worth nothing after signing out, replayed', async () => {
			const out = await fetch(`${secure.url}/logout`, {
				method: 'POST',
				redirect: 'manual',
				headers: { origin: secure.url, accept: 'text/html', cookie: `__Host-heddohon_session=${token}` }
			});
			assert.equal(out.status, 303);
			assert.equal((await home(secure.url, `__Host-heddohon_session=${token}`)).status, 303);
		});
	});
});

describe('what is kept', () => {
	test('on disk and in the log holds neither the session token nor the password', async () => {
		const response = await signInRaw(app.url);
		const token = cookieOf(response, 'heddohon_session').value;
		assert.equal((await home(app.url, `heddohon_session=${token}`)).status, 200);

		const files = ['heddohon.db', 'heddohon.db-wal'].map((name) => join(app.dataDir, name)).filter(existsSync);
		assert.ok(files.length > 0, 'the database file was not found');
		for (const file of files) {
			const bytes = readFileSync(file);
			assert.ok(!bytes.includes(token), `${file} holds the session token`);
			assert.ok(!bytes.includes('testpass'), `${file} holds the password`);
		}
		assert.ok(!app.output().includes(token), 'the log holds the session token');
		assert.ok(!app.output().includes('testpass'), 'the log holds the password');
	});
});
