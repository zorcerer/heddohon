/**
 * The desktop shell, driven through Playwright against the built server and
 * the mock music servers of `tests/e2e`.
 *
 *   npm run build              # in the repository root
 *   npm install                # in electron/
 *   xvfb-run -a npm test       # in electron/
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { lstatSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';
import { startApp } from '../../tests/e2e/harness.mjs';
import { startJellyfin, startSubsonic } from '../../tests/e2e/mocks.mjs';
import { startFront } from './front.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const shell = join(here, '..');
const require = createRequire(import.meta.url);
const { originOf, compareVersions, parseHeaders, classify } = require('../lib.js');
/** Under Node the `electron` package is the path of its binary. Playwright looks for it beside itself, which is the repository root. */
const executablePath = require('electron');
/** The packaged app instead, when the suite is pointed at one: `dist/linux-unpacked/heddohon`. */
const packaged = process.env.HEDDOHON_DESKTOP_BINARY || null;

/** Whether an instance still holds the profile: `SingletonLock` is a symbolic link while one does. */
function lockHeld(data) {
	try {
		lstatSync(join(data, 'SingletonLock'));
		return true;
	} catch {
		return false;
	}
}

let subsonic;
let jellyfin;
let server;
let profile;

/** Starts the shell on a profile, with the default browser replaced by a list of what it was asked to open. */
/**
 * Starts the app, once more if the first start gives no window to talk to.
 * In CI a start of the packaged app has twice hung to its timeout, each time
 * straight after another instance closed and with no lock left in the
 * profile; it has not happened in a container here. What it printed is shown,
 * so the next time says why.
 */
async function startShell(options) {
	for (let attempt = 1; ; attempt++) {
		try {
			return await electron.launch(options);
		} catch (err) {
			console.error(`start ${attempt} of the app failed: ${String(err).split('\n').slice(0, 12).join('\n')}`);
			if (attempt === 2) throw err;
			await new Promise((done) => setTimeout(done, 2000));
		}
	}
}

async function launch(data = profile) {
	// One instance per profile: a start while the last one is still on its way
	// out finds its lock and quits. Chromium's lock is a link in the profile.
	for (let i = 0; i < 100 && lockHeld(data); i++) await new Promise((done) => setTimeout(done, 100));
	const app = await startShell({
		executablePath: packaged ?? executablePath,
		// No sandbox: the suite runs in a container without user namespaces.
		args: packaged ? ['--no-sandbox'] : [shell, '--no-sandbox'],
		env: { ...process.env, HEDDOHON_DESKTOP_DATA: data, HEDDOHON_DESKTOP_NO_UPDATE_CHECK: '1' },
		// A start that is going to work has a window within seconds. The default,
		// 3 minutes, is how long a start that quit at once took to be reported.
		timeout: 30_000
	});
	await app.evaluate(({ shell }) => {
		globalThis.__opened = [];
		shell.openExternal = async (url) => void globalThis.__opened.push(url);
	});
	return { app, page: await app.firstWindow() };
}
const opened = (app) => app.evaluate(() => globalThis.__opened);

before(async () => {
	subsonic = await startSubsonic({ artistCount: 5 });
	jellyfin = await startJellyfin();
	server = await startApp({ subsonicUrl: subsonic.url, jellyfinUrl: jellyfin.url, env: { HEDDOHON_REMOTE_CONTROL: 'false' } });
	profile = mkdtempSync(join(tmpdir(), 'heddohon-desktop-'));
});

after(async () => {
	await server?.stop();
	await subsonic?.close();
	await jellyfin?.close();
	if (profile) rmSync(profile, { recursive: true, force: true });
});

describe('the address', () => {
	test('is read as an origin, https unless it says otherwise', () => {
		assert.equal(originOf('music.example.com'), 'https://music.example.com');
		assert.equal(originOf(' http://192.168.1.10:13000/albums?x=1 '), 'http://192.168.1.10:13000');
		assert.equal(originOf('192.168.1.10:13000'), 'https://192.168.1.10:13000');
		assert.equal(originOf('localhost:3000/x'), 'https://localhost:3000');
		assert.equal(originOf('file:///etc/passwd'), null);
		assert.equal(originOf('javascript:alert(1)'), null);
		assert.equal(originOf(''), null);
	});

	test('versions compare by their numbers', () => {
		assert.equal(compareVersions('0.5.0', '0.4.1'), 1);
		assert.equal(compareVersions('v0.10.0', '0.9.9'), 1);
		assert.equal(compareVersions('0.5.0', '0.5.0'), 0);
		assert.equal(compareVersions('0.4.1', '0.5.0'), -1);
	});
});

