/**
 * Headphone corrections, finding things and the album and artist pages on a phone, a stream that fails, internet radio and the bars a phone paints.
 *
 *   npm run build
 *   node --test tests/browser/phone-pages.test.mjs
 *
 * Runs the built app against the mock servers of `tests/e2e`; see `suite.mjs`.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { startApp } from '../e2e/harness.mjs';
import { HD650_PARAMETRIC, silentWav, startAutoEq, startStationHost } from '../e2e/mocks.mjs';
import { subsonic, jellyfin, app, browser, context, select, pick, pickLabel, shown, sliderValue, watchedPage, setUpSuite } from './suite.mjs';

setUpSuite();

describe('the headphone correction', () => {
	const stored = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('heddohon:audio-processing')));
	const file = (name, text) => ({ name, mimeType: 'text/plain', buffer: Buffer.from(text) });
	/** Counts the biquads the graph makes: ten bands, and one per filter of a correction. */
	const countBiquads = (page) =>
		page.addInitScript(() => {
			window.__biquads = 0;
			window.__filters = [];
			const create = BaseAudioContext.prototype.createBiquadFilter;
			BaseAudioContext.prototype.createBiquadFilter = function () {
				window.__biquads++;
				const filter = create.call(this);
				window.__filters.push(filter);
				return filter;
			};
		});

	test('an imported ParametricEQ.txt sets the filters, is kept, and can be removed', async () => {
		const { page, problems } = await watchedPage();
		try {
			await countBiquads(page);
			await page.goto(app.url + '/settings?tab=playback', { waitUntil: 'networkidle' });
			await page.getByRole('switch', { name: /^Process audio/ }).check();
			assert.equal(await page.getByRole('searchbox', { name: 'Search headphones' }).count(), 0, 'no search where the database is off');
			assert.equal(await page.evaluate(() => window.__biquads), 10);

			// The bands, set before the correction: 31 Hz is the first biquad made.
			const band = page.getByRole('slider', { name: '31Hz, in dB' });
			const preset = page.getByRole('combobox', { name: 'Equaliser' });
			const inGraph = (db) => page.waitForFunction((want) => Math.abs(window.__filters[0].gain.value - want) < 0.05, db);
			await pick(preset, 'bass');
			await inGraph(6);

			const input = page.locator('.correction input[type="file"]');
			await input.setInputFiles(file('Sennheiser HD 650 ParametricEQ.txt', HD650_PARAMETRIC));
			const chosen = page.locator('.correction .chosen');
			await chosen.waitFor();
			assert.match(await chosen.innerText(), /Sennheiser HD 650\s+4 filters,\s+preamp -6\.1 dB/);
			assert.equal(await page.evaluate(() => window.__biquads), 14, 'one biquad per filter that is on');
			const saved = (await stored(page)).correction;
			assert.equal(saved.name, 'Sennheiser HD 650');
			assert.equal(saved.id, null);
			assert.deepEqual(saved.filters[0], { type: 'lowshelf', frequency: 105, gain: 6.4, q: 0.7 });

			// With a correction in use the bands are greyed, disabled and flat in the graph, and keep their values.
			await inGraph(0);
			assert.equal(await band.isDisabled(), true);
			assert.equal(await preset.isDisabled(), true);
			assert.equal(await sliderValue(band), '6');
			assert.deepEqual((await stored(page)).gains, [6, 5, 4, 2, 0, 0, 0, 0, 0, 0]);

			// Removed, the bands come back as they were; then the correction is put back.
			// Checked before the reload: a context made without a press does not run its clock here.
			await chosen.getByRole('button', { name: 'Remove' }).click();
			await inGraph(6);
			assert.equal(await band.isDisabled(), false);
			await input.setInputFiles(file('Sennheiser HD 650 ParametricEQ.txt', HD650_PARAMETRIC));
			await chosen.waitFor();
			await inGraph(0);

			// A file with no filters is refused, and the correction in place stays.
			await input.setInputFiles(file('notes.txt', 'Preamp: -3 dB\nnothing else here\n'));
			await page.getByRole('alert').filter({ hasText: 'holds no filters' }).waitFor();
			assert.equal((await stored(page)).correction.name, 'Sennheiser HD 650');

			await page.reload({ waitUntil: 'networkidle' });
			await page.locator('.correction .chosen').waitFor();
			assert.equal(await page.evaluate(() => window.__biquads), 14, 'applied again from storage');
			assert.equal(await page.getByRole('slider', { name: '31Hz, in dB' }).isDisabled(), true);

			await page.locator('.correction .chosen').getByRole('button', { name: 'Remove' }).click();
			await page.locator('.correction .chosen').waitFor({ state: 'detached' });
			assert.equal((await stored(page)).correction, undefined);
			assert.equal(await page.getByRole('slider', { name: '31Hz, in dB' }).isDisabled(), false);
		} finally {
			await page.evaluate(() => localStorage.removeItem('heddohon:audio-processing')).catch(() => undefined);
			await page.close();
		}
		assert.deepEqual(problems, []);
	});

	test('where the database is on, a search finds the headphone and a day-old choice is fetched again', async () => {
		const autoeq = await startAutoEq();
		const on = await startApp({
			subsonicUrl: subsonic.url,
			jellyfinUrl: jellyfin.url,
			env: { HEDDOHON_REMOTE_CONTROL: 'false', HEDDOHON_AUTOEQ: 'true', HEDDOHON_AUTOEQ_URL: autoeq.url }
		});
		const view = await browser.newContext({ viewport: { width: 1440, height: 900 } });
		try {
			const signIn = await view.request.post(`${on.url}/login`, {
				form: { username: 'testuser', password: 'testpass', backend: 'subsonic', next: '/' },
				headers: { origin: on.url, accept: 'text/html' },
				maxRedirects: 0
			});
			assert.equal(signIn.status(), 303);
			const page = await view.newPage();
			const problems = [];
			page.on('pageerror', (err) => problems.push(err.message));
			await page.goto(on.url + '/settings?tab=playback', { waitUntil: 'networkidle' });
			await page.getByRole('switch', { name: /^Process audio/ }).check();

			await page.getByRole('searchbox', { name: 'Search headphones' }).fill('hd 650');
			const matches = page.getByRole('list', { name: 'Headphones found' }).getByRole('button');
			await matches.first().waitFor();
			assert.equal(await matches.count(), 3);
			await matches.filter({ hasText: /oratory1990$/ }).click();
			await page.locator('.correction .chosen').waitFor();
			assert.match(await page.locator('.correction .chosen').innerText(), /Sennheiser HD 650\s+oratory1990 · 4 filters/);
			const saved = (await stored(page)).correction;
			assert.equal(saved.id, 'oratory1990/over-ear/Sennheiser HD 650');

			// Inside a day a reload asks for nothing; past it, the profile is fetched again.
			let fetched = 0;
			page.on('request', (request) => {
				if (request.url().includes('/api/autoeq/profile')) fetched++;
			});
			await page.reload({ waitUntil: 'networkidle' });
			assert.equal(fetched, 0);
			await page.evaluate((at) => {
				const kept = JSON.parse(localStorage.getItem('heddohon:audio-processing'));
				kept.correction.fetchedAt = at;
				kept.correction.preamp = -1;
				localStorage.setItem('heddohon:audio-processing', JSON.stringify(kept));
			}, Date.now() - 25 * 60 * 60 * 1000);
			await page.reload({ waitUntil: 'networkidle' });
			await page.waitForFunction(() => JSON.parse(localStorage.getItem('heddohon:audio-processing')).correction.preamp === -6.1);
			assert.equal(fetched, 1);
			assert.deepEqual(problems, []);
		} finally {
			await view.close();
			await on.stop();
			await autoeq.close();
		}
	});
});

