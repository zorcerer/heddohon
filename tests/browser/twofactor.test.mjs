/**
 * The second factor in Chromium (issue #225): an authenticator app set up
 * from Settings, Security, with its QR code read back; a passkey made there
 * on a virtual authenticator (DevTools' WebAuthn domain); and both ways in
 * from the sign-in page with it.
 *
 *   npm run build && npm run test:browser
 *
 * The app is opened on `localhost`, where Chromium allows passkeys over
 * plain http. Reading the QR code back needs `zbarimg` (zbar-tools); without
 * it that one check is skipped.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';
import { startApp } from '../e2e/harness.mjs';
import { startJellyfin, startSubsonic } from '../e2e/mocks.mjs';

let subsonic;
let jellyfin;
let app;
let browser;
let context;
let page;
const problems = [];

const zbar = (() => {
	try {
		execFileSync('zbarimg', ['--version'], { stdio: 'ignore' });
		return true;
	} catch {
		return false;
	}
})();

before(async () => {
	subsonic = await startSubsonic({ artistCount: 5 });
	jellyfin = await startJellyfin();
	app = await startApp({
		subsonicUrl: subsonic.url,
		jellyfinUrl: jellyfin.url,
		host: 'localhost',
		env: { HEDDOHON_REMOTE_CONTROL: 'false' }
	});
	browser = await chromium.launch();
	context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
	page = await context.newPage();
	page.on('console', (message) => {
		// The browser reports each refused sign-in request (a 401) on the console.
		if (message.type() === 'error' && !/status of 40[13]/.test(message.text())) problems.push(`${page.url()}: ${message.text()}`);
	});
	page.on('pageerror', (err) => problems.push(`${page.url()}: ${err.message}`));
	const cdp = await context.newCDPSession(page);
	await cdp.send('WebAuthn.enable');
	await cdp.send('WebAuthn.addVirtualAuthenticator', {
		options: {
			protocol: 'ctap2',
			transport: 'internal',
			hasResidentKey: true,
			hasUserVerification: true,
			isUserVerified: true,
			automaticPresenceSimulation: true
		}
	});
});

after(async () => {
	await browser?.close();
	await app?.stop();
	await subsonic?.close();
	await jellyfin?.close();
});

function totp(secret) {
	const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
	let bits = 0;
	let value = 0;
	const key = [];
	for (const char of secret.replace(/\s/g, '')) {
		value = (value << 5) | alphabet.indexOf(char);
		bits += 5;
		if (bits >= 8) {
			key.push((value >>> (bits - 8)) & 0xff);
			bits -= 8;
		}
	}
	const counter = Buffer.alloc(8);
	counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
	const mac = createHmac('sha1', Buffer.from(key)).update(counter).digest();
	const offset = mac[mac.length - 1] & 0x0f;
	return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1e6).padStart(6, '0');
}

async function signInWithPassword() {
	await page.goto(`${app.url}/login`);
	await page.getByLabel('Username').fill('testuser');
	await page.getByLabel('Password').fill('testpass');
	await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

let secret;
let codes;

test('an authenticator app is set up from Settings, with a QR code that reads back as its address', async () => {
	await signInWithPassword();
	await page.waitForURL((url) => url.pathname === '/');
	await page.goto(`${app.url}/settings?tab=security`);
	await page.getByRole('button', { name: 'Set up' }).click();
	await page.getByLabel(/Your password for/).fill('testpass');
	await page.getByRole('button', { name: 'Confirm' }).click();

	const qr = page.getByRole('img', { name: 'QR code for your authenticator app' });
	await qr.waitFor();
	secret = (await page.locator('.secret').textContent()).replace(/\s/g, '');
	assert.match(secret, /^[A-Z2-7]{32}$/);

	if (zbar) {
		const file = join(mkdtempSync(join(tmpdir(), 'hh-qr-')), 'qr.png');
		writeFileSync(file, await qr.screenshot());
		const read = execFileSync('zbarimg', ['-q', '--raw', file]).toString().trim();
		assert.equal(read, `otpauth://totp/Heddohon:testuser?secret=${secret}&issuer=Heddohon&algorithm=SHA1&digits=6&period=30`);
	}

	await page.getByLabel('Code from the app').fill(totp(secret));
	await page.getByRole('button', { name: 'Turn on' }).click();
	await page.getByText('Your recovery codes').waitFor();
	codes = await page.locator('.code-list li').allTextContents();
	assert.equal(codes.length, 10);
	await page.getByRole('button', { name: 'I have saved them' }).click();
	await page
		.locator('.block', { has: page.getByRole('heading', { name: 'Authenticator app' }) })
		.getByRole('button', { name: 'Remove' })
		.waitFor();
});

test('a passkey is added from Settings with a recovery code as the proof', async () => {
	await page.getByPlaceholder('Laptop, phone, key…').fill('Virtual key');
	await page.getByRole('button', { name: 'Add a passkey' }).click();
	// The app's code was taken a moment ago and is taken once: a recovery code.
	await page.getByLabel(/Code from your app, or a recovery code/).fill(codes[0]);
	await page.getByRole('button', { name: 'Confirm', exact: true }).click();
	await page.getByText(/^Passkey added\./).waitFor();
	await page.getByText('Virtual key').waitFor();
});

test('the sign-in page asks for the second factor after the password, and a passkey gives it', async () => {
	await context.clearCookies();
	await signInWithPassword();
	await page.locator('input[name=code]').waitFor();
	assert.equal(new URL(page.url()).pathname, '/login');
	await page.getByRole('button', { name: 'Use a passkey' }).click();
	await page.waitForURL((url) => url.pathname === '/');
});

test('a recovery code completes the second step', async () => {
	await context.clearCookies();
	await signInWithPassword();
	await page.getByRole('button', { name: 'Use a recovery code' }).click();
	await page.getByLabel('Recovery code').fill(codes[1]);
	await page.getByRole('button', { name: 'Verify' }).click();
	await page.waitForURL((url) => url.pathname === '/');
});

test('a passkey signs in on its own from the sign-in page', async () => {
	await context.clearCookies();
	await page.goto(`${app.url}/login`);
	await page.getByRole('button', { name: 'Sign in with a passkey' }).click();
	await page.waitForURL((url) => url.pathname === '/');
	assert.deepEqual(problems, []);
});