describe('the shell', () => {
	test('asks for the server on a first run, refuses what is not a Heddohon, then opens it and keeps it', async () => {
		const { app, page } = await launch();
		try {
			await page.getByLabel('Server address').waitFor();
			assert.equal(await page.evaluate(() => typeof window.heddohonDesktop.connect), 'function');

			// Nothing listening there.
			await page.getByLabel('Server address').fill('http://127.0.0.1:9');
			await page.getByRole('button', { name: 'Connect' }).click();
			await page.getByRole('alert').filter({ hasText: 'could not be reached' }).waitFor();

			// A server, but not a Heddohon: a site that answers every address with a page.
			const { createServer } = await import('node:http');
			const site = createServer((_request, response) => response.end('<h1>Some other site</h1>'));
			await new Promise((done) => site.listen(0, '127.0.0.1', done));
			try {
				await page.getByLabel('Server address').fill(`http://127.0.0.1:${site.address().port}`);
				await page.getByRole('button', { name: 'Connect' }).click();
				await page.getByRole('alert').filter({ hasText: 'not as a Heddohon server' }).waitFor();
			} finally {
				site.closeAllConnections();
				site.close();
			}

			// One that turns everyone away with a 401 and nothing to sign in to: the mock music server.
			await page.getByLabel('Server address').fill(subsonic.url);
			await page.getByRole('button', { name: 'Connect' }).click();
			await page.getByRole('alert').filter({ hasText: 'asks for a sign-in this app could not complete' }).waitFor();
			assert.equal(JSON.parse(readFileSync(join(profile, 'config.json'), 'utf8')).server, undefined, 'nothing saved');

			await page.getByLabel('Server address').fill(`${server.url}/albums?from=a-bookmark`);
			await page.getByRole('button', { name: 'Connect' }).click();
			await page.waitForURL(`${server.url}/login**`);
			assert.equal(JSON.parse(readFileSync(join(profile, 'config.json'), 'utf8')).server, server.url);
			// The server's page is given nothing of the desktop.
			assert.equal(await page.evaluate(() => typeof window.heddohonDesktop), 'undefined');
			assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
		} finally {
			await app.close();
		}
	});

	test('starts on the saved server, and sends every other address to the default browser', async () => {
		const { app, page } = await launch();
		try {
			await page.waitForURL(`${server.url}/login**`);
			await page.getByLabel('Username').fill('testuser');
			await page.getByLabel('Password').fill('testpass');
			await page.getByRole('button', { name: /sign in/i }).click();
			await page.waitForURL(`${server.url}/`);

			// A link to another site, in a new tab and in this one.
			await page.evaluate(() => window.open('https://example.com/new-tab'));
			await page.evaluate(() => {
				const link = document.createElement('a');
				link.href = 'https://example.com/same-tab';
				document.body.append(link);
				link.click();
			});
			await page.waitForTimeout(500);
			assert.deepEqual(await opened(app), ['https://example.com/new-tab', 'https://example.com/same-tab']);
			assert.equal(app.windows().length, 1);
			assert.equal(new URL(page.url()).origin, server.url);

			// The page cannot reach the calls the address screen has.
			assert.equal(await page.evaluate(() => typeof window.heddohonDesktop), 'undefined');
		} finally {
			await app.close();
		}
	});

	test('a server that does not answer shows its own offline page once it has been open, and the address screen before that', async () => {
		await server.stop();

		// The profile that has had the server open holds its service worker, which answers with the offline page.
		const known = await launch();
		try {
			await known.page.getByRole('heading', { name: /cannot reach its server/ }).waitFor();
			assert.equal(new URL(known.page.url()).origin, server.url);
		} finally {
			await known.app.close();
		}

		// A profile that only has the address: back to the address screen, with the address kept.
		const fresh = mkdtempSync(join(tmpdir(), 'heddohon-desktop-'));
		writeFileSync(join(fresh, 'config.json'), JSON.stringify({ server: server.url }));
		const { app, page } = await launch(fresh);
		try {
			await page.getByRole('alert').filter({ hasText: 'could not be reached' }).waitFor();
			assert.equal(await page.getByLabel('Server address').inputValue(), server.url);
		} finally {
			await app.close();
			rmSync(fresh, { recursive: true, force: true });
		}
	});
});