describe('finding things on a phone', () => {
	test('a song menu on each row, Back, a sort menu, the tab named, the sheet in four, and the swipe shown once', async () => {
		subsonic.state.audio = { type: 'audio/wav', body: silentWav(60) };
		const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
		await phone.request.post(`${app.url}/login`, {
			form: { username: 'testuser', password: 'testpass', backend: 'subsonic', next: '/' },
			headers: { origin: app.url, accept: 'text/html' },
			maxRedirects: 0
		});
		// Every time the hint starts, across loads: with a queue saved by an earlier
		// test, the dock has a song on the first page and plays it there.
		await phone.addInitScript(() => {
			new MutationObserver((records) => {
				for (const record of records) {
					const node = record.target;
					if (node.classList?.contains('text') && node.classList.contains('nudge')) {
						sessionStorage.setItem('nudges', String(Number(sessionStorage.getItem('nudges') ?? 0) + 1));
					}
				}
			}).observe(document, { subtree: true, attributes: true, attributeFilter: ['class'] });
		});
		const page = await phone.newPage();
		// At the middle of the box, as the other phone tests tap: Playwright's
		// own tap waits for a stillness it did not see on the album page.
		const tap = async (locator) => {
			const box = await locator.boundingBox();
			await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
		};
		const problems = [];
		page.on('pageerror', (err) => problems.push(err.message));
		try {
			// Sorting: one menu in place of the chips.
			await page.goto(app.url + '/albums', { waitUntil: 'networkidle' });
			assert.equal(await page.locator('nav.sorts').isVisible(), false, 'the chips are shown on a phone');
			await pickLabel(page.locator('.menu [role="combobox"]').first(), 'A–Z');
			await page.waitForURL(/sort=/);

			// Back from an album returns to the list it was opened from.
			await tap(page.locator('a[href="/albums/al1"]').first());
			await page.waitForURL(/\/albums\/al1$/);
			// After the sleeve's view transition, which holds the page under its own layer.
			await page.waitForFunction(() => !document.documentElement.matches(':active-view-transition'));
			await tap(page.getByRole('link', { name: 'Back' }));
			await page.waitForURL(/\/albums\?sort=/);
			// Opened straight, it goes up to the section.
			await page.goto(app.url + '/albums/al1', { waitUntil: 'networkidle' });
			assert.equal(await page.getByRole('link', { name: 'Back' }).getAttribute('href'), '/albums');

			// The dock names the tab it is on, and only that one.
			const named = await page.locator('.phone-dock .tab .label').allTextContents();
			assert.deepEqual(named, ['Library']);

			// A row's menu, with what the row's actions never held.
			await tap(page.getByRole('button', { name: 'More for Song 1b', exact: true }));
			const menu = page.getByRole('menu');
			await menu.getByRole('menuitem', { name: 'Play next' }).waitFor();
			await page.keyboard.press('Escape');

			// Playing, the dock shows the swipe once.
			await tap(page.getByRole('button', { name: 'Play Song 1a', exact: true }));
			const nudges = () => page.evaluate(() => Number(sessionStorage.getItem('nudges') ?? 0));
			await page.waitForFunction(() => Number(sessionStorage.getItem('nudges') ?? 0) > 0);
			assert.equal(await page.evaluate(() => localStorage.getItem('heddohon:dock-nudged')), '1');
			await page.reload({ waitUntil: 'networkidle' });
			await tap(page.getByRole('button', { name: 'Play Song 1a', exact: true }));
			await page.waitForTimeout(2200);
			assert.equal(await nudges(), 1, 'the hint played more than once');

			// Back while a song plays leaves it playing: the way back stays in the app.
			const playing = () => page.evaluate(() => [...document.querySelectorAll('audio')].some((audio) => !audio.paused && audio.currentTime > 0));
			await page.waitForFunction(() => [...document.querySelectorAll('audio')].some((audio) => !audio.paused && audio.currentTime > 0));
			await tap(page.getByRole('link', { name: 'Back' }));
			await page.waitForURL(/\/albums(\?|$)/);
			await page.waitForTimeout(800);
			assert.equal(await playing(), true, 'Back stopped the music');
			await page.goto(app.url + '/albums/al1', { waitUntil: 'networkidle' });

			// The sheet's row: lyrics, More, the queue and the way down; the rest labelled in More.
			await tap(page.locator('#dock-open'));
			await page.waitForFunction(() => document.querySelector('.app').classList.contains('player-open'));
			const tools = await page.locator('aside.panel .tools button').evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label')));
			assert.deepEqual(tools, ['Lyrics', 'More', 'Queue', 'Hide the player']);
			await tap(page.locator('aside.panel').getByRole('button', { name: 'More', exact: true }));
			const more = page.locator('aside.panel').getByRole('group', { name: 'More' });
			await tap(more.getByRole('button', { name: 'Sleep timer' }));
			await page.locator('aside.panel').getByRole('group', { name: 'Sleep timer' }).getByRole('button', { name: '15 min' }).waitFor();
		} finally {
			subsonic.state.audio = null;
			await phone.close();
		}
		assert.deepEqual(problems, []);
	});
});

