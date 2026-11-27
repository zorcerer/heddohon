/**
 * Menus and picking songs, the first-run setup page, features that are off, sound analysis, colour schemes from a file, and settings saved as they change.
 *
 *   npm run build
 *   node --test tests/browser/menus-and-setup.test.mjs
 *
 * Runs the built app against the mock servers of `tests/e2e`; see `suite.mjs`.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { startApp } from '../e2e/harness.mjs';
import { silentWav } from '../e2e/mocks.mjs';
import { subsonic, jellyfin, app, browser, context, select, pick, autosaved, shown, watchedPage, setUpSuite } from './suite.mjs';

setUpSuite();

describe('the menu on a right click', () => {
	const menu = (page) => page.getByRole('menu');
	const item = (page, name) => menu(page).getByRole('menuitem', { name, exact: true });
	const names = (page) => menu(page).getByRole('menuitem').allTextContents().then((all) => all.map((text) => text.trim()));
	const playing = (page) => page.waitForFunction(() => [...document.querySelectorAll('audio')].some((a) => !a.paused && a.currentTime > 0));

	/*
	 * Svelte Bits' motion on the menu: its items come in as AnimatedList's rows
	 * do, and one highlight glides between them as GlideSelect's does, rather
	 * than each item lighting on its own.
	 */
	test('its items come in on opening, and one highlight glides from item to item', async () => {
		const { page, problems } = await watchedPage();
		try {
			await page.goto(app.url + '/albums/al1', { waitUntil: 'networkidle' });
			await page.locator('.track').first().locator('.title').click({ button: 'right' });
			const entering = await menu(page).evaluate((el) => el.getAnimations({ subtree: true }).filter((a) => a.animationName?.endsWith('item-in')).length);
			assert.ok(entering >= 4, `${entering} items came in`);

			const glide = menu(page).locator('.glide');
			const at = () => glide.evaluate((el) => ({ y: new DOMMatrix(getComputedStyle(el).transform).f, shown: getComputedStyle(el).opacity }));
			const top = (name) => item(page, name).evaluate((el) => el.offsetTop);
			// The first time, it appears where it is wanted, without travelling.
			await item(page, 'Play').hover();
			await page.waitForFunction(() => getComputedStyle(document.querySelector('[role="menu"] .glide')).opacity === '1');
			assert.equal((await at()).y, await top('Play'));
			// The next, it glides.
			await item(page, 'Add to queue').hover();
			const moving = await glide.evaluate((el) => el.getAnimations().some((a) => a instanceof CSSTransition && a.transitionProperty === 'transform'));
			assert.ok(moving, 'the highlight jumped instead of gliding');
			await page.waitForFunction((y) => new DOMMatrix(getComputedStyle(document.querySelector('[role="menu"] .glide')).transform).f === y, await top('Add to queue'));
			await page.keyboard.press('Escape');
		} finally {
			await page.close();
		}
		assert.deepEqual(problems, []);
	});

	test('a song row opens a menu of what can be done with it, and Play next puts it after the one playing', async () => {
		subsonic.state.albumSongs = 4;
		subsonic.state.audio = { type: 'audio/wav', body: silentWav(30) };
		const { page, problems } = await watchedPage();
		try {
			// An album no other test has opened: the server holds an album it has read, with the two tracks it had.
			await page.goto(app.url + '/albums/al17', { waitUntil: 'networkidle' });
			await page.getByRole('button', { name: 'Play Song 17a', exact: true }).click();
			await playing(page);

			const row = page.locator('.track', { hasText: 'Song 17d' });
			await row.locator('.title').click({ button: 'right' });
			assert.equal(await menu(page).getAttribute('aria-label'), 'Song: Song 17d');
			const offered = await names(page);
			assert.deepEqual(offered.slice(0, 6), ['Play', 'Play next', 'Add to queue', 'Add to playlist…', 'Add to favourites', 'Start instant mix']);
			// On the album's own page there is nowhere for "Go to album" to go.
			assert.ok(offered.includes('Go to artist') && !offered.includes('Go to album'), offered.join(', '));
			assert.equal(await row.getAttribute('data-menu-open'), '', 'the row is not marked while its menu is open');

			await item(page, 'Play next').click();
			assert.equal(await menu(page).count(), 0, 'the menu stayed after a choice');
			assert.equal(await row.getAttribute('data-menu-open'), null);
			await page.locator('aside.panel button[aria-label="Next track"]').click();
			await page.waitForFunction(() => document.querySelector('.track.current .title')?.textContent === 'Song 17d');

			// The heart in the menu and the one on the row are one state.
			const second = page.locator('.track', { hasText: 'Song 17b' });
			await second.locator('.title').click({ button: 'right' });
			await item(page, 'Add to favourites').click();
			await second.locator('button[aria-pressed="true"]').waitFor();
			await second.locator('.title').click({ button: 'right' });
			await item(page, 'Remove from favourites').click();
			await second.locator('button[aria-pressed="false"]').first().waitFor();

			// A press anywhere else closes it.
			await second.locator('.title').click({ button: 'right' });
			await menu(page).waitFor();
			await page.locator('h1').click();
			assert.equal(await menu(page).count(), 0, 'a press outside left the menu open');
		} finally {
			subsonic.state.albumSongs = 2;
			subsonic.state.audio = null;
			subsonic.state.starred.clear();
			await page.close();
		}
		assert.deepEqual(problems, []);
	});

	test('the menu key opens it on a focused row, the arrow keys move in it, and Escape returns the focus', async () => {
		const { page, problems } = await watchedPage();
		try {
			await page.goto(app.url + '/albums/al1', { waitUntil: 'networkidle' });
			const row = page.locator('.track').first();
			await row.focus();
			await page.keyboard.press('ContextMenu');
			await menu(page).waitFor();
			const focused = () => page.evaluate(() => (document.activeElement?.getAttribute('role') === 'menuitem' ? document.activeElement.textContent.trim() : document.activeElement?.tagName));
			const all = await names(page);
			assert.equal(await focused(), all[0]);
			await page.keyboard.press('ArrowDown');
			assert.equal(await focused(), all[1]);
			await page.keyboard.press('End');
			assert.equal(await focused(), all.at(-1));
			// On round to the stars under the name, the first stop, then the first item.
			await page.keyboard.press('ArrowDown');
			assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('role')), 'menuitemradio', 'the last item does not lead on to the stars');
			await page.keyboard.press('ArrowDown');
			assert.equal(await focused(), all[0], 'the stars do not lead on to the first item');
			// Over the row, and inside the window.
			const [box, at] = [await menu(page).boundingBox(), await row.boundingBox()];
			assert.ok(box.x >= at.x && box.x <= at.x + at.width && box.y >= at.y && box.y <= at.y + at.height + 1, JSON.stringify([box, at]));
			await page.keyboard.press('Escape');
			assert.equal(await menu(page).count(), 0);
			assert.ok(await row.evaluate((el) => el === document.activeElement), 'the focus did not go back to the row');

			// With Shift held the click is the browser's: no menu, and the event is not taken.
			const taken = page.evaluate(() => new Promise((done) => addEventListener('contextmenu', (event) => setTimeout(() => done(event.defaultPrevented)), { once: true })));
			await row.locator('.title').click({ button: 'right', modifiers: ['Shift'] });
			assert.equal(await taken, false);
			assert.equal(await menu(page).count(), 0);
		} finally {
			await page.close();
		}
		assert.deepEqual(problems, []);
	});

	test('an album card opens a menu that plays the album and goes to it without a page load, and it stays inside the window', async () => {
		subsonic.state.audio = { type: 'audio/wav', body: silentWav(30) };
		const { page, problems } = await watchedPage();
		try {
			// A window a menu does not fit under the pointer in.
			await page.setViewportSize({ width: 1100, height: 520 });
			await page.goto(app.url + '/albums', { waitUntil: 'networkidle' });
			const card = page.locator('a.card').first();
			const id = (await card.getAttribute('href')).replace('/albums/al', '');
			// In the upper right corner of the card: under 250px are left below it.
			const at = await card.boundingBox();
			await card.click({ button: 'right', position: { x: at.width - 6, y: 30 } });
			await menu(page).waitFor();
			assert.equal(await menu(page).getAttribute('aria-label'), `Album: Album ${id}`);
			assert.deepEqual((await names(page)).slice(0, 4), ['Play', 'Shuffle', 'Play next', 'Add to queue']);
			const box = await menu(page).boundingBox();
			assert.ok(box.x >= 8 && box.y >= 8 && box.x + box.width <= 1100 - 7 && box.y + box.height <= 520 - 7, `the menu is at ${JSON.stringify(box)} in 1100x520`);

			await item(page, 'Play').click();
			await playing(page);
			assert.equal(await page.locator('aside.panel h2.title').getAttribute('data-text'), `Song ${id}a`);

			await page.evaluate(() => (window.__sameDocument = true));
			// The first track opens the player, the page beside it is laid out
			// again and its column scrolls to keep its place. A menu opened in
			// the middle of that is closed by the scroll, as it is meant to be
			// (CI, 2026-10-13), so the page is left to settle first.
			await page.waitForFunction(() => document.querySelector('.app')?.classList.contains('panel-in'));
			await page.waitForTimeout(900);
			await card.scrollIntoViewIfNeeded();
			await page.waitForTimeout(400);
			await card.click({ button: 'right' });
			await menu(page).waitFor();
			await item(page, 'Go to album').click();
			await page.waitForURL(`${app.url}/albums/al${id}`);
			assert.equal(await menu(page).count(), 0, 'the menu followed the page');
			assert.equal(await page.evaluate(() => window.__sameDocument), true, 'the page was loaded again');
			assert.ok(await page.evaluate(() => [...document.querySelectorAll('audio')].some((a) => !a.paused)), 'the track stopped');
		} finally {
			subsonic.state.audio = null;
			await page.close();
		}
		assert.deepEqual(problems, []);
	});

	test('the lines of the lyrics are centred in the player', async () => {
		subsonic.state.audio = { type: 'audio/wav', body: silentWav(30) };
		subsonic.state.lyrics.set('s1a', [
			{ start: 0, value: 'A first line' },
			{ start: 20_000, value: 'A second line, long enough that it is broken over two lines in a column this narrow' }
		]);
		const { page, problems } = await watchedPage();
		try {
			await page.goto(app.url + '/albums/al1', { waitUntil: 'networkidle' });
			await page.getByRole('button', { name: 'Play Song 1a', exact: true }).click();
			await playing(page);
			await page.locator('aside.panel button[aria-label="Lyrics"]').click();
			const line = page.locator('aside.panel .line', { hasText: 'A first line' });
			await line.waitFor();
			assert.equal(await line.evaluate((el) => getComputedStyle(el).textAlign), 'center');
			// The words are in the middle of the column, to a pixel or two.
			const offset = await line.evaluate((el) => {
				const range = document.createRange();
				range.selectNodeContents(el);
				const [text, box] = [range.getBoundingClientRect(), el.getBoundingClientRect()];
				return text.left + text.width / 2 - (box.left + box.width / 2);
			});
			assert.ok(Math.abs(offset) <= 2, `the line is ${offset}px off the middle`);
		} finally {
			subsonic.state.audio = null;
			subsonic.state.lyrics.clear();
			await page.close();
		}
		assert.deepEqual(problems, []);
	});
});

