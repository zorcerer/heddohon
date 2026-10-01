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
import { lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';
import { startApp } from '../../tests/e2e/harness.mjs';
import { startJellyfin, startSubsonic } from '../../tests/e2e/mocks.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const shell = join(here, '..');
const require = createRequire(import.meta.url);
const { originOf, compareVersions } = require('../lib.js');
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
async function launch(data = profile) {
	// One instance per profile: a start while the last one is still on its way
	// out finds its lock and quits. Chromium's lock is a link in the profile.
	for (let i = 0; i < 100 && lockHeld(data); i++) await new Promise((done) => setTimeout(done, 100));
	const app = await electron.launch({
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

			// A server, but not a Heddohon: the mock music server.
			await page.getByLabel('Server address').fill(subsonic.url);
			await page.getByRole('button', { name: 'Connect' }).click();
			await page.getByRole('alert').filter({ hasText: 'not as a Heddohon server' }).waitFor();

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