describe('back in the iPhone home-screen app', () => {
	test("is the app's own: no history entries, a swipe that moves the page under a still dock, the place in the list kept", async () => {
		subsonic.state.audio = { type: 'audio/wav', body: silentWav(60) };
		const phone = await browser.newContext({ viewport: { width: 390, height: 700 }, isMobile: true, hasTouch: true });
		await phone.request.post(`${app.url}/login`, {
			form: { username: 'testuser', password: 'testpass', backend: 'subsonic', next: '/' },
			headers: { origin: app.url, accept: 'text/html' },
			maxRedirects: 0
		});
		// Stands in for `navigator.standalone`, which only iOS sets.
		await phone.addInitScript(() => localStorage.setItem('heddohon:own-back', '1'));
		const page = await phone.newPage();
		const problems = [];
		page.on('pageerror', (err) => problems.push(err.message));
		const touch = await phone.newCDPSession(page);
		const finger = (type, x, y) => touch.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
		const tap = async (locator) => {
			const box = await locator.boundingBox();
			await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
		};
		const playing = () => page.evaluate(() => [...document.querySelectorAll('audio')].some((audio) => !audio.paused && audio.currentTime > 0));
		try {
			await page.goto(app.url + '/albums', { waitUntil: 'networkidle' });
			const entries = await page.evaluate(() => history.length);
			await page.evaluate(() => scrollTo({ top: 300, behavior: 'instant' }));
			await page.waitForTimeout(200);
			// A card a few rows down, so there is a place in the list to come back to.
			const card = page.locator('main a.card[href^="/albums/"]').nth(7);
			const href = await card.getAttribute('href');
			const n = href.replace('/albums/al', '');
			await card.evaluate((node) => node.scrollIntoView({ block: 'center', behavior: 'instant' }));
			const listTop = await page.evaluate(() => scrollY);
			await tap(card);
			await page.waitForURL((url) => url.pathname === href);
			assert.equal(await page.evaluate(() => history.length), entries, 'a page was added to the history');

			await page.waitForFunction(() => !document.documentElement.matches(':active-view-transition'));
			const row = page.getByRole('button', { name: `Play Song ${n}a`, exact: true });
			await row.evaluate((node) => node.scrollIntoView({ block: 'center', behavior: 'instant' }));
			await tap(row);
			await page.waitForFunction(() => [...document.querySelectorAll('audio')].some((audio) => !audio.paused && audio.currentTime > 0));

			// Halfway across: the page has moved, the dock has not.
			const dockBefore = await page.locator('.phone-dock').boundingBox();
			await finger('touchStart', 6, 400);
			for (let x = 20; x <= 100; x += 20) {
				await finger('touchMove', x, 402);
				await page.waitForTimeout(16);
			}
			const moved = await page.locator('main.content').evaluate((node) => getComputedStyle(node).translate);
			assert.match(moved, /^9\d(\.\d+)?px/, `the page did not follow the finger: ${moved}`);
			assert.deepEqual(await page.locator('.phone-dock').boundingBox(), dockBefore, 'the dock moved with the page');

			// Let go short of a third: it springs back and stays.
			await finger('touchEnd');
			await page.waitForTimeout(400);
			assert.equal(new URL(page.url()).pathname, href);

			// Past a third: back to the list, where it was scrolled, still playing.
			await finger('touchStart', 6, 400);
			for (let x = 40; x <= 280; x += 40) {
				await finger('touchMove', x, 402);
				await page.waitForTimeout(16);
			}
			await finger('touchEnd');
			await page.waitForURL(/\/albums$/);
			await page.waitForFunction((top) => Math.abs(scrollY - top) < 4, listTop);
			assert.equal(await playing(), true, 'the swipe back stopped the music');
			assert.equal(await page.locator('main.content').evaluate((node) => node.style.translate), '', 'the page was left aside');

			// The Back link walks the same list.
			await tap(page.locator(`main a.card[href="${href}"]`));
			await page.waitForURL((url) => url.pathname === href);
			await page.waitForFunction(() => !document.documentElement.matches(':active-view-transition'));
			await tap(page.getByRole('link', { name: 'Back' }));
			await page.waitForURL(/\/albums$/);
			assert.equal(await page.evaluate(() => history.length), entries, 'a page was added to the history');
		} finally {
			subsonic.state.audio = null;
			await phone.close();
		}
		assert.deepEqual(problems, []);
	});
});