describe('picking several songs', () => {
	const bar = (page) => page.getByRole('toolbar');
	const picked = (page) =>
		page.evaluate(() => [...document.querySelectorAll('main .track.selected .title')].map((el) => el.textContent));
	const row = (page, title) => page.locator('main .track', { hasText: title });

	test('Ctrl and Shift with a click pick rows, the bar and the menu act on them, and Escape lets go', async () => {
		subsonic.state.albumSongs = 4;
		subsonic.state.audio = { type: 'audio/wav', body: silentWav(30) };
		const { page, problems } = await watchedPage();
		try {
			await page.goto(app.url + '/albums/al27', { waitUntil: 'networkidle' });
			await row(page, 'Song 27a').locator('.title').click({ modifiers: ['ControlOrMeta'] });
			await row(page, 'Song 27c').locator('.title').click({ modifiers: ['Shift'] });
			assert.deepEqual(await picked(page), ['Song 27a', 'Song 27b', 'Song 27c']);
			assert.equal(await bar(page).getAttribute('aria-label'), '3 songs selected');
			// Shift did not select the text between the two clicks.
			assert.equal(await page.evaluate(() => getSelection()?.toString()), '');
			await row(page, 'Song 27b').locator('.title').click({ modifiers: ['ControlOrMeta'] });
			assert.deepEqual(await picked(page), ['Song 27a', 'Song 27c']);
			assert.equal(await page.evaluate(() => [...document.querySelectorAll('audio')].some((a) => !a.paused)), false, 'a pick played a row');

			// The menu on a picked row is for both.
			await row(page, 'Song 27c').locator('.title').click({ button: 'right' });
			const menu = page.getByRole('menu');
			assert.equal(await menu.getAttribute('aria-label'), 'Selection: 2 songs');
			assert.deepEqual(
				(await menu.getByRole('menuitem').allTextContents()).map((text) => text.trim()),
				['Play', 'Play next', 'Add to queue', 'Add to playlist…', 'Add to favourites']
			);
			await menu.getByRole('menuitem', { name: 'Add to favourites', exact: true }).click();
			assert.equal(await bar(page).count(), 0, 'the selection stayed after an action');
			await page.waitForFunction(() => document.querySelectorAll('main .track button[aria-pressed="true"]').length === 2);
			assert.deepEqual([...subsonic.state.starred.keys()].filter((id) => id.startsWith('s27')).sort(), ['s27a', 's27c']);

			// The bar's Play makes the picked rows the queue.
			await row(page, 'Song 27b').locator('.title').click({ modifiers: ['ControlOrMeta'] });
			await row(page, 'Song 27d').locator('.title').click({ modifiers: ['ControlOrMeta'] });
			await bar(page).getByRole('button', { name: 'Play', exact: true }).click();
			await page.waitForFunction(() => document.querySelector('aside.panel h2.title')?.getAttribute('data-text') === 'Song 27b');
			assert.equal(await page.evaluate(() => document.querySelector('aside.panel button[aria-label="Queue"] .count')?.textContent), '2');

			// A plain click lets go, and so does Escape.
			await row(page, 'Song 27a').locator('.title').click({ modifiers: ['ControlOrMeta'] });
			await row(page, 'Song 27b').locator('.title').click();
			assert.deepEqual(await picked(page), []);
			await row(page, 'Song 27a').locator('.title').click({ modifiers: ['ControlOrMeta'] });
			await page.keyboard.press('Escape');
			assert.equal(await bar(page).count(), 0);
		} finally {
			subsonic.state.albumSongs = 2;
			subsonic.state.audio = null;
			for (const id of ['s27a', 's27c']) subsonic.state.starred.delete(id);
			await page.close();
		}
		assert.deepEqual(problems, []);
	});

	test('from the keyboard: Shift and the arrows pick, Space picks one, Ctrl+A picks the list, and none of them plays', async () => {
		subsonic.state.albumSongs = 4;
		const { page, problems } = await watchedPage();
		try {
			await page.goto(app.url + '/albums/al28', { waitUntil: 'networkidle' });
			await row(page, 'Song 28a').focus();
			await page.keyboard.press('ArrowDown');
			assert.equal(await page.evaluate(() => document.activeElement?.querySelector('.title')?.textContent), 'Song 28b');
			await page.keyboard.press('Shift+ArrowDown');
			await page.keyboard.press('Shift+ArrowDown');
			assert.deepEqual(await picked(page), ['Song 28b', 'Song 28c', 'Song 28d']);
			assert.equal(await page.evaluate(() => document.activeElement?.querySelector('.title')?.textContent), 'Song 28d');
			await page.keyboard.press('Space');
			assert.deepEqual(await picked(page), ['Song 28b', 'Song 28c']);
			await page.keyboard.press('ControlOrMeta+a');
			assert.equal((await picked(page)).length, 4);
			assert.equal(await page.evaluate(() => [...document.querySelectorAll('audio')].some((a) => !a.paused)), false, 'Space played');
			await page.keyboard.press('Escape');
			assert.deepEqual(await picked(page), []);
		} finally {
			subsonic.state.albumSongs = 2;
			await page.close();
		}
		assert.deepEqual(problems, []);
	});

	test('picked rows of a playlist are removed in one go, from the bar', async () => {
		subsonic.state.playlistEntries = ['s1a', 's2a', 's3a', 's4a'];
		const { page, problems } = await watchedPage();
		try {
			await page.goto(app.url + '/playlists/pl1', { waitUntil: 'networkidle' });
			await row(page, 'Song 1a').locator('.title').click({ modifiers: ['ControlOrMeta'] });
			await row(page, 'Song 3a').locator('.title').click({ modifiers: ['ControlOrMeta'] });
			const removed = page.waitForResponse((r) => r.request().method() === 'DELETE' && r.url().endsWith('/tracks'));
			await bar(page).getByRole('button', { name: 'Remove from this playlist', exact: true }).click();
			assert.deepEqual((await removed).request().postDataJSON(), { indices: [2, 0] });
			// One call to the music server, which the mock records and does not apply.
			assert.deepEqual(subsonic.state.playlistUpdates.at(-1), { id: 'pl1', add: [], remove: [2, 0] });
			await bar(page).waitFor({ state: 'detached' });
		} finally {
			subsonic.state.playlistEntries = ['s1a', 's2a'];
			await page.close();
		}
		assert.deepEqual(problems, []);
	});

	test('entries of the queue are picked and removed together, the playing one with them', async () => {
		subsonic.state.albumSongs = 4;
		subsonic.state.audio = { type: 'audio/wav', body: silentWav(30) };
		const { page, problems } = await watchedPage();
		try {
			await page.goto(app.url + '/albums/al29', { waitUntil: 'networkidle' });
			await page.getByRole('button', { name: 'Play Song 29a', exact: true }).click();
			await page.waitForFunction(() => [...document.querySelectorAll('audio')].some((a) => !a.paused && a.currentTime > 0));
			await page.locator('aside.panel button[aria-label="Queue"]').click();
			const entry = (title) => page.locator('aside.panel .queue-list .row', { hasText: title });
			await entry('Song 29a').locator('.row-text').click({ modifiers: ['ControlOrMeta'] });
			await entry('Song 29c').locator('.row-text').click({ modifiers: ['ControlOrMeta'] });
			assert.equal(await page.locator('aside.panel .queue-list .row.selected').count(), 2);
			await bar(page).getByRole('button', { name: 'Remove from the queue', exact: true }).click();
			await page.waitForFunction(
				() => [...document.querySelectorAll('aside.panel .queue-list .row-title')].map((el) => el.textContent).join() === 'Song 29b,Song 29d'
			);
			// The playing track went, and the next that stayed took its place.
			await page.waitForFunction(() => document.querySelector('aside.panel h2.title')?.getAttribute('data-text') === 'Song 29b');
		} finally {
			subsonic.state.albumSongs = 2;
			subsonic.state.audio = null;
			await page.close();
		}
		assert.deepEqual(problems, []);
	});

	test('on a phone a long press picks a row, a tap then picks another, and the bar sits above the dock', async () => {
		subsonic.state.albumSongs = 4;
		const phone = await browser.newContext({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true });
		try {
			const signIn = await phone.request.post(`${app.url}/login`, {
				form: { username: 'testuser', password: 'testpass', backend: 'subsonic', next: '/' },
				headers: { origin: app.url, accept: 'text/html' },
				maxRedirects: 0
			});
			assert.equal(signIn.status(), 303);
			const page = await phone.newPage();
			const problems = [];
			page.on('pageerror', (err) => problems.push(err.message));
			await page.goto(app.url + '/albums/al30', { waitUntil: 'networkidle' });
			const title = (name) => row(page, name).locator('.title');
			await title('Song 30a').evaluate((el) => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
			const box = await title('Song 30a').boundingBox();
			const cdp = await phone.newCDPSession(page);
			const at = { x: box.x + 20, y: box.y + box.height / 2 };
			await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [at] });
			await page.waitForTimeout(700);
			await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
			await page.waitForTimeout(100);
			assert.deepEqual(await picked(page), ['Song 30a']);

			const tapOn = async (name) => {
				const b = await title(name).boundingBox();
				await page.touchscreen.tap(b.x + 20, b.y + b.height / 2);
			};
			await tapOn('Song 30c');
			assert.deepEqual(await picked(page), ['Song 30a', 'Song 30c']);
			await tapOn('Song 30a');
			assert.deepEqual(await picked(page), ['Song 30c']);
			assert.equal(await page.evaluate(() => [...document.querySelectorAll('audio')].some((a) => !a.paused)), false, 'a tap played a row');

			const [barBox, dockBox] = [await bar(page).boundingBox(), await page.locator('.phone-dock').boundingBox()];
			assert.ok(barBox.y + barBox.height <= dockBox.y + 1, `the bar (${JSON.stringify(barBox)}) is not above the dock (${JSON.stringify(dockBox)})`);
			assert.deepEqual(problems, []);
		} finally {
			subsonic.state.albumSongs = 2;
			await phone.close();
		}
	});
});

