/**
 * Profile pages in Chromium: the owner picks an album and writes a bio on
 * their own page, and another account sees it under People (`profilepage.ts`).
 *
 *   npm run build && npm run test:browser
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';
import { startApp } from '../e2e/harness.mjs';
import { startJellyfin, startSubsonic } from '../e2e/mocks.mjs';

let subsonic;
let jellyfin;
let app;
let browser;

before(async () => {
	subsonic = await startSubsonic({ artistCount: 10 });
	jellyfin = await startJellyfin();
	app = await startApp({ subsonicUrl: subsonic.url, jellyfinUrl: jellyfin.url, env: { HEDDOHON_REMOTE_CONTROL: 'false' } });
	browser = await chromium.launch();
});

after(async () => {
	await browser?.close();
	await app?.stop();
	await subsonic?.close();
	await jellyfin?.close();
});

async function signedIn(username, password) {
	const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
	const answer = await context.request.post(`${app.url}/login`, {
		form: { username, password, backend: 'subsonic', next: '/' },
		headers: { origin: app.url, accept: 'text/html' },
		maxRedirects: 0
	});
	assert.equal(answer.status(), 303);
	const page = await context.newPage();
	const problems = [];
	page.on('console', (message) => message.type() === 'error' && problems.push(`${page.url()}: ${message.text()}`));
	page.on('pageerror', (err) => problems.push(`${page.url()}: ${err.message}`));
	return { page, problems };
}

test('an album is picked and the page listed, and another account sees it under People', async () => {
	const owner = await signedIn('testuser', 'testpass');
	await owner.page.goto(`${app.url}/people`);
	await owner.page.getByRole('link', { name: 'Your profile' }).first().click();
	await owner.page.getByRole('heading', { name: 'Edit your profile' }).waitFor();

	await owner.page.getByLabel('Search for an album').fill('Album');
	await owner.page.getByRole('button', { name: /Album 3/ }).click();
	await owner.page.getByRole('textbox', { name: /Bio/ }).fill('Records I keep coming back to.');
	await owner.page.getByLabel(/The other accounts on this server/).check();
	await owner.page.getByRole('button', { name: 'Save', exact: true }).click();
	await owner.page.getByText('Saved.').waitFor();
	const tile = owner.page.locator('.favourites li').first();
	await tile.getByText('Album 3').waitFor();
	// Read through the owner's credential by its place on the page.
	await tile.locator('img').evaluate(
		(img) => new Promise((done, fail) => (img.complete && img.naturalWidth > 0 ? done(true) : ((img.onload = done), (img.onerror = fail))))
	);

	const other = await signedIn('seconduser', 'secondpass');
	await other.page.goto(`${app.url}/people`);
	await other.page.getByRole('link', { name: /testuser/ }).click();
	await other.page.getByText('Records I keep coming back to.').waitFor();
	await other.page.locator('.favourites').getByText('Album 3').waitFor();
	assert.equal(await other.page.getByRole('heading', { name: 'Edit your profile' }).count(), 0);

	assert.deepEqual([...owner.problems, ...other.problems], []);
});