describe('an artist page on a phone', () => {
	test('fits the screen, with the name, biography and buttons centred', async () => {
		for (const viewport of [
			{ width: 393, height: 852 },
			{ width: 360, height: 780 }
		]) {
			const phone = await browser.newContext({ viewport, isMobile: true, hasTouch: true });
			const signIn = await phone.request.post(`${app.url}/login`, {
				form: { username: 'testuser', password: 'testpass', backend: 'subsonic', next: '/' },
				headers: { origin: app.url, accept: 'text/html' },
				maxRedirects: 0
			});
			assert.equal(signIn.status(), 303);
			const page = await phone.newPage();
			try {
				await page.goto(app.url + '/artists/ar0', { waitUntil: 'networkidle' });
				const seen = await page.evaluate(() => {
					const width = innerWidth;
					const box = (selector) => document.querySelector(selector).getBoundingClientRect();
					const past = [...document.querySelectorAll('main .hero *')]
						.filter((el) => el.getBoundingClientRect().right > width + 1 || el.getBoundingClientRect().left < -1)
						.map((el) => `${el.tagName.toLowerCase()}.${el.className}`);
					const centre = (rect) => Math.round(rect.left + rect.width / 2 - width / 2);
					return {
						scrolls: document.documentElement.scrollWidth - width,
						past,
						details: Math.round(box('main .hero .details').width),
						off: { portrait: centre(box('main .hero .portrait')), bio: centre(box('main .hero .bio')), actions: centre(box('main .hero .actions')) }
					};
				});
				const at = `${viewport.width}px`;
				assert.equal(seen.scrolls, 0, at);
				assert.deepEqual(seen.past, [], `${at}: nothing in the header past either edge`);
				assert.ok(seen.details > viewport.width * 0.8, `${at}: the text column is ${seen.details}px wide`);
				for (const [name, off] of Object.entries(seen.off)) assert.ok(Math.abs(off) <= 2, `${at}: ${name} is ${off}px off centre`);
			} finally {
				await phone.close();
			}
		}
	});
});

describe('an album page on a phone', () => {
	/*
	 * Measured from what is drawn, the children of each row: the rows themselves
	 * are as wide as the column, so a row left at the start of it reads as centred.
	 */
	test('has everything centred under the sleeve wherever the page is stacked', async () => {
		for (const viewport of [
			{ width: 320, height: 700 },
			{ width: 393, height: 852 },
			{ width: 600, height: 900 },
			{ width: 760, height: 1000 }
		]) {
			const phone = await browser.newContext({ viewport, isMobile: true, hasTouch: true });
			const signIn = await phone.request.post(`${app.url}/login`, {
				form: { username: 'testuser', password: 'testpass', backend: 'subsonic', next: '/' },
				headers: { origin: app.url, accept: 'text/html' },
				maxRedirects: 0
			});
			assert.equal(signIn.status(), 303);
			const page = await phone.newPage();
			try {
				await page.goto(app.url + '/albums/al1', { waitUntil: 'networkidle' });
				for (const theme of ['terminal', 'dark']) {
					await page.evaluate((name) => (document.documentElement.dataset.theme = name), theme);
					const seen = await page.evaluate(() => {
						const width = document.documentElement.clientWidth;
						const off = (left, right) => Math.round((left + right) / 2 - width / 2);
						const box = (selector) => {
							const rect = document.querySelector(selector).getBoundingClientRect();
							return off(rect.left, rect.right);
						};
						// By line: a row that wrapped is centred line by line. On a phone the
						// heart joins the buttons' line, so both rows are measured together.
						const row = (selector) => {
							const lines = new Map();
							for (const child of document.querySelectorAll(selector)) {
								const rect = child.getBoundingClientRect();
								if (rect.width === 0) continue;
								const line = lines.get(Math.round(rect.top + rect.height / 2)) ?? [];
								lines.set(Math.round(rect.top + rect.height / 2), [...line, rect]);
							}
							return Math.max(...[...lines.values()].map((rects) => Math.abs(off(Math.min(...rects.map((r) => r.left)), Math.max(...rects.map((r) => r.right))))));
						};
						const middle = (selector) => {
							const rect = document.querySelector(selector).getBoundingClientRect();
							return Math.round(rect.top + rect.height / 2);
						};
						return {
							// On a phone the heart is in the buttons' row, not a row of its own.
							heartWithPlay: middle('.details .favourite') === middle('.details .hh-button--primary'),
							scrolls: document.documentElement.scrollWidth - width,
							off: { sleeve: box('.hero .holder'), title: box('.details h1'), artist: box('.details .artist'), meta: box('.details .meta'), controls: row('.details .badge-row > *, .details .actions > *') }
						};
					});
					const at = `${theme} at ${viewport.width}px`;
					assert.equal(seen.scrolls, 0, at);
					assert.equal(seen.heartWithPlay, viewport.width <= 576, `${at}: the heart's row`);
					for (const [name, off] of Object.entries(seen.off)) assert.ok(Math.abs(off) <= 2, `${at}: ${name} is ${off}px off centre`);
				}
			} finally {
				await phone.close();
			}
		}
	});
});

