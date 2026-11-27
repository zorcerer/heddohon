/**
 * On a phone: the dock, the sheet and the pages, and the scroll position between pages.
 *
 *   npm run build
 *   node --test tests/browser/phone.test.mjs
 *
 * Runs the built app against the mock servers of `tests/e2e`; see `suite.mjs`.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { silentWav } from '../e2e/mocks.mjs';
import { subsonic, app, browser, context, shown, watchedPage, setUpSuite } from './suite.mjs';

setUpSuite();

describe('on a phone', () => {
	/*
	 * Safari on iOS 26 draws the page behind its toolbar only from the
	 * document's own scroll, and fills the strip under the status bar and the
	 * band behind the toolbar with the page's background colour. With the
	 * content column scrolling inside a box one screen tall, an iPhone showed
	 * the page ending at the top of the toolbar with a dark band below.
	 */
	let phone;

	before(async () => {
		phone = await browser.newContext({ viewport: { width: 393, height: 641 }, isMobile: true, hasTouch: true });
		const signIn = await phone.request.post(`${app.url}/login`, {
			form: { username: 'testuser', password: 'testpass', backend: 'subsonic', next: '/' },
			headers: { origin: app.url, accept: 'text/html' },
			maxRedirects: 0
		});
		assert.equal(signIn.status(), 303);
	});

	after(async () => {
		await phone?.close();
	});

	async function phonePage(path) {
		const page = await phone.newPage();
		const problems = [];
		page.on('console', (message) => {
			if (message.type() === 'error') problems.push(`${page.url()}: ${message.text()}`);
		});
		page.on('pageerror', (err) => problems.push(`${page.url()}: ${err.message}`));
		await page.goto(app.url + path, { waitUntil: 'networkidle' });
		return { page, problems };
	}

	/*
	 * A tap, not `click()`: Playwright scrolls a target into view before
	 * clicking, and with the dock pinned that moved a scrolled page, which a
	 * finger on the dock does not.
	 *
	 * Tapped once the target has held still for a frame. After a scroll the
	 * dock folds its tabs and `#dock-open` slides 56px down over about 200ms
	 * (at 393x641). Measured at the start of that and tapped at the end, the
	 * tap landed above the button and the sheet did not open, which failed CI
	 * twice on 2026-09-28.
	 */
	async function tap(page, locator) {
		let box = await locator.boundingBox();
		for (let frame = 0; frame < 60; frame++) {
			await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => done())));
			const next = await locator.boundingBox();
			const still = box && next && box.x === next.x && box.y === next.y && box.width === next.width && box.height === next.height;
			box = next;
			if (still) break;
		}
		await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
	}

	/*
	 * A drag from the middle of `locator`, by the mouse. Playwright's
	 * touchscreen only taps, and the mouse sends the pointer events a finger
	 * does, which is all the dock and the sheet listen to.
	 *
	 * One step a frame, 16ms apart, as a finger's events arrive. Sent as fast
	 * as Playwright can, a 60px pull measured as a flick in WebKit and closed
	 * the sheet.
	 */
	async function drag(page, locator, dx, dy) {
		const box = await locator.boundingBox();
		const x = box.x + box.width / 2;
		const y = box.y + box.height / 2;
		await page.mouse.move(x, y);
		await page.mouse.down();
		for (let step = 1; step <= 10; step++) {
			await page.mouse.move(x + (dx * step) / 10, y + (dy * step) / 10);
			await page.waitForTimeout(16);
		}
		await page.mouse.up();
	}

	const dockTitle = (page) => page.locator('.phone-dock .now .title').textContent();
	const sheetOpen = (page) => page.evaluate(() => document.querySelector('.app').classList.contains('player-open'));

	/** Plays album `al{n}` from its first track, and waits for the dock to show it. */
	async function playAlbum(page, n) {
		await page.goto(`${app.url}/albums/al${n}`, { waitUntil: 'networkidle' });
		const row = page.getByRole('button', { name: `Play Song ${n}a`, exact: true });
		// Under the sleeve, below the fold of a 641px screen: brought to the
		// middle, clear of the dock, as a thumb would scroll it.
		await row.evaluate((el) => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
		// The queue is saved 1.2 seconds after it changes. A test that loads
		// another page straight after this one counts on the saved queue being
		// this one: in CI the load has twice come first, and the dock came back
		// empty.
		const saved = page.waitForResponse((response) => response.url().endsWith('/api/play-state') && response.request().method() === 'PUT');
		await tap(page, row);
		await page.waitForFunction(
			(title) => document.querySelector('.phone-dock .now .title')?.textContent === title,
			`Song ${n}a`
		);
		await saved;
	}

	test('the dock is the navigation, with the tab for the page lit', async () => {
		const { page, problems } = await phonePage('/albums');
		try {
			assert.equal(await page.locator('nav.rail').isVisible(), false, 'the rail is still shown');
			const nav = page.getByRole('navigation', { name: 'Primary' });
			const labels = (await nav.getByRole('link').allTextContents()).map((text) => text.trim());
			assert.deepEqual(labels, ['Home', 'Library', 'Favourites', 'Search']);
			const lit = () => nav.locator('[aria-current="page"]').textContent().then((text) => text?.trim());
			assert.equal(await lit(), 'Library', 'the albums page is in the library');

			await tap(page, nav.getByRole('link', { name: 'Search' }));
			await page.waitForURL(/\/search$/);
			assert.equal(await lit(), 'Search');

			await tap(page, nav.getByRole('link', { name: 'Library' }));
			await page.waitForURL(/\/library$/);
			const ways = page.getByRole('navigation', { name: 'Library' });
			for (const name of ['Albums', 'Artists', 'Playlists', 'Genres']) {
				await ways.getByRole('link', { name }).waitFor({ state: 'visible', timeout: 5000 });
			}
		} finally {
			await page.close();
		}
		assert.deepEqual(problems, []);
	});

	test('the document scrolls to the bottom edge, and the last row clears the dock', async () => {
		// The artists page: 40 of them run to 7800px on a phone.
		const { page, problems } = await phonePage('/artists');
		try {
			await page.evaluate(() => scrollTo(0, 1500));
			await page.waitForTimeout(100);
			const middle = await page.evaluate(() => ({
				scrollY,
				contentOverflow: getComputedStyle(document.querySelector('main.content')).overflowY,
				dockBottom: document.querySelector('.phone-dock').getBoundingClientRect().bottom,
				height: innerHeight
			}));
			assert.equal(middle.scrollY, 1500, 'the document did not scroll');
			assert.equal(middle.contentOverflow, 'visible', 'the content column is still a scroller');
			assert.equal(middle.dockBottom, middle.height - 12, 'the dock is not pinned 12px above the foot');

			await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
			await page.waitForTimeout(500);
			const foot = await page.evaluate(() => ({
				lastRow: document.querySelector('main.content').lastElementChild.getBoundingClientRect().bottom,
				dockTop: document.querySelector('.phone-dock').getBoundingClientRect().top
			}));
			assert.ok(foot.lastRow <= foot.dockTop, `the page ends at ${foot.lastRow}, under the dock at ${foot.dockTop}`);
		} finally {
			await page.close();
		}
		assert.deepEqual(problems, []);
	});

	/*
	 * Scrolled, the content cell runs behind the dock, and the veil in it
	 * faded behind the glass. See 'moving between pages' above.
	 */
	test('the veil stays out from behind the dock on a scrolled page', async () => {
		const { page, problems } = await phonePage('/');
		try {
			await page.evaluate(() => {
				scrollTo(0, 1500);
				const seen = (window.__veil = []);
				const box = (el) => {
					const r = el.getBoundingClientRect();
					return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
				};
				const watch = () => {
					const veil = document.querySelector('.page-veil');
					if (veil) seen.push({ veil: box(veil), dock: box(document.querySelector('.phone-dock')) });
					if (seen.length < 5) requestAnimationFrame(watch);
				};
				requestAnimationFrame(watch);
			});
			await tap(page, page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Library' }));
			await page.waitForFunction(() => window.__veil.length >= 5, null, { timeout: 5000 });
			const samples = await page.evaluate(() => window.__veil);

			const overlaps = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
			for (const { veil, dock } of samples) {
				assert.ok(!overlaps(veil, dock), `the veil ${JSON.stringify(veil)} is behind the dock ${JSON.stringify(dock)}`);
			}
		} finally {
			await page.close();
		}
		assert.deepEqual(problems, []);
	});

	/*
	 * A back on a phone usually follows a swipe that has already shown the
	 * move. It held the page being left for 172ms under the veil and animated
	 * the one returned to until 663ms (a Pixel 7's viewport, 2026-10-06).
	 */
	test('back puts the page in at once, where it was left, without the veil or the rise', async () => {
		const { page, problems } = await phonePage('/artists');
		try {
			await page.evaluate(() => scrollTo(0, 900));
			await page.waitForTimeout(300);
			// A forward navigation keeps the veil.
			await page.evaluate(() => {
				window.__veiled = 0;
				const watch = () => {
					if (document.querySelector('.page-veil')) window.__veiled += 1;
					requestAnimationFrame(watch);
				};
				requestAnimationFrame(watch);
			});
			const link = page.locator('main a[href^="/artists/"]').nth(12);
			const href = await link.getAttribute('href');
			await tap(page, link);
			await page.waitForURL((url) => url.pathname === href);
			// Past the veil (gone by 663ms) and the 900ms the rise is held for.
			await page.waitForTimeout(1200);
			assert.ok((await page.evaluate(() => window.__veiled)) > 0, 'the page opened without the veil');

			await page.evaluate(() => {
				const seen = (window.__back = { veil: 0, rising: 0, transitions: 0, frames: 0 });
				const until = performance.now() + 1200;
				const watch = () => {
					seen.frames += 1;
					if (document.querySelector('.page-veil')) seen.veil += 1;
					if (document.querySelector('main.content.rising')) seen.rising += 1;
					if (document.getAnimations().some((a) => (a.effect?.pseudoElement ?? '').startsWith('::view-transition'))) seen.transitions += 1;
					if (performance.now() < until) requestAnimationFrame(watch);
				};
				requestAnimationFrame(watch);
			});
			await page.goBack();
			await page.waitForURL(/\/artists$/);
			await page.waitForTimeout(1300);
			const seen = await page.evaluate(() => window.__back);
			assert.ok(seen.frames > 10, 'the page was not watched');
			assert.deepEqual({ veil: seen.veil, rising: seen.rising, transitions: seen.transitions }, { veil: 0, rising: 0, transitions: 0 });
			assert.equal(await page.evaluate(() => scrollY), 900, 'back did not return to where the list was left');
		} finally {
			await page.close();
		}
		assert.deepEqual(problems, []);
	});

	describe('with a track playing', () => {
		before(() => {
			subsonic.state.audio = { type: 'audio/wav', body: silentWav(60) };
		});

		after(() => {
			subsonic.state.audio = null;
		});

		test('the dock shows it, and opens the sheet, which holds the page still', async () => {
			const { page, problems } = await phonePage('/');
			try {
				await playAlbum(page, 12);
				// A page that scrolls, with the queue restored into the dock.
				await page.goto(app.url + '/artists', { waitUntil: 'networkidle' });
				await page.waitForFunction(() => document.querySelector('.phone-dock .now .title')?.textContent === 'Song 12a');
				assert.equal(await sheetOpen(page), false, 'the sheet is open on arrival');

				await page.evaluate(() => scrollTo(0, 600));
				await tap(page, page.locator('#dock-open'));
				// Waited for rather than timed: a slow runner took longer than 600ms.
				await page.waitForFunction(() => document.querySelector('.app').classList.contains('player-open'), null, {
					timeout: 5000
				});
				await page.waitForTimeout(300);
				await page.mouse.move(200, 400);
				await page.mouse.wheel(0, 800);
				await page.waitForTimeout(300);
				assert.equal(await page.evaluate(() => scrollY), 600, 'the page scrolled under the open sheet');
				// The page around the open sheet is blurred, by a layer under it that is never faded.
				const backdrop = () =>
					page.locator('.sheet-backdrop').evaluate((node) => {
						const style = getComputedStyle(node);
						return { shown: style.visibility, blur: style.backdropFilter || style.webkitBackdropFilter, under: Number(style.zIndex) };
					});
				assert.deepEqual(await backdrop(), { shown: 'visible', blur: 'blur(6px)', under: 44 });

				await tap(page, page.locator('#player-hide'));
				await page.waitForFunction(() => !document.querySelector('.app').classList.contains('player-open'), null, {
					timeout: 5000
				});
				await page.waitForTimeout(300);
				assert.equal(await page.evaluate(() => document.activeElement?.id), 'dock-open', 'focus is not back on the dock');
				assert.equal((await backdrop()).shown, 'hidden', 'the page stayed blurred with the sheet closed');
				await page.mouse.wheel(0, 800);
				await page.waitForTimeout(300);
				assert.ok((await page.evaluate(() => scrollY)) > 600, 'the page does not scroll once the sheet is closed');
			} finally {
				await page.close();
			}
			assert.deepEqual(problems, []);
		});

		test('a swipe on the dock skips, and a short one does not', async () => {
			const { page, problems } = await phonePage('/');
			try {
				await playAlbum(page, 13);
				const now = page.locator('.phone-dock .now');

				await drag(page, now, -30, 0);
				await page.waitForTimeout(300);
				assert.equal(await dockTitle(page), 'Song 13a', 'a 30px swipe changed the track');

				await drag(page, now, -120, 0);
				await page.waitForFunction(() => document.querySelector('.phone-dock .now .title')?.textContent === 'Song 13b');

				await drag(page, now, 120, 0);
				await page.waitForFunction(() => document.querySelector('.phone-dock .now .title')?.textContent === 'Song 13a');
				assert.equal(await sheetOpen(page), false, 'a swipe also opened the sheet');

				await drag(page, now, 0, -90);
				await page.waitForTimeout(600);
				assert.equal(await sheetOpen(page), true, 'a swipe up did not open the sheet');
			} finally {
				await page.close();
			}
			assert.deepEqual(problems, []);
		});

		test('the sheet closes when pulled down, and springs back from a short pull', async () => {
			const { page, problems } = await phonePage('/');
			try {
				await playAlbum(page, 14);
				const url = page.url();
				await tap(page, page.locator('#dock-open'));
				await page.waitForTimeout(600);

				await drag(page, page.locator('aside.panel .grabber'), 0, 60);
				await page.waitForTimeout(600);
				assert.equal(await sheetOpen(page), true, 'a 60px pull closed the sheet');
				// Settled at the top: with the browser files running side by side the
				// spring was still 2.6px short after 600ms.
				await page
					.waitForFunction(() => document.querySelector('aside.panel')?.getBoundingClientRect().top === 12, null, { timeout: 3000 })
					.catch(() => {});
				const top = await page.locator('aside.panel').evaluate((el) => el.getBoundingClientRect().top);
				assert.equal(top, 12, 'the sheet did not go back up');

				// By the artwork, which is a link: the pull must not follow it.
				await drag(page, page.locator('aside.panel a.art'), 0, 260);
				await page.waitForTimeout(600);
				assert.equal(await sheetOpen(page), false, 'a 260px pull did not close the sheet');
				assert.equal(page.url(), url, 'the pull followed the artwork link');
			} finally {
				await page.close();
			}
			assert.deepEqual(problems, []);
		});

		test('the cover flies into the sheet at full size, with the sheet\'s own cover hidden until it lands', async () => {
			const { page, problems } = await phonePage('/');
			try {
				await playAlbum(page, 17);
				await tap(page, page.locator('#dock-open'));
				await page.waitForFunction(() => document.querySelector('.hh-cover-ghost'));
				// Held at 400 of 480ms, where the sheet is within a few pixels of
				// open. The flying cover used to be at 367 by 74 here, a strip
				// across the dock, measured from the sheet while it was squashed.
				const frame = await page.evaluate(() => {
					for (const animation of document.getAnimations()) {
						animation.pause();
						animation.currentTime = 400;
					}
					const art = document.querySelector('aside.panel .stage .art');
					const a = art.getBoundingClientRect();
					const g = document.querySelector('.hh-cover-ghost').getBoundingClientRect();
					return {
						apart: Math.max(Math.abs(a.left - g.left), Math.abs(a.top - g.top), Math.abs(a.width - g.width), Math.abs(a.height - g.height)),
						art: getComputedStyle(art).visibility
					};
				});
				assert.ok(frame.apart <= 3, `the flying cover is ${frame.apart}px off the sheet's cover`);
				assert.equal(frame.art, 'hidden', 'the sheet\'s own cover shows during the morph');
				await page.evaluate(() => document.getAnimations().forEach((animation) => animation.play()));
				await page.waitForFunction(() => !document.querySelector('.hh-cover-ghost'));
				assert.equal(
					await page.locator('aside.panel .stage .art').evaluate((el) => getComputedStyle(el).visibility),
					'visible',
					'the sheet\'s cover stayed hidden'
				);

				await tap(page, page.locator('#player-hide'));
				await page.waitForFunction(() => document.querySelector('.hh-cover-ghost'));
				assert.equal(
					await page.locator('aside.panel .stage .art').evaluate((el) => getComputedStyle(el).visibility),
					'hidden',
					'the sheet\'s own cover shows while it closes'
				);
			} finally {
				await page.close();
			}
			assert.deepEqual(problems, []);
		});

		/*
		 * Terminal's duotone: the dock's cover is in colour and the sheet's in
		 * two tones. The flying cover went the whole way in colour, and the
		 * sheet's turned to the tone in one frame as it landed.
		 */
		test('in duotone, the flying cover turns from the dock\'s colour to the sheet\'s two tones', async () => {
			const settings = (patch) => phone.request.patch(`${app.url}/api/settings`, { data: patch, headers: { origin: app.url } });
			await settings({ theme: 'terminal', playerArt: 'duotone' });
			const { page, problems } = await phonePage('/');
			const at = (time) =>
				page.evaluate((time) => {
					for (const animation of document.getAnimations()) {
						animation.pause();
						animation.currentTime = time;
					}
					const art = document.querySelector('aside.panel .stage .art');
					const ghost = document.querySelector('.hh-cover-ghost');
					const tone = ghost.querySelector('span');
					return {
						picture: getComputedStyle(ghost.querySelector('img')).filter,
						tone: tone && getComputedStyle(tone).opacity,
						fill: tone && getComputedStyle(tone).backgroundColor,
						sheet: getComputedStyle(art, '::after').backgroundColor,
						sheetPicture: getComputedStyle(art.querySelector('.cover')).filter
					};
				}, time);
			try {
				await playAlbum(page, 19);
				await page.waitForFunction(() => {
					const art = document.querySelector('aside.panel .art');
					return art && /^rgb\(/.test(getComputedStyle(art, '::after').backgroundColor);
				});
				await tap(page, page.locator('#dock-open'));
				await page.waitForFunction(() => document.querySelector('.hh-cover-ghost'));
				const leaving = await at(0);
				assert.match(leaving.picture, /^(none|grayscale\(0\) contrast\(1\))$/, 'the cover leaves the dock in grey');
				assert.equal(leaving.tone, '0', 'the cover leaves the dock toned');
				const landing = await at(479);
				assert.match(landing.picture, /grayscale\((0\.99\d*|1)\)/);
				assert.ok(Number(landing.tone) > 0.99, `the tone is at ${landing.tone} as the cover lands`);
				assert.equal(landing.fill, landing.sheet, 'the flying cover takes another tone than the sheet\'s');
				assert.match(landing.sheetPicture, /grayscale\(1\)/);
			} finally {
				await settings({ theme: 'dark', playerArt: 'dither' });
				await page.close();
			}
			assert.deepEqual(problems, []);
		});

		/*
		 * Every other way of drawing the sheet's cover: the flying one took
		 * neither its layer (scanlines, dots, grain) nor the fade at its foot,
		 * and both snapped on as it landed. Scanlines here, and the fade in
		 * Liquid, which has its grain under the same mask.
		 */
		for (const [theme, playerArt] of [
			['terminal', 'scanlines'],
			['terminal', 'dither'],
			['dark', 'dither']
		]) {
			test(`in ${theme} with ${playerArt}, the flying cover takes on the sheet's layer and fade on the way`, async () => {
				const settings = (patch) => phone.request.patch(`${app.url}/api/settings`, { data: patch, headers: { origin: app.url } });
				await settings({ theme, playerArt });
				const { page, problems } = await phonePage('/');
				const at = (time) =>
					page.evaluate((time) => {
						for (const animation of document.getAnimations()) {
							animation.pause();
							animation.currentTime = time;
						}
						const art = document.querySelector('aside.panel .stage .art');
						const ghost = document.querySelector('.hh-cover-ghost');
						const inside = getComputedStyle(ghost.firstElementChild);
						const layer = getComputedStyle(ghost.querySelector('span'));
						const sheet = getComputedStyle(art, '::after');
						return {
							layer: layer.opacity,
							same: layer.backgroundImage === sheet.backgroundImage && layer.maskImage === sheet.maskImage,
							drawn: sheet.backgroundImage,
							mask: inside.maskImage || inside.webkitMaskImage,
							sheetMask: getComputedStyle(art).maskImage || getComputedStyle(art).webkitMaskImage,
							size: inside.maskSize || inside.webkitMaskSize
						};
					}, time);
				try {
					await playAlbum(page, 19);
					await tap(page, page.locator('#dock-open'));
					await page.waitForFunction(() => document.querySelector('.hh-cover-ghost'));
					const leaving = await at(0);
					assert.equal(leaving.layer, '0', 'the cover leaves the dock with the sheet\'s layer on');
					assert.equal(leaving.size, '100% 200%', 'the cover leaves the dock faded');
					const landing = await at(479);
					assert.notEqual(landing.drawn, 'none', 'the sheet\'s cover has no layer to take');
					assert.ok(landing.same, 'the flying cover takes another layer than the sheet\'s');
					assert.ok(Number(landing.layer) > 0.99, `the layer is at ${landing.layer} as the cover lands`);
					assert.equal(landing.mask, landing.sheetMask, 'the flying cover takes another fade than the sheet\'s');
					assert.match(landing.size, /^100% 100\.\d+%$|^100% 100%$/, `the fade is at ${landing.size} as the cover lands`);
				} finally {
					await settings({ theme: 'dark', playerArt: 'dither' });
					await page.close();
				}
				assert.deepEqual(problems, []);
			});
		}

		test('the sheet closes into the dock, and leaves nothing behind', async () => {
			const { page, problems } = await phonePage('/');
			try {
				await playAlbum(page, 17);
				await tap(page, page.locator('#dock-open'));
				await page.waitForTimeout(700);

				await tap(page, page.locator('#player-hide'));
				const midway = await page
					.waitForFunction(() => {
						const wrapper = document.querySelector('.app > .player');
						const dock = document.querySelector('.phone-dock').getBoundingClientRect();
						const sheet = wrapper.getBoundingClientRect();
						// Shrinking toward the dock, not sliding down past it.
						const shrinking = sheet.height < innerHeight - 24 && sheet.top > 12 && sheet.bottom <= dock.bottom + 1;
						const ghost = document.querySelectorAll('.hh-cover-ghost').length;
						const translate = getComputedStyle(wrapper).translate;
						if (!shrinking || ghost !== 1 || translate !== 'none') return false;
						return { ghost, translate, shrinking };
					}, null, { timeout: 2000 })
					.then((handle) => handle.jsonValue());
				assert.equal(midway.ghost, 1, 'no cover flying to the dock');
				assert.equal(midway.translate, 'none', 'the sheet is sliding, not morphing');
				assert.ok(midway.shrinking, 'the sheet is not shrinking into the dock');

				// The dock fades in from the frame the sheet goes, and the flying
				// cover stays over the dock's art until that fade ends. Removed
				// with the sheet, the cover blinked out while the dock was still
				// at opacity 0, which read as the close redrawing itself.
				const arriving = await page
					.waitForFunction(() => {
						const sheet = document.querySelector('.app > .player');
						if (getComputedStyle(sheet).visibility !== 'hidden') return false;
						const dock = document.querySelector('.phone-dock');
						const style = getComputedStyle(dock);
						return {
							visibility: style.visibility,
							opacity: Number(style.opacity),
							ghost: document.querySelectorAll('.hh-cover-ghost').length
						};
					}, null, { timeout: 2000 })
					.then((handle) => handle.jsonValue());
				assert.equal(arriving.visibility, 'visible', 'the dock is still hidden as the sheet goes');
				assert.equal(arriving.ghost, 1, 'the cover left with the sheet, before the dock was in');
				assert.ok(arriving.opacity < 1, `the dock is already full as the sheet goes (${arriving.opacity})`);

				await page.waitForTimeout(700);
				const after = await page.evaluate(() => {
					const wrapper = document.querySelector('.app > .player');
					return {
						ghost: document.querySelectorAll('.hh-cover-ghost').length,
						visibility: getComputedStyle(wrapper).visibility,
						transform: getComputedStyle(wrapper).transform,
						held: wrapper.classList.contains('morphing') || wrapper.classList.contains('parking'),
						dock: Number(getComputedStyle(document.querySelector('.phone-dock')).opacity)
					};
				});
				assert.deepEqual(after, { ghost: 0, visibility: 'hidden', transform: 'none', held: false, dock: 1 });
				assert.equal(await page.locator('.phone-dock').isVisible(), true, 'the dock is not back');
			} finally {
				await page.close();
			}
			assert.deepEqual(problems, []);
		});

		test('a link in the sheet opens its page with the sheet gone', async () => {
			const { page, problems } = await phonePage('/');
			try {
				await playAlbum(page, 15);
				await page.goto(app.url + '/', { waitUntil: 'networkidle' });
				await page.waitForSelector('#dock-open');
				await tap(page, page.locator('#dock-open'));
				await page.waitForTimeout(600);
				await tap(page, page.locator('aside.panel .artist a'));
				await page.waitForURL(/\/artists\/ar15$/);
				await page.waitForTimeout(600);
				assert.equal(await sheetOpen(page), false, 'the sheet is still over the page it opened');
			} finally {
				await page.close();
			}
			assert.deepEqual(problems, []);
		});

		/*
		 * A back with the sheet open went back a page under it, which nobody
		 * could see, and the sheet closed over another page than it had opened
		 * on. The open sheet is an entry in the history now.
		 */
		test('back with the sheet open closes the sheet and stays on the page', async () => {
			const { page, problems } = await phonePage('/');
			try {
				await playAlbum(page, 17);
				await page.goto(app.url + '/albums', { waitUntil: 'networkidle' });
				await tap(page, page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Favourites' }));
				await page.waitForURL(/\/favourites$/);
				// The address changes before the page is put in, and a sheet opened in
				// between is closed when the page arrives (a navigation closes the
				// sheet). Measured: a tap on the mini player up to 80ms after the tap
				// on the tab opened it and shut it, and from 150ms it stayed. In CI
				// the tap below landed inside that once, and the sheet never opened.
				await page.locator('main').getByRole('heading', { name: 'Favourites' }).waitFor();
				await page.waitForSelector('#dock-open');
				await tap(page, page.locator('#dock-open'));
				await page.waitForFunction(() => document.querySelector('.app').classList.contains('player-open'));
				await page.waitForTimeout(600);

				await page.goBack();
				await page.waitForFunction(() => !document.querySelector('.app').classList.contains('player-open'), null, { timeout: 5000 });
				assert.equal(new URL(page.url()).pathname, '/favourites', 'back left the page under the sheet');

				// Closed from the sheet itself, the entry goes with it: the next back
				// is the page before.
				await page.waitForTimeout(600);
				await tap(page, page.locator('#dock-open'));
				await page.waitForFunction(() => document.querySelector('.app').classList.contains('player-open'));
				await page.waitForTimeout(600);
				await tap(page, page.locator('#player-hide'));
				await page.waitForFunction(() => !document.querySelector('.app').classList.contains('player-open'));
				await page.waitForTimeout(600);
				assert.equal(new URL(page.url()).pathname, '/favourites');
				await page.goBack();
				await page.waitForURL(/\/albums$/);
				assert.equal(await sheetOpen(page), false);

				// A link followed from the sheet takes the sheet's place in the
				// history: back returns to the page the sheet was over.
				await tap(page, page.locator('#dock-open'));
				await page.waitForFunction(() => document.querySelector('.app').classList.contains('player-open'));
				await page.waitForTimeout(600);
				await tap(page, page.locator('aside.panel .artist a'));
				await page.waitForURL(/\/artists\/ar17$/);
				await page.waitForTimeout(600);
				await page.goBack();
				await page.waitForURL(/\/albums$/);
				await page.waitForTimeout(600);
				assert.equal(await sheetOpen(page), false, 'back from a page opened in the sheet brought the sheet up');
			} finally {
				await page.close();
			}
			assert.deepEqual(problems, []);
		});

		/*
		 * A sheet opened while the next page is still loading arrived on a page
		 * that shut it. The history entry it had pushed belonged to the page
		 * being left, so the arriving page had none, and afterNavigate closed
		 * the sheet. It stays now, and the arriving page carries its entry.
		 */
		test('a sheet opened during a page load stays open when the page arrives', async () => {
			const { page, problems } = await phonePage('/');
			try {
				await playAlbum(page, 18);
				await page.goto(app.url + '/albums', { waitUntil: 'networkidle' });
				subsonic.state.delays.set('getAlbumList2', 1500);
				// The Library page waits on this call. The sheet is opened in the
				// load, as a thumb does after tapping a tab.
				await tap(page, page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Library' }));
				await page.waitForTimeout(100);
				await tap(page, page.locator('#dock-open'));
				await page.waitForFunction(() => document.querySelector('.app').classList.contains('player-open'));
				await page.waitForURL(/\/library$/);
				await page.waitForTimeout(600);
				assert.equal(await sheetOpen(page), true, 'the sheet closed when the page arrived');

				// The page it arrived on carries the sheet's entry: a back closes
				// the sheet and leaves the page under it.
				await page.goBack();
				await page.waitForFunction(() => !document.querySelector('.app').classList.contains('player-open'), null, {
					timeout: 5000
				});
				assert.equal(new URL(page.url()).pathname, '/library', 'back left the page under the sheet');
			} finally {
				subsonic.state.delays.clear();
				await page.close();
			}
			assert.deepEqual(problems, []);
		});

		test('the tabs fold away scrolling down, and come back scrolling up', async () => {
			const { page, problems } = await phonePage('/');
			try {
				await playAlbum(page, 16);
				await page.goto(app.url + '/artists', { waitUntil: 'networkidle' });
				await page.waitForSelector('#dock-open');
				const tabsHeight = () =>
					page.evaluate(() => document.querySelector('.phone-dock nav').getBoundingClientRect().height);
				const full = await tabsHeight();
				assert.ok(full > 40, `the tabs are ${full}px tall`);

				await page.evaluate(() => scrollTo(0, 1200));
				await page.waitForTimeout(600);
				assert.ok((await tabsHeight()) <= 1, 'the tabs did not fold scrolling down');

				await page.evaluate(() => scrollTo(0, 1100));
				await page.waitForTimeout(600);
				assert.equal(await tabsHeight(), full, 'the tabs did not come back scrolling up');
			} finally {
				await page.close();
			}
			assert.deepEqual(problems, []);
		});
	});

	/*
	 * The canvas is what Safari 26 shows under the status bar and behind the
	 * toolbar, so it has to read as the room. Compared with the room's own top
	 * and bottom edges, measured with everything but the room hidden.
	 */
	test('the canvas is the colour of the room at its edges', async () => {
		const { page, problems } = await phonePage('/');
		try {
			await page.addStyleTag({ content: '.app > :not(.hh-ambience) { visibility: hidden !important }' });
			await page.waitForTimeout(1200);
			const shot = (await page.screenshot()).toString('base64');
			// Painted and read back, since a `color-mix()` computes to
			// `color(srgb ...)` with channels from 0 to 1.
			const canvas = await page.evaluate(() => {
				const context = document.createElement('canvas').getContext('2d');
				context.fillStyle = getComputedStyle(document.documentElement).backgroundColor;
				context.fillRect(0, 0, 1, 1);
				return [...context.getImageData(0, 0, 1, 1).data.slice(0, 3)];
			});
			// Decoded on a blank page: the app's own policy refuses a `data:` image.
			const blank = await phone.newPage();
			const edges = await blank.evaluate(async (png) => {
				const image = new Image();
				image.src = `data:image/png;base64,${png}`;
				await image.decode();
				const draw = document.createElement('canvas');
				draw.width = image.width;
				draw.height = image.height;
				const context = draw.getContext('2d');
				context.drawImage(image, 0, 0);
				const mean = (y) => {
					const data = context.getImageData(0, y, image.width, 8).data;
					const sum = [0, 0, 0];
					for (let i = 0; i < data.length; i += 4) for (let c = 0; c < 3; c++) sum[c] += data[i + c];
					return sum.map((value) => value / (data.length / 4));
				};
				const top = mean(0);
				const bottom = mean(image.height - 8);
				return top.map((value, c) => (value + bottom[c]) / 2);
			}, shot);
			await blank.close();
			for (let c = 0; c < 3; c++) {
				assert.ok(Math.abs(canvas[c] - edges[c]) <= 6, `the canvas is ${canvas}, the room's edges ${edges.map(Math.round)}`);
			}
		} finally {
			await page.close();
		}
		assert.deepEqual(problems, []);
	});
});

describe('the sleeve', () => {
	/*
	 * In a view transition the root is painted as an image of itself, and
	 * Firefox draws the glass in that image without the room behind it: the
	 * rail and the player went from 40 to 31 for the transition and back with a
	 * bright frame (recorded, not in this suite). Only the sleeve may be
	 * captured.
	 */
	test('a card click morphs the sleeve and captures nothing else', async () => {
		const { page, problems } = await watchedPage();
		try {
			await page.goto(app.url + '/albums', { waitUntil: 'networkidle' });
			await page.evaluate(() => {
				window.__captured = null;
				const look = () => {
					const running = document
						.getAnimations()
						.map((a) => a.effect?.pseudoElement ?? '')
						.filter((name) => name.startsWith('::view-transition'));
					if (running.length === 0) return requestAnimationFrame(look);
					window.__captured = [...new Set(running)];
				};
				requestAnimationFrame(look);
			});
			await page.locator('a.card').nth(1).click({ position: { x: 20, y: 20 } });
			await page.waitForFunction(() => window.__captured !== null, null, { timeout: 5000 });
			const captured = await page.evaluate(() => window.__captured);

			assert.ok(captured.some((name) => name.includes('sleeve-art')), `no sleeve in ${captured}`);
			assert.deepEqual(
				captured.filter((name) => !name.includes('sleeve-art')),
				[],
				'something besides the sleeve was captured'
			);
		} finally {
			await page.close();
		}
		assert.deepEqual(problems, []);
	});
});

describe('opening an album', () => {
	/*
	 * The hero asks for a larger copy of the cover than the card holds, and a
	 * music server can take seconds to resize one. The card's copy is already
	 * in the browser, so it stands in until the larger one arrives.
	 */
	test('the hero shows the card\'s copy while its own is still coming', async () => {
		// A context of its own and an empty cover cache. A card hovered in an
		// earlier test warms the hero's copy, which a slow runner once had in hand
		// within 900ms of opening the album, so the test checked nothing.
		const fresh = await browser.newContext({ viewport: { width: 1440, height: 900 } });
		await fresh.request.post(`${app.url}/login`, {
			form: { username: 'testuser', password: 'testpass', backend: 'subsonic', next: '/' },
			headers: { origin: app.url, accept: 'text/html' },
			maxRedirects: 0
		});
		const cleared = await fresh.request.post(`${app.url}/settings?/clearCovers`, {
			headers: { origin: app.url, 'x-sveltekit-action': 'true', accept: 'application/json' },
			form: {}
		});
		assert.equal(cleared.status(), 200);
		const page = await fresh.newPage();
		const problems = [];
		page.on('console', (message) => {
			if (message.type() === 'error') problems.push(`${page.url()}: ${message.text()}`);
		});
		page.on('pageerror', (err) => problems.push(`${page.url()}: ${err.message}`));
		try {
			await page.goto(app.url + '/albums', { waitUntil: 'networkidle' });
			const card = page.locator('a.card[href="/albums/al9"]');
			await card.waitFor();
			// Nothing else in this file opens album 9, so its hero copy is not cached.
			subsonic.state.delays.set('getCoverArt', 2500);
			await card.click({ position: { x: 20, y: 20 } });
			await page.waitForURL(/\/albums\/al9$/);
			await page.waitForTimeout(900);
			const hero = await page.evaluate(() =>
				[...document.querySelectorAll('.hero .art img')].map((img) => ({
					src: img.getAttribute('src'),
					visible: img.complete && img.naturalWidth > 0 && !img.classList.contains('pending')
				}))
			);
			assert.ok(
				hero.some((img) => img.visible),
				`nothing shown in the hero while its copy loads: ${JSON.stringify(hero)}`
			);
			assert.ok(
				hero.some((img) => img.src?.includes('size=640') && !img.visible),
				`the hero's own copy was not still loading, so this checked nothing: ${JSON.stringify(hero)}`
			);
		} finally {
			subsonic.state.delays.clear();
			await fresh.close();
		}
		assert.deepEqual(problems, []);
	});
});

describe('the scroll position between pages', () => {
	/*
	 * Above 60rem the content column scrolls, and SvelteKit resets and restores
	 * only the document. The column kept one position for every page, so an
	 * album opened from down the library opened as far down its own page.
	 */
	test('an album opens at its top, and Back returns to the place in the library', async () => {
		// Long enough that the album page could hold the library's position.
		subsonic.state.albumSongs = 24;
		const { page, problems } = await watchedPage();
		try {
			await page.goto(app.url + '/', { waitUntil: 'networkidle' });
			const column = () => page.evaluate(() => Math.round(document.querySelector('main.content').scrollTop));
			await page.evaluate(() => document.querySelector('main.content').scrollTo({ top: 400, behavior: 'instant' }));
			assert.equal(await column(), 400, 'the home page is too short to test this');

			// The mouse rather than `click()`, which would scroll the card into view first.
			const box = await page.locator('a.card[href^="/albums/"]').nth(1).boundingBox();
			assert.ok(box.y > 0 && box.y + 20 < 900, `the card is not on screen: ${JSON.stringify(box)}`);
			await page.mouse.click(box.x + 20, box.y + 20);
			await page.waitForURL(/\/albums\/al/);
			await page.waitForTimeout(800);
			const room = await page.evaluate(() => {
				const c = document.querySelector('main.content');
				return c.scrollHeight - c.clientHeight;
			});
			assert.ok(room >= 400, `the album page scrolls ${room}px, too little to test this`);
			assert.equal(await column(), 0, 'the album did not open at its top');

			await page.goBack();
			await page.waitForURL(app.url + '/');
			await page.waitForTimeout(800);
			assert.equal(await column(), 400, 'Back did not return to the place in the library');
		} finally {
			subsonic.state.albumSongs = 2;
			await page.close();
		}
		assert.deepEqual(problems, []);
	});
});