/** A WAV of silence, which the element plays and the desktop's media controls see. */
function silentWav(seconds) {
	const rate = 8000;
	const samples = rate * seconds;
	const wav = Buffer.alloc(44 + samples * 2);
	wav.write('RIFF', 0);
	wav.writeUInt32LE(36 + samples * 2, 4);
	wav.write('WAVEfmt ', 8);
	wav.writeUInt32LE(16, 16);
	wav.writeUInt16LE(1, 20);
	wav.writeUInt16LE(1, 22);
	wav.writeUInt32LE(rate, 24);
	wav.writeUInt32LE(rate * 2, 28);
	wav.writeUInt16LE(2, 32);
	wav.writeUInt16LE(16, 34);
	wav.write('data', 36);
	wav.writeUInt32LE(samples * 2, 40);
	return wav;
}

describe('the desktop media controls', () => {
	const dbus = (...args) => execFileSync('dbus-send', ['--session', '--print-reply', ...args], { encoding: 'utf8' });

	test('a playing track is on MPRIS, and its PlayPause pauses it', { skip: !process.env.DBUS_SESSION_BUS_ADDRESS && 'no D-Bus session' }, async () => {
		const backend = await startSubsonic({ artistCount: 3 });
		backend.state.audio = { type: 'audio/wav', body: silentWav(60) };
		const up = await startApp({ subsonicUrl: backend.url, jellyfinUrl: jellyfin.url, env: { HEDDOHON_REMOTE_CONTROL: 'false' } });
		const data = mkdtempSync(join(tmpdir(), 'heddohon-desktop-'));
		writeFileSync(join(data, 'config.json'), JSON.stringify({ server: up.url }));
		const { app, page } = await launch(data);
		try {
			await page.getByLabel('Username').fill('testuser');
			await page.getByLabel('Password').fill('testpass');
			await page.getByRole('button', { name: /sign in/i }).click();
			await page.waitForURL(`${up.url}/`);
			await page.goto(`${up.url}/albums/al1`);
			await page.getByRole('button', { name: 'Play Song 1a', exact: true }).click();
			await page.waitForFunction(() => [...document.querySelectorAll('audio')].some((a) => !a.paused && a.currentTime > 0.5));

			// Chromium names its player after its process.
			let name;
			for (let i = 0; i < 20 && !name; i++) {
				name = /org\.mpris\.MediaPlayer2\.[\w.]+/.exec(dbus('--dest=org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus.ListNames'))?.[0];
				if (!name) await new Promise((done) => setTimeout(done, 250));
			}
			assert.ok(name, 'no MPRIS player on the session bus');
			const metadata = dbus(`--dest=${name}`, '/org/mpris/MediaPlayer2', 'org.freedesktop.DBus.Properties.Get', 'string:org.mpris.MediaPlayer2.Player', 'string:Metadata');
			assert.match(metadata, /Song 1a/);

			dbus(`--dest=${name}`, '/org/mpris/MediaPlayer2', 'org.mpris.MediaPlayer2.Player.PlayPause');
			await page.waitForFunction(() => [...document.querySelectorAll('audio')].every((a) => a.paused));
		} finally {
			await app.close();
			await up.stop();
			await backend.close();
			rmSync(data, { recursive: true, force: true });
		}
	});
});