describe('a stream that fails', () => {
	const sounding = (seconds = 0.3) =>
		[...document.querySelectorAll('audio')].some((a) => !a.paused && a.currentTime > seconds);

	/** Answers a track's requests with what `status` gives for each GET, counted per track. */
	function failing(status) {
		const asked = new Map();
		subsonic.state.onStream = (id, req, res) => {
			if (req.method !== 'GET') {
				const code = status(id, asked.get(id) ?? 0);
				if (!code) return false;
				res.statusCode = code;
				res.end();
				return true;
			}
			const count = (asked.get(id) ?? 0) + 1;
			asked.set(id, count);
			const code = status(id, count);
			if (!code) return false;
			res.statusCode = code;
			res.end();
			return true;
		};
	}

	async function reset(page) {
		subsonic.state.onStream = null;
		subsonic.state.audio = null;
		await page.evaluate(() => [...document.querySelectorAll('audio')].forEach((a) => a.pause())).catch(() => undefined);
		await context.request.put(`${app.url}/api/play-state`, {
			headers: { origin: app.url, 'content-type': 'application/json' },
			data: { songIds: [], index: 0, position: 0, repeat: 'off', shuffle: false }
		});
		await page.close();
	}

	/*
	 * Chromium reports an HTTP failure opening a stream as a format it cannot
	 * play, which read as a file that would never decode.
	 */
	test('an HTTP error on opening is tried again, and says it is', async () => {
		subsonic.state.audio = { type: 'audio/wav', body: silentWav(30) };
		failing((_, count) => (count <= 2 ? 503 : 0));
		const page = await context.newPage();
		try {
			await page.goto(app.url + '/albums/al1', { waitUntil: 'networkidle' });
			await page.getByRole('button', { name: 'Play Song 1a', exact: true }).click();
			await page.locator('.hh-toast [role="status"]', { hasText: 'Reconnecting' }).waitFor();
			await page.waitForFunction(sounding, null, { timeout: 15_000 });
			await page.locator('.hh-toast [role="status"]').waitFor({ state: 'hidden' });
			assert.equal(await page.locator('aside.panel .error').count(), 0);
		} finally {
			await reset(page);
		}
	});

	test('a track gone from the server is passed over, with a word about it', async () => {
		subsonic.state.audio = { type: 'audio/wav', body: silentWav(30) };
		let first = null;
		failing((id) => {
			first ??= id;
			return id === first ? 404 : 0;
		});
		const page = await context.newPage();
		try {
			await page.goto(app.url + '/albums/al1', { waitUntil: 'networkidle' });
			await page.getByRole('button', { name: 'Play Song 1a', exact: true }).click();
			await page.locator('.hh-toast [role="status"]', { hasText: 'skipped Song 1a' }).waitFor();
			await page.waitForFunction(sounding, null, { timeout: 15_000 });
			assert.equal(await page.getByRole('button', { name: 'Pause Song 1b', exact: true }).count(), 1);
		} finally {
			await reset(page);
		}
	});

	/* The queue used to stop in silence here, with the button showing pause. */
	test('a next track whose preload failed is asked for again at its turn', async () => {
		subsonic.state.audio = { type: 'audio/wav', body: silentWav(3) };
		let first = null;
		failing((id, count) => {
			first ??= id;
			return id !== first && count === 1 ? 503 : 0;
		});
		const page = await context.newPage();
		try {
			await page.goto(app.url + '/albums/al1', { waitUntil: 'networkidle' });
			await page.getByRole('button', { name: 'Play Song 1a', exact: true }).click();
			await page.getByRole('button', { name: 'Pause Song 1b', exact: true }).waitFor({ timeout: 15_000 });
			await page.waitForFunction(sounding, null, { timeout: 8000 });
		} finally {
			await reset(page);
		}
	});

	/*
	 * A connection that hangs raises no error: the element waits for ever. The
	 * first 90 seconds of a track arrive, then nothing, on the first request
	 * only. Chromium reports nothing of a WAV until much of it has arrived: 12
	 * seconds of this one left it at `HAVE_NOTHING`.
	 */
	test('a stream that stops arriving is picked up from where it stopped', async () => {
		const body = silentWav(180);
		subsonic.state.audio = { type: 'audio/wav', body };
		const hung = [];
		const arrived = 8000 * 90;
		subsonic.state.onStream = (_, req, res) => {
			if (req.method !== 'GET' || hung.length > 0) return false;
			res.writeHead(206, {
				'content-type': 'audio/wav',
				'content-length': body.length,
				'content-range': `bytes 0-${body.length - 1}/${body.length}`,
				'accept-ranges': 'bytes'
			});
			res.write(body.subarray(0, arrived));
			hung.push(res);
			return true;
		};
		const page = await context.newPage();
		try {
			await page.goto(app.url + '/albums/al1', { waitUntil: 'networkidle' });
			await page.getByRole('button', { name: 'Play Song 1a', exact: true }).click();
			await page.waitForFunction(sounding, null, { timeout: 15_000 });
			// To 1:26, a few seconds short of where the bytes end.
			const bar = await page.locator('aside.panel [role=slider][aria-label="Seek within track"]').boundingBox();
			await page.mouse.click(bar.x + bar.width * 0.478, bar.y + bar.height / 2);
			await page.locator('aside.panel .transport .play[aria-busy=true]').waitFor({ timeout: 10_000 });
			// The 12 seconds of `STALL_MS`.
			await page.locator('.hh-toast [role="status"]', { hasText: 'Reconnecting' }).waitFor({ timeout: 16_000 });
			await page.waitForFunction(() => [...document.querySelectorAll('audio')].some((a) => !a.paused && a.currentTime > 92), null, { timeout: 15_000 });
			assert.equal(await page.locator('aside.panel .error').count(), 0);
		} finally {
			for (const res of hung) res.destroy();
			await reset(page);
		}
	});

	test('on a phone the failure shows on the dock, and a press on play tries again', async () => {
		subsonic.state.audio = { type: 'audio/wav', body: silentWav(30) };
		failing(() => 503);
		const phone = await browser.newContext({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true });
		await phone.request.post(`${app.url}/login`, {
			form: { username: 'testuser', password: 'testpass', backend: 'subsonic', next: '/' },
			headers: { origin: app.url, accept: 'text/html' },
			maxRedirects: 0
		});
		const page = await phone.newPage();
		try {
			await page.goto(app.url + '/albums/al1', { waitUntil: 'networkidle' });
			await page.getByRole('button', { name: 'Play', exact: true }).first().click();
			const failure = page.locator('.phone-dock .artist.failed');
			await failure.waitFor({ timeout: 15_000 });
			assert.match(await failure.textContent(), /Press play to try again/);
			assert.equal(await page.locator('.phone-dock .play').getAttribute('aria-label'), 'Play');

			subsonic.state.onStream = null;
			await page.locator('.phone-dock .play').click();
			await page.waitForFunction(sounding, null, { timeout: 15_000 });
			await failure.waitFor({ state: 'detached' });

			// On a phone the album's Queue button is in its More menu.
			await page.getByRole('button', { name: 'More', exact: true }).click();
			await page.getByRole('menuitem', { name: 'Add to queue' }).click();
			// The player's notices rise from the foot of the window, over the dock.
			await page.locator('.hh-toast [role="status"]', { hasText: /Queued \d+ tracks/ }).waitFor();
		} finally {
			await reset(page);
			await phone.close();
		}
	});

	/*
	 * The hold on a seek in a stream without ranges ended without clearing its
	 * spinner when another seek took its place, and nothing playing on clears it.
	 */
	test('a seek waiting on a transcode stays on the bar, and leaves no spinner when replaced', async () => {
		const headers = { origin: app.url, 'content-type': 'application/json' };
		await context.request.patch(`${app.url}/api/settings`, { headers, data: { transcode: true } });
		subsonic.state.audio = { type: 'audio/wav', body: silentWav(180) };
		subsonic.state.ignoreRange = true;
		subsonic.state.streamSlowMs = 25_000;
		const page = await context.newPage();
		try {
			await page.addInitScript(() => {
				const seekable = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'seekable');
				const none = { length: 0, start: () => 0, end: () => 0 };
				Object.defineProperty(HTMLMediaElement.prototype, 'seekable', {
					get() {
						return window.__seekable ? seekable.get.call(this) : none;
					}
				});
			});
			await page.goto(app.url + '/albums/al7', { waitUntil: 'domcontentloaded' });
			await page.getByRole('button', { name: 'Play', exact: true }).first().click();
			await page.waitForFunction(sounding, null, { timeout: 15_000 });

			const slider = page.locator('aside.panel [role=slider][aria-label="Seek within track"]');
			const bar = await slider.boundingBox();
			await page.mouse.click(bar.x + bar.width * 0.6, bar.y + bar.height / 2);
			const play = page.locator('aside.panel .transport .play');
			await page.locator('aside.panel .transport .play[aria-busy=true]').waitFor();
			await page.waitForTimeout(1500);
			assert.equal(await slider.getAttribute('aria-valuenow'), '108', 'the bar went back from where it was pressed');

			await page.evaluate(() => (window.__seekable = true));
			await slider.focus();
			await page.keyboard.press('Home');
			await page.waitForFunction(() => document.querySelector('aside.panel .transport .play').getAttribute('aria-busy') === 'false', null, { timeout: 5000 });
			// The spinner goes in the same update that clears `aria-busy`, and a slow
			// runner read between the two. Waited for instead of sampled once: a
			// spinner that never goes still fails, which is what this checks.
			await page.waitForFunction(() => !document.querySelector('aside.panel .transport .play .spinner'), null, { timeout: 5000 });
		} finally {
			subsonic.state.ignoreRange = false;
			subsonic.state.streamSlowMs = 0;
			await context.request.patch(`${app.url}/api/settings`, { headers, data: { transcode: false } });
			await reset(page);
		}
	});

	test('next is off at the end of the queue, and on again under repeat', async () => {
		subsonic.state.audio = { type: 'audio/wav', body: silentWav(30) };
		const page = await context.newPage();
		try {
			await page.goto(app.url + '/albums/al1', { waitUntil: 'networkidle' });
			const rows = page.locator('main .track');
			await rows.last().locator('.index').click();
			const next = page.locator('aside.panel').getByRole('button', { name: 'Next track', exact: true });
			await page.waitForFunction(sounding, null, { timeout: 15_000 });
			assert.equal(await next.isDisabled(), true);
			await page.locator('aside.panel').getByRole('button', { name: /^Repeat/ }).click();
			assert.equal(await next.isDisabled(), false);
			await page.locator('aside.panel').getByRole('button', { name: /^Repeat/ }).click();
			await page.locator('aside.panel').getByRole('button', { name: /^Repeat/ }).click();
		} finally {
			await reset(page);
		}
	});
});