describe('the first-run setup page', () => {
	/*
	 * An app of its own, started without its secret or its music server. The
	 * page is walked as an operator would: the code from the log, an address
	 * tested and saved, and what the last step says about the key.
	 */
	test('takes the code from the log, tests and saves a music server, and says whose the key is to keep', async () => {
		// As the image runs on a local network: production, plain http, and no
		// ORIGIN, which `undefined` leaves out of the app's environment.
		const fresh = await startApp({
			env: { HEDDOHON_SECRET: '', HEDDOHON_SUBSONIC_URL: '', HEDDOHON_JELLYFIN_URL: '', HEDDOHON_DEFAULT_THEME: '', ORIGIN: undefined, NODE_ENV: 'production', HEDDOHON_COOKIE_SECURE: '' }
		});
		const visitor = await browser.newContext({ viewport: { width: 1100, height: 900 } });
		const page = await visitor.newPage();
		const problems = [];
		// A refused code is a 401, which the browser reports as a failed resource.
		page.on('console', (message) => {
			if (message.type() === 'error' && !/401/.test(message.text())) problems.push(message.text());
		});
		page.on('pageerror', (err) => problems.push(err.message));
		try {
			const code = fresh.output().match(/\b([0-9A-Z]{5}(?:-[0-9A-Z]{5}){3})\b/)?.[1];
			assert.ok(code, fresh.output());
			await page.goto(fresh.url + '/', { waitUntil: 'networkidle' });
			assert.equal(new URL(page.url()).pathname, '/setup');
			assert.equal(await page.locator('html').getAttribute('data-theme'), 'terminal');

			await page.getByLabel('Setup code').fill('AAAAA-AAAAA-AAAAA-AAAAA');
			await page.getByRole('button', { name: 'Continue' }).click();
			await page.getByRole('alert').waitFor();
			assert.match(await page.getByRole('alert').textContent(), /not the code/);
			assert.equal(await page.getByRole('group', { name: 'Navidrome or Subsonic' }).count(), 0, 'a wrong code went on to the form');

			await page.getByLabel('Setup code').fill(code.toLowerCase());
			await page.getByRole('button', { name: 'Continue' }).click();
			const server = page.getByRole('group', { name: 'Navidrome or Subsonic' });
			await server.getByLabel('Address').fill('http://127.0.0.1:9');
			await server.getByRole('button', { name: 'Test the address' }).click();
			await server.locator('.result.no').waitFor();
			await server.getByLabel('Address').fill(subsonic.url);
			assert.equal(await server.locator('.result').textContent().then((text) => text.trim()), '', 'the last answer stayed beside a changed address');
			await server.getByRole('button', { name: 'Test the address' }).click();
			await server.locator('.result.ok').waitFor();
			await server.getByLabel('Name on the sign-in page').fill('Home');
			// The address is the one in the bar, filled in, and the cache has a size.
			assert.equal(await page.getByLabel('Where Heddohon is opened').inputValue(), fresh.url);
			await page.getByLabel('Cover cache, in megabytes').fill('128');

			await page.getByRole('button', { name: 'Save and finish' }).click();
			const notice = page.getByRole('region', { name: 'The key is yours to keep' });
			await notice.waitFor();
			assert.match(await notice.textContent(), /Keeping that directory and its backups private is your responsibility/);
			const line = await notice.getByLabel('The line for the environment').inputValue();
			assert.match(line, /^HEDDOHON_SECRET=.{64,}$/);
			// What the key opens is said for each kind of server.
			assert.match(await notice.textContent(), /Navidrome and Subsonic:\s*the password of every account/);
			assert.match(await notice.textContent(), /Jellyfin:\s*an access token for each account, and not its password/);
			// Copied, it can be taken out of the file from here, and the page says what is owed then.
			await notice.getByRole('button', { name: 'I have copied it: remove it from setup.json' }).click();
			await notice.getByText('The key is out of setup.json.').waitFor();
			assert.equal(await notice.getByRole('button', { name: /remove it from setup\.json/ }).count(), 0);
			const { readFileSync } = await import('node:fs');
			assert.ok(!('HEDDOHON_SECRET' in JSON.parse(readFileSync(`${fresh.dataDir}/setup.json`, 'utf8'))), 'the key is still in the file');
			// It is on plain http on the local network, and the page says what that means for sign-in.
			const plain = page.getByRole('region', { name: 'Sign-in on plain http' });
			assert.match(await plain.textContent(), new RegExp(`On ${fresh.url.replace(/[.]/g, '\\.')} the sign-in cookie is sent without Secure`));
			// The address was saved, so there is nothing to set in the environment.
			assert.equal(await page.getByRole('heading', { name: 'Set ORIGIN before signing in' }).count(), 0);

			await page.getByRole('link', { name: 'Go to sign in' }).click();
			await page.waitForURL(fresh.url + '/login');
			await page.getByText('to Home').waitFor();
			// And it can be signed in to there, on plain http, without a variable
			// set or a restart: the reason the address is asked for.
			await page.getByLabel('Username').fill('testuser');
			await page.getByLabel('Password').fill('testpass');
			await page.getByRole('button', { name: 'Sign in' }).click();
			await page.waitForURL(fresh.url + '/');
			await page.goto(fresh.url + '/settings?tab=storage', { waitUntil: 'load' });
			assert.equal(await page.getByLabel(/^Cover cache size/).inputValue(), '128');
			assert.equal(await page.getByLabel(/^Addresses/).inputValue(), fresh.url);
			// The administrator is told the same wherever the address can be changed.
			assert.match(await page.getByRole('note').filter({ hasText: 'Sign-in on plain http' }).textContent(), /sent without\s+Secure/);
			await page.goto(fresh.url + '/setup', { waitUntil: 'load' });
			assert.equal(new URL(page.url()).pathname, '/', 'the setup page is still there');
		} finally {
			await visitor.close();
			await fresh.stop();
		}
		assert.deepEqual(problems, []);
	});
});

