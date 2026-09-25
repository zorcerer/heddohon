/**
 * Runs the built app (`build/index.js`) against the mock music servers, and a
 * client that keeps cookies the way a browser does.
 *
 * The app runs as a child process with a data directory of its own, so every
 * run starts with an empty database and cover cache.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const BUILD = resolve(import.meta.dirname, '../../build/index.js');

function freePort() {
	return new Promise((done, fail) => {
		const probe = createServer();
		probe.once('error', fail);
		probe.listen(0, '127.0.0.1', () => {
			const { port } = probe.address();
			probe.close(() => done(port));
		});
	});
}

/** Starts the app and resolves once `/healthz` answers. */
export async function startApp({ subsonicUrl, jellyfinUrl, env = {} }) {
	if (!existsSync(BUILD)) throw new Error('build/index.js is missing. Run `npm run build` first.');
	const port = await freePort();
	const url = `http://127.0.0.1:${port}`;
	const dataDir = mkdtempSync(join(tmpdir(), 'heddohon-e2e-'));

	const child = spawn(process.execPath, [BUILD], {
		env: {
			PATH: process.env.PATH,
			HOST: '127.0.0.1',
			PORT: String(port),
			ORIGIN: url,
			HEDDOHON_SECRET: 'e2e-secret-0123456789abcdef0123456789',
			HEDDOHON_SUBSONIC_URL: subsonicUrl,
			HEDDOHON_JELLYFIN_URL: jellyfinUrl,
			HEDDOHON_DATA_DIR: dataDir,
			HEDDOHON_COOKIE_SECURE: 'false',
			HEDDOHON_LOG_LEVEL: 'warn',
			...env
		},
		stdio: ['ignore', 'pipe', 'pipe']
	});
	let output = '';
	child.stdout.on('data', (chunk) => (output += chunk));
	child.stderr.on('data', (chunk) => (output += chunk));

	const deadline = Date.now() + 15_000;
	for (;;) {
		if (child.exitCode !== null) throw new Error(`The app exited during start-up:\n${output}`);
		try {
			if ((await fetch(`${url}/healthz`)).ok) break;
		} catch {
			// Not listening yet.
		}
		if (Date.now() > deadline) throw new Error(`The app did not answer /healthz within 15s:\n${output}`);
		await new Promise((done) => setTimeout(done, 100));
	}

	return {
		url,
		dataDir,
		output: () => output,
		async stop() {
			if (child.exitCode === null) {
				const exited = new Promise((done) => child.once('exit', done));
				child.kill('SIGTERM');
				await exited;
			}
			rmSync(dataDir, { recursive: true, force: true });
		}
	};
}

/**
 * A browser, as far as the server can tell: it keeps cookies, sends `Origin`
 * on writes, and does not follow redirects, so a test sees each one.
 */
export class Client {
	/** @type {Map<string, string>} */
	cookies = new Map();

	constructor(base) {
		this.base = base;
	}

	async request(path, { method = 'GET', headers = {}, body, origin = this.base } = {}) {
		const sent = { ...headers };
		if (this.cookies.size) sent.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
		if (method !== 'GET' && method !== 'HEAD' && origin !== null && !('origin' in sent)) sent.origin = origin;
		const response = await fetch(this.base + path, { method, headers: sent, body, redirect: 'manual' });
		for (const line of response.headers.getSetCookie()) {
			const [pair, ...attributes] = line.split(';');
			const at = pair.indexOf('=');
			const name = pair.slice(0, at).trim();
			const value = pair.slice(at + 1).trim();
			const expired = attributes.some((a) => /^\s*max-age=0\s*$/i.test(a)) || value === '';
			if (expired) this.cookies.delete(name);
			else this.cookies.set(name, value);
		}
		return response;
	}

	/** GETs a page as a browser navigation and returns the response and its HTML. */
	async page(path) {
		const response = await this.request(path, { headers: { accept: 'text/html' } });
		return { response, html: await response.text() };
	}

	json(path, method, body, extra = {}) {
		return this.request(path, {
			method,
			headers: { 'content-type': 'application/json', accept: 'application/json', ...(extra.headers ?? {}) },
			body: JSON.stringify(body),
			origin: extra.origin
		});
	}

	/**
	 * Signs in through the form action, as the page posts it. `accept:
	 * text/html` matters: without it SvelteKit answers the action as JSON with
	 * a 200, and the redirect cannot be checked.
	 */
	signIn({ username, password, backend, next = '/' }) {
		return this.request('/login', {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'text/html' },
			body: new URLSearchParams({ username, password, backend, next }).toString()
		});
	}
}