describe('a shelf at the edge of the content column', () => {
	test('fades out at an end with more cards past it, and is whole at an end it stops at', async () => {
		const { page, problems } = await watchedPage();
		try {
			await page.goto(app.url + '/', { waitUntil: 'networkidle' });
			const track = page.locator('main .shelf .track').first();
			const edges = () =>
				track.evaluate((el) => {
					const style = getComputedStyle(el);
					return {
						start: style.getPropertyValue('--shelf-fade-start').trim(),
						end: style.getPropertyValue('--shelf-fade-end').trim(),
						masked: (style.maskImage || style.webkitMaskImage).startsWith('linear-gradient')
					};
				});
			// 40 albums do not fit: more to the right, none to the left.
			// Both lengths ease to their values, so each is waited for, not read once.
			const settled = async (start, end) =>
				page.waitForFunction(
					([el, start, end]) => {
						const style = getComputedStyle(el);
						return style.getPropertyValue('--shelf-fade-start').trim() === start && style.getPropertyValue('--shelf-fade-end').trim() === end;
					},
					[await track.elementHandle(), start, end]
				);
			await settled('0px', '48px');
			assert.deepEqual(await edges(), { start: '0px', end: '48px', masked: true });

			await track.evaluate((el) => el.scrollTo({ left: el.scrollWidth, behavior: 'instant' }));
			await settled('48px', '0px');
			assert.deepEqual(await edges(), { start: '48px', end: '0px', masked: true });
		} finally {
			await page.close();
		}
		assert.deepEqual(problems, []);
	});
});