describe('a newer release', () => {
	/** GitHub's answer for the latest release, from a server of the suite's own. */
	async function releases(tag) {
		const { createServer } = await import('node:http');
		const hits = { count: 0 };
		const mock = createServer((_request, response) => {
			hits.count++;
			response.setHeader('content-type', 'application/json');
			response.end(JSON.stringify({ tag_name: tag }));
		});
		await new Promise((done) => mock.listen(0, '127.0.0.1', done));
		return { url: `http://127.0.0.1:${mock.address().port}/latest`, hits, close: () => new Promise((done) => mock.close(done)) };
	}

	async function start(data, url) {
		const app = await startShell({
			executablePath: packaged ?? executablePath,
			args: packaged ? ['--no-sandbox'] : [shell, '--no-sandbox'],
			env: { ...process.env, HEDDOHON_DESKTOP_DATA: data, HEDDOHON_DESKTOP_RELEASES: url },
			timeout: 30_000
		});
		// In place before the check, which waits 5 seconds after the start.
		await app.evaluate(({ dialog, shell }) => {
			globalThis.__asked = [];
			globalThis.__opened = [];
			dialog.showMessageBox = async (_window, options) => {
				globalThis.__asked.push(options.message);
				return { response: 0 };
			};
			shell.openExternal = async (url) => void globalThis.__opened.push(url);
		});
		return app;
	}
	const menuLabels = (app) =>
		app.evaluate(({ Menu }) => Menu.getApplicationMenu().items[0].submenu.items.map((item) => item.label));

	test('is said once in a dialog, stays in the menu, and Get it opens its page', async () => {
		const mock = await releases('v99.1.0');
		const data = mkdtempSync(join(tmpdir(), 'heddohon-desktop-'));
		try {
			const first = await start(data, mock.url);
			try {
				await first.firstWindow();
				await waitFor(async () => (await first.evaluate(() => globalThis.__asked.length)) === 1);
				assert.deepEqual(await first.evaluate(() => globalThis.__asked), ['Heddohon 99.1.0 is available']);
				assert.deepEqual(await first.evaluate(() => globalThis.__opened), ['https://github.com/zorcerer/heddohon/releases/tag/v99.1.0']);
				assert.ok((await menuLabels(first)).includes('Version 99.1.0 is available'));
			} finally {
				await first.close();
			}

			// The next start: in the menu again, and not said again.
			for (let i = 0; i < 100 && lockHeld(data); i++) await new Promise((done) => setTimeout(done, 100));
			const second = await start(data, mock.url);
			try {
				await second.firstWindow();
				await waitFor(async () => (await menuLabels(second)).includes('Version 99.1.0 is available'));
				assert.deepEqual(await second.evaluate(() => globalThis.__asked), []);
				assert.equal(mock.hits.count, 2);
			} finally {
				await second.close();
			}
		} finally {
			await mock.close();
			rmSync(data, { recursive: true, force: true });
		}
	});

	test('nothing is said for the same or an earlier release, or for an answer that is not a version', async () => {
		for (const tag of ['v0.0.0', 'latest']) {
			const mock = await releases(tag);
			const data = mkdtempSync(join(tmpdir(), 'heddohon-desktop-'));
			const app = await start(data, mock.url);
			try {
				await app.firstWindow();
				await waitFor(() => mock.hits.count === 1);
				await new Promise((done) => setTimeout(done, 500));
				assert.deepEqual(await app.evaluate(() => globalThis.__asked), [], tag);
				assert.ok(!(await menuLabels(app)).some((label) => /is available/.test(label)), tag);
			} finally {
				await app.close();
				await mock.close();
				rmSync(data, { recursive: true, force: true });
			}
		}
	});
});

/** Waits up to 15 seconds for `condition` to hold. */
async function waitFor(condition) {
	for (let i = 0; i < 150; i++) {
		if (await condition()) return;
		await new Promise((done) => setTimeout(done, 100));
	}
	assert.fail('timed out waiting');
}