describe('features that are off', () => {
	const ALL = ['newReleases', 'lrclib', 'autoeq', 'discord', 'discordCovers', 'listenbrainz', 'mcp', 'analysis', 'profiles', 'togetherGuests'];
	const seen = (featuresSeen) => context.request.patch(`${app.url}/api/settings`, { data: { featuresSeen }, headers: { origin: app.url } });

	test('an administrator sees a dot on Settings until the Server tab is opened, and the tab switches them', async () => {
		const { page, problems } = await watchedPage();
		try {
			await seen(['lrclib', 'autoeq', 'discord', 'listenbrainz', 'mcp']);
			await page.goto(app.url + '/', { waitUntil: 'networkidle' });
			// Not on the home page: a dot on the rail's link to Settings.
			assert.equal(await page.getByRole('complementary', { name: 'Features that are off' }).count(), 0);
			const link = page.locator('nav.rail a[href="/settings"]');
			await link.locator('.dot').waitFor();
			assert.match(await link.textContent(), /features to look at/);

			await page.goto(app.url + '/settings', { waitUntil: 'networkidle' });
			const tab = page.getByRole('navigation', { name: 'Settings' }).getByRole('link', { name: /^Server/ });
			assert.equal(await tab.locator('.dot').count(), 1);
			const saved = page.waitForResponse((r) => r.url().endsWith('/api/settings') && r.request().method() === 'PATCH');
			await tab.click();
			const body = JSON.parse((await saved).request().postData());
			assert.ok(body.featuresSeen.includes('newReleases') && body.featuresSeen.includes('lrclib'), JSON.stringify(body));
			assert.equal(await tab.locator('.dot').count(), 0);
			const section = page.locator('section#features');
			assert.equal(await section.getByRole('switch').count(), ALL.length);
			assert.equal(await section.getByRole('switch', { name: /New releases from MusicBrainz/ }).isChecked(), false);

			// Seen, the dot does not come back.
			await page.goto(app.url + '/', { waitUntil: 'networkidle' });
			await page.waitForTimeout(500);
			assert.equal(await link.locator('.dot').count(), 0, 'the dot came back after the tab was opened');
			// The old link to the Features tab opens the Server tab.
			await page.goto(app.url + '/settings?tab=features', { waitUntil: 'networkidle' });
			assert.ok(await section.isVisible());
		} finally {
			await seen(ALL);
			await page.close();
		}
		assert.deepEqual(problems, []);
	});
});