describe('internet radio', () => {
	test('a station plays as a live item: no seeking, no track actions, nothing reported or saved', async () => {
		const host = await startStationHost();
		host.state.audio = { type: 'audio/wav', body: silentWav(30) };
		subsonic.state.radio = [
			{ id: '1', name: 'Mock FM', streamUrl: `${host.url}/moved`, homePageUrl: 'https://radio.example/mock' },
			{ id: '2', name: 'A web page', streamUrl: `${host.url}/page` }
		];
		const on = await startApp({
			subsonicUrl: subsonic.url,
			jellyfinUrl: jellyfin.url,
			env: { HEDDOHON_REMOTE_CONTROL: 'false', HEDDOHON_RADIO_PRIVATE: 'true' }
		});
		const view = await browser.newContext({ viewport: { width: 1440, height: 900 } });
		try {
			const signIn = await view.request.post(`${on.url}/login`, {
				form: { username: 'testuser', password: 'testpass', backend: 'subsonic', next: '/' },
				headers: { origin: on.url, accept: 'text/html' },
				maxRedirects: 0
			});
			assert.equal(signIn.status(), 303);
			const page = await view.newPage();
			const problems = [];
			page.on('pageerror', (err) => problems.push(err.message));
			const sent = [];
			page.on('request', (request) => {
				const path = new URL(request.url()).pathname;
				// The load reads the saved queue; a write of either kind is what must not happen.
				if (request.method() !== 'GET' && (path === '/api/playback' || path === '/api/play-state')) sent.push(`${request.method()} ${path}`);
			});

			// The rail has the link where the music server keeps stations.
			await page.goto(on.url + '/', { waitUntil: 'networkidle' });
			await page.locator('nav.rail a[href="/radio"]').click();
			await page.waitForURL(/\/radio$/);
			assert.equal(await page.getByRole('link', { name: 'radio.example' }).getAttribute('rel'), 'noopener noreferrer');

			await page.getByRole('button', { name: 'Play Mock FM' }).click();
			await page.waitForFunction(() => [...document.querySelectorAll('audio')].some((a) => !a.paused && a.currentTime > 0.3));
			const panel = page.locator('aside.panel');
			assert.equal(await panel.locator('h2.title').innerText(), 'Mock FM');
			assert.match(await panel.locator('.times').innerText(), /Live/);
			assert.match(await page.evaluate(() => [...document.querySelectorAll('audio')].find((a) => !a.paused).src), /\/api\/radio\/1\/stream$/);
			// Nothing to favour, list, read, inspect or share.
			assert.equal(await panel.getByRole('button', { name: 'Add to playlist' }).count(), 0);
			assert.equal(await panel.locator('.rounds').count(), 0);
			for (const name of ['Track details', 'Lyrics']) assert.equal(await panel.getByRole('button', { name }).isDisabled(), true, name);

			// A seek does nothing.
			// Against the time that passed: under load a live stream stalls and
			// then catches up, which moves it on by more than the 300ms waited.
			const now = () => page.evaluate(() => ({ at: [...document.querySelectorAll('audio')].find((a) => !a.paused).currentTime, clock: performance.now() / 1000 }));
			const before = await now();
			await panel.getByRole('slider', { name: 'Seek within track' }).press('End');
			await page.waitForTimeout(300);
			const after = await now();
			assert.ok(after.at >= before.at && after.at - before.at < after.clock - before.clock + 1, `${before.at} to ${after.at} in ${after.clock - before.clock}s`);

			// The row pauses and resumes the station it is playing.
			await page.getByRole('button', { name: 'Pause Mock FM' }).click();
			await page.waitForFunction(() => [...document.querySelectorAll('audio')].every((a) => a.paused));
			await page.getByRole('button', { name: 'Play Mock FM' }).click();
			await page.waitForFunction(() => [...document.querySelectorAll('audio')].some((a) => !a.paused));

			// Long enough for the debounced queue save (1.2s) had there been one.
			await page.waitForTimeout(1600);
			assert.deepEqual(sent, [], 'no playback report and no saved queue for a station');
			assert.equal(host.calls.get('/live'), 1, 'resumed, not fetched again');

			// A station that is not a stream says so in the player, and the page stays up.
			await page.getByRole('button', { name: 'Play A web page' }).click();
			await page.waitForFunction(() => document.querySelector('aside.panel h2.title')?.textContent === 'A web page');
			await page.waitForTimeout(500);
			assert.deepEqual(problems, []);
		} finally {
			subsonic.state.radio = [];
			await view.close();
			await on.stop();
			await host.close();
		}
	});
});