describe('a server behind a proxy that asks who you are', () => {
	let backend;
	let upstream;

	before(async () => {
		backend = await startSubsonic({ artistCount: 3 });
		upstream = await startApp({ subsonicUrl: backend.url, jellyfinUrl: jellyfin.url, env: { HEDDOHON_REMOTE_CONTROL: 'false' } });
	});

	/** Every proxy a test started, closed at the end whatever the test did: one left listening holds the run open. */
	const fronts = [];

	after(async () => {
		for (const front of fronts) await front.close().catch(() => undefined);
		await upstream?.stop();
		await backend?.close();
	});

	const fresh = () => mkdtempSync(join(tmpdir(), 'heddohon-desktop-'));
	const saved = (data) => JSON.parse(readFileSync(join(data, 'config.json'), 'utf8'));
	const connect = async (page, address) => {
		await page.getByLabel('Server address').fill(address);
		// Pressed from the page: a click through Playwright waits for the navigation it
		// starts, and behind basic auth that one waits for the prompt this test answers.
		await page.locator('#connect').evaluate((button) => button.click());
	};

	test('headers are read one to a line, and the ones the app owns are refused', () => {
		assert.deepEqual(parseHeaders('X-Token: abc\n\n CF-Access-Client-Id:  id.access \n').headers, { 'X-Token': 'abc', 'CF-Access-Client-Id': 'id.access' });
		assert.deepEqual(parseHeaders('').headers, {});
		for (const text of ['Cookie: a=b', 'Host: evil.example', 'Sec-Fetch-Site: none', 'no colon here', 'X-Empty:', 'Bad Name: x']) {
			assert.ok(parseHeaders(text).error, text);
		}
		assert.equal(classify(302, ''), 'sign-in');
		assert.equal(classify(401, ''), 'sign-in');
		assert.equal(classify(200, '{"status":"ok"}'), 'heddohon');
		assert.equal(classify(200, '<html>'), 'other');
		assert.equal(classify(404, ''), 'other');
	});

	test('a sign-in page on another origin is shown in the window, and the server is saved once a Heddohon answers behind it', async () => {
		const front = await startFront(upstream.url, 'sso');
		fronts.push(front);
		const data = fresh();
		const { app, page } = await launch(data);
		try {
			await page.getByLabel('Server address').waitFor();
			await connect(page, front.url);
			// The proxy's page, on its own origin, in this window.
			await page.getByRole('heading', { name: 'Front sign-in' }).waitFor();
			assert.equal(new URL(page.url()).origin, front.signInUrl);
			assert.equal(saved(data).server, undefined, 'not saved before a Heddohon has answered');
			// It is given nothing of the desktop.
			assert.equal(await page.evaluate(() => typeof window.heddohonDesktop), 'undefined');

			await page.getByRole('button', { name: 'Sign in to the front' }).click();
			await page.waitForURL(`${front.url}/login**`);
			await waitFor(() => saved(data).server === front.url);
			assert.deepEqual(await opened(app), [], 'nothing was sent to the default browser');
			assert.equal(app.windows().length, 1);
		} finally {
			await app.close();
		}

		// The next start is signed in already: the cookie is in the profile.
		const again = await launch(data);
		try {
			await again.page.waitForURL(`${front.url}/login**`);
			assert.deepEqual(await opened(again.app), []);
		} finally {
			await again.app.close();
			rmSync(data, { recursive: true, force: true });
		}
	});

	test('a header typed at the address screen goes to the server, is kept, and without it the proxy\'s refusal is explained', async () => {
		const front = await startFront(upstream.url, 'header');
		fronts.push(front);
		const data = fresh();
		const { app, page } = await launch(data);
		try {
			await page.getByLabel('Server address').waitFor();
			await connect(page, front.url);
			await page.getByRole('alert').filter({ hasText: 'asks for a sign-in this app could not complete' }).waitFor();
			assert.equal(front.seen.passed, 0);

			await page.locator('summary').click();
			await page.getByLabel('Request headers').fill('Cookie: front=1');
			await connect(page, front.url);
			await page.getByRole('alert').filter({ hasText: 'set by the app itself' }).waitFor();

			await page.getByLabel('Request headers').fill('X-Front-Token: letmein');
			await connect(page, front.url);
			await page.waitForURL(`${front.url}/login**`);
			assert.equal(saved(data).server, front.url);
			// Every request the page made carried it, its scripts and styles included.
			assert.ok(front.seen.passed > 5 && front.seen.headers.every((headers) => headers['x-front-token'] === 'letmein'));
			// At rest: sealed where the desktop has a keyring, and in a file of the owner's alone where it has none.
			const config = saved(data);
			assert.ok(config.headersSealed || config.headersPlain === 'X-Front-Token: letmein');
			assert.equal(statSync(join(data, 'config.json')).mode & 0o077, 0, 'the profile file is the owner\'s alone');
		} finally {
			await app.close();
		}

		const again = await launch(data);
		try {
			await again.page.waitForURL(`${front.url}/login**`);
		} finally {
			await again.app.close();
			rmSync(data, { recursive: true, force: true });
		}
	});

	test('a basic-auth challenge is answered from a prompt, and a cancelled one is explained', async () => {
		const front = await startFront(upstream.url, 'basic');
		fronts.push(front);
		const data = fresh();
		const { app, page } = await launch(data);
		try {
			await page.getByLabel('Server address').waitFor();
			const prompted = app.waitForEvent('window');
			await connect(page, front.url);
			const prompt = await prompted;
			await prompt.getByText(/asks for a name and password \(front\)/).waitFor();
			await prompt.getByRole('button', { name: 'Cancel' }).click();
			await page.getByRole('alert').filter({ hasText: 'asks for a sign-in this app could not complete' }).waitFor();

			const second = app.waitForEvent('window');
			await connect(page, front.url);
			const again = await second;
			await again.getByLabel('User name').fill('ada');
			await again.getByLabel('Password').fill('lovelace');
			await again.getByRole('button', { name: 'Sign in' }).click();
			await page.waitForURL(`${front.url}/login**`);
			await waitFor(() => saved(data).server === front.url);
			assert.ok(!readFileSync(join(data, 'config.json'), 'utf8').includes('lovelace'), 'the password is not kept');
		} finally {
			await app.close();
			rmSync(data, { recursive: true, force: true });
		}
	});
});