/*
 * #319: Sound analysis under Settings, Server. What the job says comes from
 * a stand-in for `/api/analysis` here, one state after another; the API
 * itself is tested in `tests/e2e/analysis-settings.test.mjs`.
 */
describe('sound analysis in Settings', () => {
	const SETTINGS = { paused: false, pace: 'gentle', whileListening: 'pause', hours: null };
	const status = (state, extra = {}) => ({
		state,
		total: 12000,
		measured: 3000,
		failed: 2,
		current: null,
		lastHour: 1500,
		finishInMs: 6 * 3600_000,
		lastError: null,
		...extra
	});
	const WORDS = [
		[status('no-account', { total: 0, measured: 0, failed: 0, lastHour: 0, finishInMs: null }), 'No account'],
		[status('listing'), 'Reading the library'],
		[status('running', { current: { backend: 'subsonic', title: 'Night Drive', artist: 'The Mock Band' } }), 'Running'],
		[status('paused'), 'Paused'],
		[status('throttled'), 'Waiting for quiet'],
		[status('outside-hours'), 'Waiting for its hours'],
		[status('done', { measured: 11998, finishInMs: null }), 'Done'],
		[status('stopped', { lastError: { title: '', message: 'ffmpeg is not installed', at: Date.now() } }), 'Stopped']
	];

	/** Answers the section from `answer`, and keeps what it sends. */
	async function standIn(page, answer) {
		const sent = [];
		await page.route(`${app.url}/api/analysis`, async (route) => {
			const request = route.request();
			if (request.method() !== 'GET') {
				const body = JSON.parse(request.postData() ?? 'null');
				sent.push({ method: request.method(), body });
				if (request.method() === 'PATCH') answer.settings = { ...answer.settings, ...body };
			}
			await route.fulfill({ json: answer });
		});
		return sent;
	}

	for (const width of [1440, 390]) {
		test(`at ${width} px it shows each state, and each control saves`, async () => {
			const view = await browser.newContext({ viewport: { width, height: 900 } });
			await view.request.post(`${app.url}/login`, {
				form: { username: 'testuser', password: 'testpass', backend: 'subsonic', next: '/' },
				headers: { origin: app.url, accept: 'text/html' },
				maxRedirects: 0
			});
			const page = await view.newPage();
			const problems = [];
			page.on('console', (message) => message.type() === 'error' && problems.push(message.text()));
			page.on('pageerror', (err) => problems.push(err.message));
			try {
				const answer = { on: true, fromEnvironment: false, status: status('running'), settings: { ...SETTINGS } };
				const sent = await standIn(page, answer);
				await page.goto(app.url + '/settings?tab=analysis');
				const section = page.locator('section#analysis');
				await section.getByRole('heading', { name: 'Sound analysis' }).waitFor();
				const state = section.locator('.state');

				for (const [given, word] of WORDS) {
					answer.status = given;
					await page.reload();
					await state.filter({ hasText: word }).waitFor();
					if (given.total > 0) {
						assert.equal(await section.getByRole('progressbar', { name: 'Songs analysed' }).getAttribute('max'), String(given.total));
						assert.match(await section.textContent(), new RegExp(`${(given.measured + given.failed).toLocaleString('en-US')} of 12,000`));
					}
				}
				answer.status = WORDS[2][0];
				await page.reload();
				await section.getByText('Night Drive · The Mock Band').waitFor();
				assert.match(await section.locator('.figures').textContent(), /Last hour\s*1,500.*Left\s*6 h.*Failed\s*2/s);

				// Each control sends its one field.
				await section.getByRole('switch', { name: 'Paused' }).click();
				await section.getByRole('combobox', { name: 'Speed' }).click();
				await page.getByRole('option', { name: 'Background' }).click();
				await section.getByRole('combobox', { name: 'While someone listens' }).click();
				await page.getByRole('option', { name: 'Carry on' }).click();
				await section.getByRole('switch', { name: 'Only at set hours' }).click();
				await section.getByLabel('From').fill('22:30');
				await section.getByRole('button', { name: 'Retry failed songs' }).click();
				await page.waitForTimeout(300);
				assert.deepEqual(sent, [
					{ method: 'PATCH', body: { paused: true } },
					{ method: 'PATCH', body: { pace: 'background' } },
					{ method: 'PATCH', body: { whileListening: 'continue' } },
					{ method: 'PATCH', body: { hours: { from: 60, to: 420 } } },
					{ method: 'PATCH', body: { hours: { from: 1350, to: 420 } } },
					{ method: 'POST', body: { action: 'retry' } }
				]);

				// Reset asks first, and keeping them sends nothing.
				sent.length = 0;
				await section.getByRole('button', { name: 'Reset…' }).click();
				const confirm = section.getByRole('alertdialog', { name: 'Confirm reset' });
				await confirm.getByRole('button', { name: 'Keep them' }).click();
				assert.equal(sent.length, 0);
				await section.getByRole('button', { name: 'Reset…' }).click();
				await confirm.getByRole('button', { name: 'Reset' }).click();
				await page.waitForTimeout(300);
				assert.deepEqual(sent, [{ method: 'POST', body: { action: 'reset' } }]);

				// The switch, where the environment does not decide it.
				sent.length = 0;
				await section.getByRole('switch', { name: 'Sound analysis on' }).click();
				await page.waitForTimeout(300);
				assert.deepEqual(sent[0], { method: 'PATCH', body: { on: false } });
				// Off, there is nothing to pace.
				answer.on = false;
				answer.status = status('off');
				await page.reload();
				await state.filter({ hasText: 'Off' }).waitFor();
				assert.equal(await section.getByRole('switch', { name: 'Paused' }).count(), 0);
				answer.fromEnvironment = true;
				await page.reload();
				await state.filter({ hasText: 'Off for the server' }).waitFor();
				assert.equal(await section.getByRole('switch', { name: 'Sound analysis on' }).isDisabled(), true);
			} finally {
				// An account keeps 50 sessions, and the suite's own is among the oldest:
				// two more left open ended it, and the tests after this were signed out.
				// The page first: signing out ends its streams mid-answer, which it logs.
				await page.close();
				await view.request.post(`${app.url}/logout`, { headers: { origin: app.url }, maxRedirects: 0 });
				await view.close();
			}
			assert.deepEqual(problems, []);
		});
	}

	test('cd settings/analysis goes to it, and an account that is no administrator has none of it', async () => {
		const origin = { origin: app.url };
		// The command line is Terminal's; the theme the suite had is put back after.
		const { theme } = await (await context.request.get(`${app.url}/api/settings`)).json();
		await context.request.patch(`${app.url}/api/settings`, { headers: origin, data: { theme: 'terminal' } });
		const { page, problems } = await watchedPage();
		try {
			await standIn(page, { on: false, fromEnvironment: false, status: null, settings: { ...SETTINGS } });
			await page.goto(app.url + '/', { waitUntil: 'networkidle' });
			await page.keyboard.press('Control+k');
			await page.getByRole('combobox', { name: 'Command' }).pressSequentially('cd settings/analysis');
			await page.keyboard.press('Enter');
			await page.waitForURL(/\/settings\?tab=analysis$/);
			await page.locator('section#analysis').getByRole('heading', { name: 'Sound analysis' }).waitFor();
		} finally {
			await context.request.patch(`${app.url}/api/settings`, { headers: origin, data: { theme } });
			await page.close();
		}
		assert.deepEqual(problems, []);

		const jf = await browser.newContext({ viewport: { width: 1440, height: 900 } });
		try {
			await jf.request.post(`${app.url}/login`, {
				form: { username: 'jfuser', password: 'jfpass', backend: 'jellyfin', next: '/' },
				headers: { origin: app.url, accept: 'text/html' },
				maxRedirects: 0
			});
			const listener = await jf.newPage();
			await listener.goto(app.url + '/settings?tab=analysis', { waitUntil: 'load' });
			assert.equal(await listener.locator('section#analysis').count(), 0);
			assert.equal(await listener.getByRole('link', { name: 'Sound analysis' }).count(), 0);
			assert.equal((await jf.request.get(`${app.url}/api/analysis`)).status(), 403);
		} finally {
			await jf.close();
		}
	});

	test('stopped on an error, it marks the links to Settings until its section is opened', async () => {
		const { mkdtempSync, rmSync } = await import('node:fs');
		const { tmpdir } = await import('node:os');
		const { join } = await import('node:path');
		// No ffmpeg on the app's path: the job stops at its first song.
		const emptyPath = mkdtempSync(join(tmpdir(), 'heddohon-no-ffmpeg-'));
		const own = await startApp({ subsonicUrl: subsonic.url, jellyfinUrl: jellyfin.url, env: { HEDDOHON_ANALYSIS: 'true', PATH: emptyPath } });
		const view = await browser.newContext({ viewport: { width: 1440, height: 900 } });
		const problems = [];
		try {
			await view.request.post(`${own.url}/login`, {
				form: { username: 'testuser', password: 'testpass', backend: 'subsonic', next: '/' },
				headers: { origin: own.url, accept: 'text/html' },
				maxRedirects: 0
			});
			// Every feature seen, so the dot is the stop's alone.
			await view.request.patch(`${own.url}/api/settings`, {
				headers: { origin: own.url },
				data: { featuresSeen: ['newReleases', 'lrclib', 'autoeq', 'discord', 'discordCovers', 'listenbrainz', 'mcp', 'analysis', 'profiles', 'togetherGuests'] }
			});
			const page = await view.newPage();
			page.on('pageerror', (err) => problems.push(err.message));
			// The section's first question to the server means the page has hydrated:
			// a Save pressed before that posts the form without it, and the answer
			// comes back on another tab (seen with five files running at once).
			const asked = page.waitForResponse((response) => response.url().endsWith('/api/analysis'));
			await page.goto(own.url + '/settings?tab=analysis', { waitUntil: 'load' });
			await asked;
			const account = page.locator('section#analysis-account');
			await account.getByRole('textbox', { name: 'Account on the music server' }).fill('analyst');
			await account.getByRole('textbox', { name: 'Password' }).fill('analyst-pass');
			await account.getByRole('button', { name: 'Save' }).click();
			await account.getByText('Reads the library as').waitFor();
			await page.locator('section#analysis .state').filter({ hasText: 'Stopped' }).waitFor({ timeout: 15_000 });
			assert.match(await page.locator('section#analysis').textContent(), /ffmpeg/);

			await page.goto(own.url + '/', { waitUntil: 'load' });
			const link = page.locator('nav.rail a[href="/settings"]');
			await link.locator('.dot').waitFor();
			assert.match(await link.textContent(), /sound analysis stopped/);
			await link.click();
			await page.waitForURL(/\/settings/);
			const tab = page.getByRole('navigation', { name: 'Settings' }).getByRole('link', { name: /^Server/ });
			assert.equal(await tab.locator('.dot').getAttribute('aria-label'), ', sound analysis stopped');
			await tab.click();
			await page.getByRole('link', { name: 'Sound analysis', exact: true }).filter({ visible: true }).click();
			await page.locator('section#analysis .state').filter({ hasText: 'Stopped' }).waitFor();
			assert.equal(await link.locator('.dot').count(), 0, 'the dot stayed after the section was opened');
		} finally {
			await view.close();
			await own.stop();
			rmSync(emptyPath, { recursive: true, force: true });
		}
		assert.deepEqual(problems, []);
	});
});