describe('the bars a phone paints around the page', () => {
	test('on the home page, there is no settings button, and the title and Shuffle something do not overlap', async () => {
		for (const viewport of [
			{ width: 393, height: 852 },
			{ width: 360, height: 780 },
			{ width: 820, height: 1180 }
		]) {
			const phone = await browser.newContext({ viewport, isMobile: true, hasTouch: true });
			const signIn = await phone.request.post(`${app.url}/login`, {
				form: { username: 'testuser', password: 'testpass', backend: 'subsonic', next: '/' },
				headers: { origin: app.url, accept: 'text/html' },
				maxRedirects: 0
			});
			assert.equal(signIn.status(), 303);
			const page = await phone.newPage();
			try {
				await page.goto(app.url + '/', { waitUntil: 'networkidle' });
				const boxes = await page.evaluate(() => {
					const box = (selector) => {
						const rect = document.querySelector(selector).getBoundingClientRect();
						return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
					};
					return {
						settings: document.querySelectorAll('.masthead a[href="/settings"]').length,
						shuffle: box('.masthead .shuffle'),
						title: box('.masthead h1'),
						width: innerWidth
					};
				});
				const apart = (a, b) => a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top;
				const at = `${viewport.width}px`;
				// Settings is under the Library tab on a phone, not on the home page.
				assert.equal(boxes.settings, 0, `${at}: a settings button on the home page`);
				assert.ok(apart(boxes.title, boxes.shuffle), `${at}: ${JSON.stringify(boxes)}`);
				assert.ok(boxes.shuffle.right <= boxes.width, `${at}: Shuffle something runs off the screen`);
			} finally {
				await phone.close();
			}
		}
	});

	/*
	 * iOS zooms in on a field under 16px as it is focused and stays zoomed:
	 * signing in on a phone left the home page a little too large. Every field
	 * shown on a touch screen is at least 16px, in Terminal's mono as well.
	 */
	test('on a touch screen no field is small enough for iOS to zoom in on', async () => {
		const phone = await browser.newContext({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true });
		const settings = (patch) => phone.request.patch(`${app.url}/api/settings`, { data: patch, headers: { origin: app.url } });
		const small = (page) =>
			page.evaluate(() =>
				[...document.querySelectorAll('input, select, textarea')]
					.filter((field) => field.getClientRects().length && field.type !== 'hidden')
					.map((field) => `${field.name || field.type || field.tagName}: ${getComputedStyle(field).fontSize}`)
					.filter((entry) => Number.parseFloat(entry.split(': ')[1]) < 16)
			);
		const page = await phone.newPage();
		try {
			await page.goto(app.url + '/login', { waitUntil: 'networkidle' });
			assert.deepEqual(await small(page), [], 'fields on the sign-in page');
			const signIn = await phone.request.post(`${app.url}/login`, {
				form: { username: 'testuser', password: 'testpass', backend: 'subsonic', next: '/' },
				headers: { origin: app.url, accept: 'text/html' },
				maxRedirects: 0
			});
			assert.equal(signIn.status(), 303);
			for (const theme of ['dark', 'terminal']) {
				await settings({ theme });
				for (const path of ['/search', '/settings']) {
					await page.goto(app.url + path, { waitUntil: 'networkidle' });
					assert.deepEqual(await small(page), [], `fields on ${path} in ${theme}`);
				}
			}
		} finally {
			await settings({ theme: 'dark' });
			await phone.close();
		}
	});

	test('under the status bar of an installed app on iOS, the strip the clock is read against is dark in both themes', async () => {
		const settings = (patch) => context.request.patch(`${app.url}/api/settings`, { data: patch, headers: { origin: app.url } });
		const phone = await browser.newContext({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true });
		const signIn = await phone.request.post(`${app.url}/login`, {
			form: { username: 'testuser', password: 'testpass', backend: 'subsonic', next: '/' },
			headers: { origin: app.url, accept: 'text/html' },
			maxRedirects: 0
		});
		assert.equal(signIn.status(), 303);
		/** The strip's colour over the theme's ground, and the contrast of iOS's white clock on it. */
		const strip = async () => {
			const page = await phone.newPage();
			try {
				await page.goto(app.url + '/', { waitUntil: 'networkidle' });
				return await page.evaluate(() => {
					const shell = document.querySelector('.app');
					const after = getComputedStyle(shell, '::after');
					const canvas = document.createElement('canvas').getContext('2d');
					canvas.fillStyle = getComputedStyle(document.body).backgroundColor;
					canvas.fillRect(0, 0, 1, 1);
					canvas.fillStyle = after.backgroundColor;
					canvas.fillRect(0, 0, 1, 1);
					const [r, g, b] = canvas.getImageData(0, 0, 1, 1).data;
					const linear = (part) => (part / 255 <= 0.03928 ? part / 255 / 12.92 : ((part / 255 + 0.055) / 1.055) ** 2.4);
					const luminance = 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
					return { position: after.position, height: after.height, contrast: 1.05 / (luminance + 0.05) };
				});
			} finally {
				await page.close();
			}
		};
		try {
			const dark = await strip();
			assert.equal(dark.position, 'fixed');
			assert.ok(dark.contrast >= 4.5, `dark theme: ${dark.contrast.toFixed(1)} to 1`);
			await settings({ theme: 'light' });
			const light = await strip();
			assert.ok(light.contrast >= 4.5, `light theme: ${light.contrast.toFixed(1)} to 1`);
		} finally {
			await settings({ theme: 'dark' });
			await phone.close();
		}
	});

	test('theme-color follows the canvas: lit by the playing cover, and the light theme\'s ground in the light theme', async () => {
		const settings = (patch) => context.request.patch(`${app.url}/api/settings`, { data: patch, headers: { origin: app.url } });
		subsonic.state.audio = { type: 'audio/wav', body: silentWav(30) };
		// Album 33, whose cover no test before this one has asked for: a cover is cached once fetched.
		subsonic.state.coverColors.set('al-33', [220, 60, 30]);
		const { page, problems } = await watchedPage();
		const seen = () =>
			page.evaluate(() => {
				const hex = document.querySelector('meta[name="theme-color"]').getAttribute('content');
				const canvas = document.createElement('canvas').getContext('2d');
				canvas.fillStyle = getComputedStyle(document.documentElement).backgroundColor;
				canvas.fillRect(0, 0, 1, 1);
				const [r, g, b] = canvas.getImageData(0, 0, 1, 1).data;
				return { hex, meta: [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16)), canvas: [r, g, b] };
			});
		/*
		 * The colour eases for 900ms and the bar is written again once it has
		 * landed. Waits for the two to agree, up to 8s, rather than a fixed
		 * time: with three browser files running side by side the bar was one
		 * step behind the canvas after 2.2s. A wrong colour still fails below.
		 */
		const settled = async () => {
			const deadline = Date.now() + 8000;
			let last = await seen();
			while (Date.now() < deadline && last.meta.join() !== last.canvas.join()) {
				await page.waitForTimeout(200);
				last = await seen();
			}
			return last;
		};
		try {
			await page.goto(app.url + '/albums/al33', { waitUntil: 'networkidle' });
			await page.getByRole('button', { name: 'Play Song 33a', exact: true }).click();
			await page.waitForFunction(() => [...document.querySelectorAll('audio')].some((a) => !a.paused && a.currentTime > 0));
			await page.waitForTimeout(1000);
			const dark = await settled();
			assert.deepEqual(dark.meta, dark.canvas, 'the bar is the canvas colour');
			assert.notEqual(dark.hex, '#0b0c0f', 'and no longer the bare ground');
			assert.ok(dark.meta[0] > dark.meta[2] + 8, `lit by a red cover: ${dark.hex}`);

			await settings({ theme: 'light' });
			await page.goto(app.url + '/albums/al33', { waitUntil: 'networkidle' });
			const light = await settled();
			assert.deepEqual(light.meta, light.canvas);
			assert.ok(Math.min(...light.meta) > 180, `the light theme's bar is light: ${light.hex}`);
		} finally {
			await settings({ theme: 'dark' });
			subsonic.state.audio = null;
			subsonic.state.coverColors.delete('al-33');
			await page.close();
		}
		assert.deepEqual(problems, []);
	});
});
