/**
 * Single sign-on in Chromium (issue #202): linking from Settings, Security,
 * signing in from the sign-in page, and the second step after the provider.
 *
 *   npm run build && npm run test:browser
 *
 * The app is opened on `localhost` and the provider on `127.0.0.1`, two
 * sites, and the provider sends the browser back by a link on its own page.
 * That is what a real provider does, and it is what decides which of the
 * app's cookies come back with the return: the pending sign-in's
 * (`SameSite=Lax`) does, the second step's (`Strict`) does not on a redirect.
 */
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';
import { startApp } from '../e2e/harness.mjs';
import { startJellyfin, startSubsonic } from '../e2e/mocks.mjs';
import { CLIENT_ID, CLIENT_SECRET, startProvider } from '../e2e/oidcprovider.mjs';

let subsonic;
let jellyfin;
let provider;
let app;
let browser;
let context;
let page;
const problems = [];

before(async () => {
	subsonic = await startSubsonic({ artistCount: 5 });
	jellyfin = await startJellyfin();
	provider = await startProvider({ page: true });
	app = await startApp({
		subsonicUrl: subsonic.url,
		jellyfinUrl: jellyfin.url,
		host: 'localhost',
		env: {
			HEDDOHON_REMOTE_CONTROL: 'false',
			HEDDOHON_OIDC_ISSUER: provider.state.url,
			HEDDOHON_OIDC_CLIENT_ID: CLIENT_ID,
			HEDDOHON_OIDC_CLIENT_SECRET: CLIENT_SECRET,
			HEDDOHON_OIDC_LABEL: 'Pocket ID'
		}
	});
	browser = await chromium.launch();
	context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
	page = await context.newPage();
	page.on('console', (message) => {
		if (message.type() === 'error') problems.push(`${page.url()}: ${message.text()}`);
	});
	page.on('pageerror', (err) => problems.push(`${page.url()}: ${err.message}`));
});

after(async () => {
	await browser?.close();
	await app?.stop();
	await subsonic?.close();
	await jellyfin?.close();
	await provider?.close();
});

/** Through the provider's page and back. */
async function atProvider() {
	await page.waitForURL((url) => url.origin === provider.state.url);
	await page.getByRole('link', { name: 'Continue' }).click();
}

test('an account links its identity from Settings, Security', async () => {
	await page.goto(`${app.url}/login`);
	await page.getByLabel('Username').fill('testuser');
	await page.getByLabel('Password').fill('testpass');
	await page.getByRole('button', { name: 'Sign in', exact: true }).click();
	await page.waitForURL((url) => url.pathname === '/');

	await page.goto(`${app.url}/settings?tab=security`);
	await page.getByRole('button', { name: 'Link Pocket ID' }).click();
	await page.getByLabel(/Your password for/).fill('testpass');
	await page.getByRole('button', { name: 'Confirm' }).click();
	await atProvider();
	await page.getByText(/^Linked\. “Sign in with Pocket ID”/).waitFor();
	// The result is taken off the address once shown.
	assert.equal(new URL(page.url()).search, '?tab=security');
	await page.getByRole('button', { name: 'Unlink' }).waitFor();
});

test('the sign-in page signs in through the provider', async () => {
	await context.clearCookies();
	await page.goto(`${app.url}/login?next=%2Falbums`);
	await page.getByRole('link', { name: 'Sign in with Pocket ID' }).click();
	await atProvider();
	await page.waitForURL((url) => url.pathname === '/albums');
});

test('an account with a second factor is asked for it after the provider', async () => {
	const origin = { origin: app.url };
	const started = await (
		await page.request.post(`${app.url}/api/two-factor`, { headers: origin, data: { action: 'totp-start', proof: { password: 'testpass' } } })
	).json();
	const code = () => {
		const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
		let bits = 0;
		let value = 0;
		const key = [];
		for (const char of started.secret) {
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
		const at = mac[mac.length - 1] & 0x0f;
		return String((mac.readUInt32BE(at) & 0x7fffffff) % 1e6).padStart(6, '0');
	};
	const confirmed = await page.request.post(`${app.url}/api/two-factor`, { headers: origin, data: { action: 'totp-confirm', code: code() } });
	assert.equal(confirmed.status(), 200);
	const [recovery] = (await confirmed.json()).recoveryCodes;

	await context.clearCookies();
	await page.goto(`${app.url}/login`);
	await page.getByRole('link', { name: 'Sign in with Pocket ID' }).click();
	await atProvider();
	await page.getByText('Signing in as').waitFor();
	assert.equal(new URL(page.url()).pathname, '/login');
	// The app's code was taken by the confirmation a moment ago, and is taken once.
	await page.getByRole('button', { name: 'Use a recovery code' }).click();
	await page.getByLabel('Recovery code').fill(recovery);
	await page.getByRole('button', { name: 'Verify' }).click();
	await page.waitForURL((url) => url.pathname === '/');
	assert.deepEqual(problems, []);
});