/*
 * #333: what sound analysis measured, in the player's Track details. The
 * figures come from a stand-in for `/api/sound/<id>`; the route itself is
 * tested in `tests/e2e/analysis-run.test.mjs`.
 */
describe("a song's sound in Track details", () => {
	test('a measured song shows its tempo, key and loudness, and one not measured shows none', async () => {
		const own = await startApp({ subsonicUrl: subsonic.url, jellyfinUrl: jellyfin.url, env: { HEDDOHON_ANALYSIS: 'true' } });
		const view = await browser.newContext({ viewport: { width: 1440, height: 900 } });
		const problems = [];
		subsonic.state.audio = { type: 'audio/wav', body: silentWav(30) };
		try {
			await view.request.post(`${own.url}/login`, {
				form: { username: 'testuser', password: 'testpass', backend: 'subsonic', next: '/' },
				headers: { origin: own.url, accept: 'text/html' },
				maxRedirects: 0
			});
			const page = await view.newPage();
			page.on('console', (message) => message.type() === 'error' && problems.push(message.text()));
			page.on('pageerror', (err) => problems.push(err.message));
			const asked = [];
			await page.route(`${own.url}/api/sound/*`, async (route) => {
				const id = decodeURIComponent(new URL(route.request().url()).pathname.split('/').pop());
				asked.push(id);
				await route.fulfill({ json: { sound: id === 's2a' ? { tempo: 124, key: { tonic: 9, minor: true }, loudness: -8.4 } : null } });
			});
			await page.goto(own.url + '/albums/al2', { waitUntil: 'load' });
			await page.getByRole('button', { name: 'Play Song 2a', exact: true }).click();
			await page.waitForFunction(() => document.querySelector('aside.panel h2.title')?.textContent === 'Song 2a');
			// Nothing is asked for until the details are open.
			assert.deepEqual(asked, []);
			await page.getByRole('button', { name: 'Track details' }).click();
			const facts = page.locator('aside.panel .facts');
			await facts.getByText('124 BPM').waitFor();
			const text = (await facts.textContent()).replace(/\s+/g, ' ');
			assert.match(text, /Bitrate.*Tempo\s*124 BPM\s*Key\s*A minor\s*Loudness\s*-8\.4 LUFS\s*Album/);

			await page.getByRole('button', { name: 'Next track' }).first().click();
			await page.waitForFunction(() => document.querySelector('aside.panel h2.title')?.textContent === 'Song 2b');
			await page.waitForTimeout(400);
			assert.deepEqual(asked, ['s2a', 's2b']);
			assert.equal(await facts.getByText('Tempo').count(), 0, 'a song not measured showed a tempo');
		} finally {
			subsonic.state.audio = null;
			await view.close();
			await own.stop();
		}
		assert.deepEqual(problems, []);
	});
});

/*
 * #330: one album analysed now, from its menu. What the server says comes
 * from a stand-in for `/api/analysis/album/<id>`; the route is tested in
 * `tests/e2e/analysis-run.test.mjs`.
 */
describe('analysing one album', () => {
	test("an administrator's album menu offers it and says what came of it; it is not offered otherwise", async () => {
		const own = await startApp({ subsonicUrl: subsonic.url, jellyfinUrl: jellyfin.url, env: { HEDDOHON_ANALYSIS: 'true' } });
		const view = await browser.newContext({ viewport: { width: 1440, height: 900 } });
		const problems = [];
		try {
			await view.request.post(`${own.url}/login`, {
				form: { username: 'testuser', password: 'testpass', backend: 'subsonic', next: '/' },
				headers: { origin: own.url, accept: 'text/html' },
				maxRedirects: 0
			});
			const page = await view.newPage();
			page.on('console', (message) => message.type() === 'error' && problems.push(message.text()));
			page.on('pageerror', (err) => problems.push(err.message));
			const answer = { offered: true, measured: 0, total: 2, waiting: false };
			const posted = [];
			await page.route(`${own.url}/api/analysis/album/*`, async (route) => {
				const id = new URL(route.request().url()).pathname.split('/').pop();
				if (route.request().method() === 'POST') {
					posted.push(id);
					// As the server does: the album waits, and its menu says so after.
					answer.waiting = true;
					return route.fulfill({ status: 202, json: answer });
				}
				await route.fulfill({ json: answer });
			});
			const menu = page.getByRole('menu');
			const open = async () => {
				await page.keyboard.press('Escape');
				await menu.waitFor({ state: 'detached' });
				await page.locator('a.card[href="/albums/al1"]').click({ button: 'right' });
				await menu.waitFor();
			};
			await page.goto(own.url + '/albums', { waitUntil: 'load' });
			await page.locator('a.card[href="/albums/al1"]').click({ button: 'right' });
			await menu.waitFor();
			const item = menu.getByRole('menuitem', { name: 'Analyse this album', exact: true });
			await item.waitFor();
			await item.click();
			await menu.getByRole('menuitem', { name: 'Analysing this album', exact: true }).waitFor();
			assert.deepEqual(posted, ['al1']);

			// One waiting from this administrator: the menu says so, and asks nothing.
			await open();
			const waiting = menu.getByRole('menuitem', { name: 'Another album is being analysed', exact: true });
			await waiting.waitFor();
			await waiting.click();
			await page.waitForTimeout(300);
			assert.deepEqual(posted, ['al1']);

			// Every song measured: the item says it measures them again.
			answer.waiting = false;
			answer.measured = 2;
			await open();
			await menu.getByRole('menuitem', { name: 'Analyse again', exact: true }).waitFor();

			// Not offered: the item is not there.
			answer.offered = false;
			await open();
			await menu.getByRole('menuitem', { name: 'Play', exact: true }).waitFor();
			await page.waitForTimeout(300);
			assert.equal(await menu.getByRole('menuitem', { name: /Analys/ }).count(), 0);
		} finally {
			await view.close();
			await own.stop();
		}
		assert.deepEqual(problems, []);
	});

	test('the Sound analysis section shows the album under way', async () => {
		const own = await startApp({ subsonicUrl: subsonic.url, jellyfinUrl: jellyfin.url, env: { HEDDOHON_ANALYSIS: 'true' } });
		const view = await browser.newContext({ viewport: { width: 1440, height: 900 } });
		try {
			await view.request.post(`${own.url}/login`, {
				form: { username: 'testuser', password: 'testpass', backend: 'subsonic', next: '/' },
				headers: { origin: own.url, accept: 'text/html' },
				maxRedirects: 0
			});
			const page = await view.newPage();
			await page.route(`${own.url}/api/analysis`, (route) =>
				route.fulfill({
					json: {
						on: true,
						fromEnvironment: true,
						settings: { paused: true, pace: 'gentle', whileListening: 'pause', hours: null },
						status: {
							state: 'running',
							total: 120,
							measured: 40,
							failed: 0,
							current: { backend: 'subsonic', title: 'Song 3a', artist: 'Artist 0003' },
							lastHour: 30,
							finishInMs: 3_600_000,
							lastError: null,
							album: { title: 'Album 3', done: 1, total: 2 }
						}
					}
				})
			);
			await page.goto(own.url + '/settings?tab=analysis');
			const figures = page.locator('section#analysis .figures');
			await figures.getByText('Album asked for').waitFor();
			assert.match((await figures.textContent()).replace(/\s+/g, ' '), /Album asked for Album 3 · 1 of 2/);
		} finally {
			await view.close();
			await own.stop();
		}
	});
});

/*
 * #182: a colour scheme from a file in the data directory, chosen in Settings,
 * repaints the page at once, its fixed accents included, and the page comes
 * back in it.
 */
describe('a colour scheme from a file', () => {
	test('chosen under Settings, it paints the page at once and after a reload', async () => {
		const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
		const { tmpdir } = await import('node:os');
		const { join } = await import('node:path');
		const dataDir = mkdtempSync(join(tmpdir(), 'heddohon-browser-schemes-'));
		mkdirSync(join(dataDir, 'themes'));
		writeFileSync(
			join(dataDir, 'themes', 'rose-pine.json'),
			JSON.stringify({
				heddohon: 1,
				name: 'Rosé Pine',
				ground: '#191724',
				raised: '#26233a',
				foreground: '#e0def4',
				accents: { green: '#9ccfd8', amber: '#f6c177', cyan: '#9ccfd8', violet: '#c4a7e7', rose: '#ebbcba', white: '#e0def4' }
			})
		);
		const own = await startApp({
			subsonicUrl: subsonic.url,
			jellyfinUrl: jellyfin.url,
			dataDir,
			env: { HEDDOHON_REMOTE_CONTROL: 'false', HEDDOHON_DEFAULT_THEME: 'terminal' }
		});
		const view = await browser.newContext({ viewport: { width: 1280, height: 800 } });
		try {
			const signIn = await view.request.post(`${own.url}/login`, {
				form: { username: 'testuser', password: 'testpass', backend: 'subsonic', next: '/' },
				headers: { origin: own.url, accept: 'text/html' },
				maxRedirects: 0
			});
			assert.equal(signIn.status(), 303);
			await view.request.patch(`${own.url}/api/settings`, { data: { accent: 'amber', aurora: 'off' }, headers: { origin: own.url } });
			const page = await view.newPage();
			const tokens = () =>
				page.evaluate(() => {
					const root = getComputedStyle(document.documentElement);
					return { ground: root.getPropertyValue('--bg-base').trim(), accent: root.getPropertyValue('--accent').trim() };
				});
			await page.goto(`${own.url}/settings`, { waitUntil: 'networkidle' });
			await autosaved(page, () => pick(select(page, 'scheme'), 'rose-pine'));
			await page.waitForFunction(() => document.documentElement.dataset.scheme === 'rose-pine');
			assert.deepEqual(await tokens(), { ground: '#191724', accent: '#f6c177' });
			await page.reload({ waitUntil: 'networkidle' });
			assert.deepEqual(await tokens(), { ground: '#191724', accent: '#f6c177' }, 'the choice was not kept');
			assert.equal(await page.locator('meta[name="theme-color"]').getAttribute('content'), '#191724');

			// Held to what the built-in schemes are held to: the text tones and the
			// signals at 4.5:1 on the pane, and the label at 4.5:1 on each accent.
			const low = await page.evaluate(() => {
				const root = document.documentElement;
				const probe = document.createElement('div');
				document.body.append(probe);
				const canvas = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
				const rgb = (value) => {
					probe.style.color = value;
					canvas.clearRect(0, 0, 1, 1);
					canvas.fillStyle = getComputedStyle(probe).color;
					canvas.fillRect(0, 0, 1, 1);
					return [...canvas.getImageData(0, 0, 1, 1).data].slice(0, 3);
				};
				const luminance = (colour) =>
					colour.reduce((sum, c, at) => {
						const v = c / 255;
						return sum + (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4) * [0.2126, 0.7152, 0.0722][at];
					}, 0);
				const ratio = (one, two) => {
					const [hi, lo] = [luminance(rgb(one)), luminance(rgb(two))].sort((a, b) => b - a);
					return (hi + 0.05) / (lo + 0.05);
				};
				const found = [];
				for (const token of ['--text-strong', '--text-default', '--text-muted', '--text-faint', '--danger', '--positive']) {
					const at = ratio(`var(${token})`, 'var(--bg-surface)');
					if (at < 4.5) found.push(`${token} at ${at.toFixed(2)}`);
				}
				for (const accent of ['artwork', 'green', 'amber', 'cyan', 'violet', 'rose', 'white']) {
					root.dataset.accent = accent;
					const at = ratio('var(--accent-contrast)', 'var(--accent)');
					if (at < 4.5) found.push(`the label on ${accent} at ${at.toFixed(2)}`);
				}
				probe.remove();
				return found;
			});
			assert.deepEqual(low, []);
			await page.close();
		} finally {
			await view.close();
			await own.stop();
		}
	});
});

/*
 * 2026-11-10: the empty player panel starts something itself, and on a phone
 * the album page keeps Play and Shuffle and puts the rest under More.
 */
describe('starting something', () => {
	const emptyQueue = () =>
		context.request.put(`${app.url}/api/play-state`, {
			headers: { origin: app.url, 'content-type': 'application/json' },
			data: { songIds: [], index: 0, position: 0, repeat: 'off', shuffle: false }
		});

	test('with nothing queued, the player panel shuffles the library', async () => {
		await emptyQueue();
		const { page, problems } = await watchedPage();
		try {
			await page.goto(app.url + '/', { waitUntil: 'networkidle' });
			const panel = page.locator('.chrome .head');
			await panel.getByRole('heading', { name: 'Nothing playing' }).waitFor();
			const asked = page.waitForRequest((request) => request.url().endsWith('/api/tracks') && JSON.parse(request.postData() ?? '{}').source === 'random');
			await panel.getByRole('button', { name: 'Shuffle library' }).click();
			await asked;
			await page.waitForFunction(() => document.querySelector('.chrome .head h2')?.textContent?.trim() !== 'Nothing playing');
			assert.equal(await panel.getByRole('button', { name: 'Shuffle library' }).count(), 0);
		} finally {
			await page.evaluate(() => [...document.querySelectorAll('audio')].forEach((a) => a.pause())).catch(() => undefined);
			await emptyQueue();
			await page.close();
		}
		assert.deepEqual(problems.filter((problem) => !/cannot play|Failed to load resource/.test(problem)), []);
	});

	test('on a phone the album page shows Play, Shuffle and More, and More holds the rest', async () => {
		const phone = await browser.newContext({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true });
		await phone.request.post(`${app.url}/login`, {
			form: { username: 'testuser', password: 'testpass', backend: 'subsonic', next: '/' },
			headers: { origin: app.url, accept: 'text/html' },
			maxRedirects: 0
		});
		const page = await phone.newPage();
		try {
			await page.goto(app.url + '/albums/al1', { waitUntil: 'networkidle' });
			const actions = page.locator('.actions');
			for (const name of ['Play', 'Shuffle', 'More']) {
				assert.ok(await actions.getByRole('button', { name, exact: true }).isVisible(), `${name} is not shown`);
			}
			for (const name of ['Add to queue', 'Add to playlist']) {
				assert.equal(await actions.getByRole('button', { name, exact: true }).isVisible(), false, `${name} is still shown`);
			}
			assert.equal(await actions.locator('.mix').isVisible(), false, 'the instant mix is still shown');

			await actions.getByRole('button', { name: 'More', exact: true }).tap();
			const items = (await page.getByRole('menuitem').allTextContents()).map((text) => text.trim());
			for (const name of ['Add to queue', 'Add to playlist…', 'Start instant mix', 'Play next']) {
				assert.ok(items.includes(name), `${name} is not in the menu: ${items.join(', ')}`);
			}
			await page.keyboard.press('Escape');
			await page.getByRole('menu').waitFor({ state: 'detached' });
		} finally {
			await page.close();
			await phone.close();
		}
	});

	test('on a wide screen the album page keeps its buttons, and no More', async () => {
		const { page } = await watchedPage();
		try {
			await page.goto(app.url + '/albums/al1', { waitUntil: 'networkidle' });
			const actions = page.locator('.actions');
			assert.ok(await actions.getByRole('button', { name: 'Add to queue', exact: true }).isVisible());
			assert.equal(await actions.getByRole('button', { name: 'More', exact: true }).isVisible(), false);
		} finally {
			await page.close();
		}
	});
});

describe('settings saved as they change', () => {
	const settings = (patch) => context.request.patch(`${app.url}/api/settings`, { data: patch, headers: { origin: app.url } });

	test('a switch saves without a button, and a change made while a save is on its way is kept', async () => {
		await settings({ showQualityBadge: true, preloadNext: true });
		const { page, problems } = await watchedPage();
		try {
			await page.goto(app.url + '/settings', { waitUntil: 'networkidle' });
			assert.equal(await page.getByRole('button', { name: 'Save settings' }).count(), 0);

			// The first save is held until the second change has been made.
			let release;
			const released = new Promise((done) => (release = done));
			let held = 0;
			await page.route('**/settings?/save', async (route) => {
				if (held++ === 0) await released;
				await route.continue();
			});
			const first = page.waitForRequest((request) => request.url().includes('?/save'));
			await page.locator('#switch-showQualityBadge').click();
			await first;
			await page.getByRole('navigation', { name: 'Settings' }).getByRole('link', { name: 'Playback' }).click();
			await page.locator('#switch-preloadNext').click();
			await page.waitForTimeout(600);
			release();
			// The held save's answer does not put the second switch back, and it is saved after.
			await page.waitForFunction(() => document.querySelector('form[action="?/save"]')?.getAttribute('aria-busy') === 'false');
			await page.waitForTimeout(800);
			await page.waitForFunction(() => document.querySelector('form[action="?/save"]')?.getAttribute('aria-busy') === 'false');
			assert.equal(await page.locator('#switch-preloadNext').getAttribute('aria-checked'), 'false');
			const saved = await (await context.request.get(`${app.url}/api/settings`)).json();
			assert.deepEqual([saved.showQualityBadge, saved.preloadNext], [false, false]);
		} finally {
			await page.unroute('**/settings?/save').catch(() => undefined);
			await settings({ showQualityBadge: true, preloadNext: true });
			await page.close();
		}
		assert.deepEqual(problems, []);
	});
});
