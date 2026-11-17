/**
 * The aurora, the player panel on a wide screen, playback on another browser, casting, your listening and the living-room screen.
 *
 *   npm run build
 *   node --test tests/browser/panel-and-remote.test.mjs
 *
 * Runs the built app against the mock servers of `tests/e2e`; see `suite.mjs`.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, before, describe, test } from 'node:test';
import { startApp } from '../e2e/harness.mjs';
import { silentWav } from '../e2e/mocks.mjs';
import { subsonic, jellyfin, app, browser, context, shown, watchedPage, playable, setUpSuite } from './suite.mjs';

setUpSuite();

describe('the aurora', () => {
	test('drifts by default, and holds still or goes from Settings', async () => {
		const origin = { origin: app.url, 'content-type': 'application/json' };
		const { page, problems } = await watchedPage();
		// SoftAurora counts the frames it draws: still, it draws one and stops.
		const frames = () => page.evaluate(() => Number(document.querySelector('.aurora [data-frames]')?.getAttribute('data-frames') ?? 0));
		const state = async () => {
			if ((await page.locator('.aurora').count()) === 0) return { shown: false, running: false };
			await page.waitForFunction(() => document.querySelector('.aurora [data-frames]'));
			const before = await frames();
			await page.waitForTimeout(1500);
			return { shown: true, running: (await frames()) > before };
		};
		try {
			// An account that has never chosen: a context of its own, signed in as one.
			const fresh = await browser.newContext({ viewport: { width: 1440, height: 900 } });
			try {
				const signIn = await fresh.request.post(`${app.url}/login`, {
					form: { username: 'seconduser', password: 'secondpass', backend: 'subsonic', next: '/' },
					headers: { origin: app.url, accept: 'text/html' },
					maxRedirects: 0
				});
				assert.equal(signIn.status(), 303);
				const first = await fresh.newPage();
				await first.goto(app.url + '/albums', { waitUntil: 'networkidle' });
				await first.waitForFunction(() => Number(document.querySelector('.aurora [data-frames]')?.getAttribute('data-frames') ?? 0) > 2, null, { timeout: 5000 });
			} finally {
				await fresh.close();
			}

			await context.request.patch(`${app.url}/api/settings`, { headers: origin, data: { aurora: 'moving' } });
			await page.goto(app.url + '/albums', { waitUntil: 'networkidle' });
			assert.deepEqual(await state(), { shown: true, running: true });

			await context.request.patch(`${app.url}/api/settings`, { headers: origin, data: { aurora: 'still' } });
			await page.reload({ waitUntil: 'networkidle' });
			assert.deepEqual(await state(), { shown: true, running: false });

			await context.request.patch(`${app.url}/api/settings`, { headers: origin, data: { aurora: 'off' } });
			await page.reload({ waitUntil: 'networkidle' });
			assert.deepEqual(await state(), { shown: false, running: false });
		} finally {
			await context.request.patch(`${app.url}/api/settings`, { headers: origin, data: { aurora: 'off' } });
			await page.close();
		}
		assert.deepEqual(problems, []);
	});
});

describe('the player panel on a wide screen', () => {
	/*
	 * Showing and hiding the panel changes the width of the page beside it.
	 * Animating that width laid the page out on every frame, a few frames a
	 * second on an iPad Pro. Changing it in one step, with only the panel
	 * moving (0.6.1), made a grid of albums jump to a new column count, which
	 * was reported as the interface snapping. Now the layout changes once and
	 * what is on the page is carried from where it was (`client/glide.ts`).
	 *
	 * The frame the page is laid out in is a long one, so nothing moves in
	 * it: a move started there is part-way through when it is first seen, and
	 * the panel, on a curve that covers half its distance in the first 100ms,
	 * was seen to snap. The moving starts in the frame after.
	 *
	 * Read as the page is laid out, then with every animation held at its
	 * first frame, and again with them finished.
	 */
	/**
	 * Presses a button of the panel. Returns what is drawn where once the page
	 * has its new layout and before anything has moved (`laidOut`), and then
	 * holds what the press started at its start and counts it.
	 */
	const pressAndHold = async (page, label) => {
		const early = await page.evaluate((label) => {
			[...document.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === label).click();
			// After the click's own work, and before the next frame: what is
			// already moving then started in the frame the page is laid out in.
			return new Promise((done) =>
				setTimeout(() =>
					done(
						document.querySelector('.dock').getAnimations().length +
							document.getAnimations().filter((a) => a.id === 'glide' && a.playState === 'running').length
					)
				)
			);
		}, label);
		const laidOut = { ...(await places(page)), early };
		const moving = await page.evaluate(
			() =>
				new Promise((done) => {
					let frames = 0;
					const look = () => {
						const dock = document.querySelector('.dock').getAnimations();
						// Nothing starts for a listener who asked for less motion.
						if (dock.length === 0 && ++frames < 10) return requestAnimationFrame(look);
						const held = document.getAnimations().filter((a) => Number.isFinite(a.effect.getComputedTiming().endTime));
						for (const animation of held) {
							animation.pause();
							animation.currentTime = 0;
						}
						window.__held = held;
						done({
							glide: held.filter((a) => a.id === 'glide').length,
							dock: dock.map((a) => a.transitionProperty),
							app: document.querySelector('.app').getAnimations().map((a) => a.transitionProperty)
						});
					};
					requestAnimationFrame(look);
				})
		);
		return { ...moving, laidOut };
	};
	const letGo = async (page) => {
		await page.evaluate(() => window.__held.forEach((animation) => animation.finish()));
		// Past the moment the column takes its width back on the way in.
		await page.waitForFunction(() => !document.querySelector('.app').classList.contains('panel-arriving'), null, { timeout: 3000 });
	};
	/** Where the cards and the sort buttons are drawn, to the pixel. */
	const places = (page) =>
		page.evaluate(() => {
			const box = (element) => {
				const { left, top, width, height } = element.getBoundingClientRect();
				return [left, top, width, height].map(Math.round).join(' ');
			};
			return {
				cards: [...document.querySelectorAll('main.content [data-glide] > *')].slice(0, 12).map(box),
				sort: box(document.querySelector('main.content nav.sorts')),
				content: Math.round(document.querySelector('main.content').getBoundingClientRect().right),
				panel: Math.round(document.querySelector('aside.panel').getBoundingClientRect().left),
				grip: Math.round(document.querySelector('#player-grip').getBoundingClientRect().left)
			};
		});

	test('lays the page out once, and carries the cards and the buttons to their new places', async () => {
		const { page, problems } = await watchedPage();
		try {
			await page.goto(app.url + '/albums', { waitUntil: 'networkidle' });
			const open = await places(page);

			// Hiding it. The first frame is the page as it was, and no part of the
			// layout is what animates: the panel moves, and the cards with it.
			const hiding = await pressAndHold(page, 'Hide the player');
			// Laid out, and drawn as it was: the page has its new width, and the
			// cards, the buttons and the panel are where they were.
			assert.ok(hiding.laidOut.content > open.content, 'the page was not laid out at once');
			assert.equal(hiding.laidOut.early, 0, 'the panel or a card started moving in the frame the page was laid out in');
			assert.deepEqual(
				[hiding.laidOut.cards, hiding.laidOut.sort, hiding.laidOut.panel],
				[open.cards, open.sort, open.panel],
				'something had moved in the frame the page was laid out in'
			);
			assert.deepEqual(hiding.dock, ['translate'], 'the panel is not what moves');
			assert.deepEqual(hiding.app, [], 'the columns animate, which lays the page out on every frame');
			assert.ok(hiding.glide >= 8, `only ${hiding.glide} things are carried`);
			const hidingFrom = await places(page);
			assert.deepEqual(hidingFrom.cards, open.cards, 'the cards do not start from where they were');
			assert.equal(hidingFrom.sort, open.sort, 'the sort buttons do not start from where they were');
			assert.ok(hidingFrom.content > open.content, 'the page has not taken its new width in the first frame');
			await letGo(page);
			const closed = await places(page);
			assert.notDeepEqual(closed.cards, open.cards, 'hiding the panel left the grid as it was');
			// The sliver is 2rem wide, at the right-hand edge, 12px in from it.
			assert.equal(closed.grip, 1440 - 12 - 32);
			assert.equal(closed.panel, closed.grip, 'the hidden panel does not start at the sliver');
			assert.equal(closed.content - open.content, closed.panel - open.panel, 'the page did not take the width the panel gave up');

			// Showing it. The page is laid out for its new width at once, and its
			// box stays as wide as it was until the panel has arrived, so a card on
			// its way out from under the panel is not cut off.
			const showing = await pressAndHold(page, 'Show the player');
			assert.equal(showing.laidOut.early, 0, 'the panel or a card started moving in the frame the page was laid out in');
			assert.deepEqual(
				[showing.laidOut.cards, showing.laidOut.sort, showing.laidOut.panel],
				[closed.cards, closed.sort, closed.panel],
				'something had moved in the frame the page was laid out in'
			);
			assert.deepEqual(showing.dock, ['translate']);
			assert.deepEqual(showing.app, []);
			assert.ok(showing.glide >= 8, `only ${showing.glide} things are carried`);
			const showingFrom = await places(page);
			assert.deepEqual(showingFrom.cards, closed.cards, 'the cards do not start from where they were');
			assert.equal(showingFrom.content, closed.content, 'the page\'s box was narrowed before the panel arrived');
			assert.ok(await page.evaluate(() => document.querySelector('.app').classList.contains('panel-arriving')));
			await page.evaluate(() => window.__held.forEach((animation) => animation.finish()));
			// Arrived, with the column still to take its width: nothing moves when it does.
			const arrivedAt = await places(page);
			await letGo(page);
			const reopened = await places(page);
			assert.deepEqual(reopened.cards, arrivedAt.cards, 'the cards moved when the column took its width');
			assert.deepEqual(reopened, open, 'shown again, the page is not as it was');
		} finally {
			await page.close();
		}
		assert.deepEqual(problems, []);
	});

	test('carries nothing for a listener who asked for less motion', async () => {
		const reduced = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce', storageState: await context.storageState() });
		const page = await reduced.newPage();
		try {
			await page.goto(app.url + '/albums', { waitUntil: 'networkidle' });
			const before = await places(page);
			const hiding = await pressAndHold(page, 'Hide the player');
			assert.equal(hiding.glide, 0);
			assert.deepEqual(hiding.dock, []);
			assert.notDeepEqual((await places(page)).cards, before.cards, 'the page did not take its new layout at once');
		} finally {
			await reduced.close();
		}
	});
});

describe('the heart in the player', () => {
	/*
	 * The player keeps one heart and hands it each new song. When it kept the
	 * state from the last press, a song starred in the player showed as starred
	 * on every song after it.
	 */
	test('follows the song on a skip, and agrees with the track row', async (t) => {
		playable(t);
		const { page, problems } = await watchedPage();
		const heart = page.locator('aside.panel .rounds .fav');
		const pressed = (locator) => locator.getAttribute('aria-pressed');
		try {
			await page.goto(app.url + '/albums/al2', { waitUntil: 'networkidle' });
			await page.getByRole('button', { name: 'Play Song 2a', exact: true }).click();
			await page.waitForFunction(() => document.querySelector('aside.panel h2.title')?.textContent === 'Song 2a');
			assert.equal(await pressed(heart), 'false');

			const starred = page.waitForResponse((r) => r.url().endsWith('/api/star'));
			await heart.click();
			await starred;
			assert.equal(await pressed(heart), 'true');

			await page.locator('aside.panel button.step').nth(1).click();
			await page.waitForFunction(() => document.querySelector('aside.panel h2.title')?.textContent === 'Song 2b');
			assert.equal(await pressed(heart), 'false', 'the next song showed the last song\'s heart');

			await page.locator('aside.panel button.step').nth(0).click();
			await page.waitForFunction(() => document.querySelector('aside.panel h2.title')?.textContent === 'Song 2a');
			assert.equal(await pressed(heart), 'true', 'going back lost the star');
			assert.equal(await pressed(page.locator('.track').nth(0).locator('.fav')), 'true', 'the row disagreed');

			// Put the mock back as it was for the tests after this one.
			const unstarred = page.waitForResponse((r) => r.url().endsWith('/api/star'));
			await heart.click();
			await unstarred;
		} finally {
			await page.close();
		}
		assert.deepEqual(problems, []);
	});
});

describe('playback on another browser', () => {
	/*
	 * An app of its own with the remote control on, and two browsers signed in
	 * to it. The pages hold the event stream open, so nothing here waits for
	 * `networkidle`.
	 */
	let remoteApp;
	const browsers = [];
	/** For the test that plays the part of the Navidrome plugin. */
	const PLUGIN_TOKEN = 'plugin-token-0123456789abcdef0123456789';

	before(async () => {
		remoteApp = await startApp({
			subsonicUrl: subsonic.url,
			jellyfinUrl: jellyfin.url,
			env: { HEDDOHON_NAVIDROME_PLUGIN_TOKEN: PLUGIN_TOKEN }
		});
	});

	after(async () => {
		for (const context of browsers) await context.close();
		await remoteApp?.stop();
	});

	async function signedInPage(username = 'testuser', password = 'testpass') {
		const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
		browsers.push(context);
		const signIn = await context.request.post(`${remoteApp.url}/login`, {
			form: { username, password, backend: 'subsonic', next: '/' },
			headers: { origin: remoteApp.url, accept: 'text/html' },
			maxRedirects: 0
		});
		assert.equal(signIn.status(), 303);
		// As for the first app's account: these tests run three pages at once and
		// time what they do, one of them against a limit of 2 seconds.
		await context.request.patch(`${remoteApp.url}/api/settings`, { data: { aurora: 'off' }, headers: { origin: remoteApp.url } });
		const page = await context.newPage();
		const problems = [];
		page.on('console', (message) => message.type() === 'error' && problems.push(message.text()));
		page.on('pageerror', (err) => problems.push(err.message));
		return { page, problems };
	}

	const titleIs = (page, text) =>
		page.waitForFunction((want) => document.querySelector('aside.panel h2.title')?.textContent === want, text, {
			timeout: 5000
		});

	test('a second browser sees the first, pauses it, and takes its queue with "Play here"', async () => {
		const { page: desktop, problems: desktopProblems } = await signedInPage();
		const { page: phone, problems: phoneProblems } = await signedInPage();
		subsonic.state.audio = { type: 'audio/wav', body: silentWav(30) };
		try {
			await desktop.goto(remoteApp.url + '/albums/al7', { waitUntil: 'load' });
			await desktop.getByRole('button', { name: 'Play Song 7b', exact: true }).click();
			await titleIs(desktop, 'Song 7b');
			await desktop.waitForFunction(() => [...document.querySelectorAll('audio')].some((a) => !a.paused), null, { timeout: 5000 });

			await phone.goto(remoteApp.url + '/', { waitUntil: 'load' });
			const devices = phone.getByRole('button', { name: /^Devices/ });
			await devices.waitFor({ timeout: 5000 });
			await devices.click();
			const dialog = phone.locator('dialog.devices');
			// The desktop's report follows its play within the 250ms settle.
			await dialog.getByText('Song 7b').waitFor({ timeout: 5000 });
			await dialog.getByText('Playing', { exact: true }).waitFor({ timeout: 5000 });

			await dialog.getByRole('button', { name: /^Pause on/ }).click();
			await desktop.waitForFunction(() => [...document.querySelectorAll('audio')].every((a) => a.paused), null, { timeout: 5000 });
			await dialog.getByText('Paused', { exact: true }).waitFor({ timeout: 5000 });

			await dialog.getByRole('button', { name: 'Play here' }).click();
			await titleIs(phone, 'Song 7b');
			await phone.waitForFunction(() => [...document.querySelectorAll('audio')].some((a) => !a.paused), null, { timeout: 5000 });
		} finally {
			subsonic.state.audio = null;
		}
		assert.deepEqual([...desktopProblems, ...phoneProblems], []);
	});

	test('another app shows under Devices with where it is, or would be, and "Continue here" plays its track from there', async () => {
		const { page, problems } = await signedInPage();
		/** What Navidrome reports the app doing, as its plugin posts it. */
		const report = (state, positionMs) =>
			fetch(`${remoteApp.url}/api/plugin/navidrome`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', origin: remoteApp.url, authorization: `Bearer ${PLUGIN_TOKEN}` },
				body: JSON.stringify({ v: 1, type: 'playback', username: 'testuser', songId: 's7a', state, positionMs, player: 'phone-1', playerName: 'Symfonium' })
			});
		subsonic.state.audio = { type: 'audio/wav', body: silentWav(30) };
		try {
			await page.goto(remoteApp.url + '/', { waitUntil: 'load' });

			// An app that says a track started and nothing more. The browsers of
			// the tests before this one are still open, and listed below it.
			assert.equal((await report('playing', 0)).status, 200);
			const devices = page.getByRole('button', { name: /^Devices/ });
			await devices.waitFor({ timeout: 5000 });
			await devices.click();
			const app = page.locator('dialog.devices li.peer').filter({ hasText: 'another app' });
			await app.getByText('Symfonium', { exact: true }).waitFor({ timeout: 5000 });
			assert.equal(await page.locator('dialog.devices li.peer').first().getByText('Symfonium', { exact: true }).count(), 1, 'the app is not first in the list');
			await app.getByText('Song 7a').waitFor();
			await app.getByText(/^at about 0:0\d$/).waitFor();

			// One that says where it is: the time is its own.
			await report('playing', 12_000);
			await app.getByText(/^at 0:1\d$/).waitFor({ timeout: 5000 });

			await app.getByRole('button', { name: 'Continue here' }).click();
			await titleIs(page, 'Song 7a');
			await page.waitForFunction(
				() => [...document.querySelectorAll('audio')].some((a) => !a.paused && a.currentTime >= 12 && a.currentTime < 25),
				null,
				{ timeout: 5000 }
			);

			// The app stopping takes it out of the list, and the button with it.
			await report('stopped', 14_000);
			await app.waitFor({ state: 'detached', timeout: 5000 });
		} finally {
			subsonic.state.audio = null;
			await report('stopped', 0);
		}
		assert.deepEqual(problems, []);
	});

	test('"Play this queue there" moves the queue to the other browser and pauses this one', async () => {
		const { page: desktop } = await signedInPage();
		const { page: phone } = await signedInPage();
		subsonic.state.audio = { type: 'audio/wav', body: silentWav(30) };
		try {
			await desktop.goto(remoteApp.url + '/', { waitUntil: 'load' });
			await phone.goto(remoteApp.url + '/albums/al8', { waitUntil: 'load' });
			await phone.getByRole('button', { name: 'Play Song 8a', exact: true }).click();
			await titleIs(phone, 'Song 8a');

			// Every other browser of the account is listed; this one is the newest.
			await phone.getByRole('button', { name: /^Devices/ }).click();
			const peer = phone.locator('dialog.devices li.peer').first();
			await peer.getByRole('button', { name: 'Play this queue there' }).click();
			await titleIs(desktop, 'Song 8a');
			await phone.waitForFunction(() => [...document.querySelectorAll('audio')].every((a) => a.paused), null, { timeout: 5000 });
		} finally {
			subsonic.state.audio = null;
		}
	});
	/*
	 * Two accounts on one music server. The second sets itself up under
	 * Settings as a person would, picture included: the browser cuts and
	 * re-encodes the image, which the page's policy has to allow.
	 */
	test('an account that chooses to be shown appears to another with its name, its picture and its track, which the other plays from the popup', async () => {
		const { page: viewer, problems } = await signedInPage();
		const { page: shown, problems: shownProblems } = await signedInPage('seconduser', 'secondpass');
		const write = (method, path, data) =>
			shown.context().request.fetch(remoteApp.url + path, { method, data, headers: { origin: remoteApp.url } });
		subsonic.state.audio = { type: 'audio/wav', body: silentWav(60) };
		try {
			await viewer.goto(remoteApp.url + '/', { waitUntil: 'load' });
			const pill = viewer.locator('button.heads');

			await shown.goto(remoteApp.url + '/albums/al7', { waitUntil: 'load' });
			await shown.getByRole('button', { name: 'Play Song 7b', exact: true }).click();
			await titleIs(shown, 'Song 7b');
			await shown.waitForFunction(() => [...document.querySelectorAll('audio')].some((a) => !a.paused), null, { timeout: 5000 });
			// Playing, and not shown: nothing appears to the other account.
			await viewer.waitForTimeout(600);
			assert.equal(await pill.count(), 0, 'an account that had not chosen to be shown was shown');

			// By the rail and the tab, so the track keeps playing across the page change.
			await shown.locator('nav.rail a[href="/settings"]').click();
			await shown.getByRole('link', { name: 'You', exact: true }).click();
			const section = shown.locator('section#listening');
			await section.getByLabel('Display name').fill('Mira');
			await section.getByRole('button', { name: 'Save' }).click();
			// A 300x200 PNG, wider than tall, drawn in the page.
			const png = await shown.evaluate(async () => {
				const canvas = document.createElement('canvas');
				canvas.width = 300;
				canvas.height = 200;
				const context = canvas.getContext('2d');
				context.fillStyle = '#c0392b';
				context.fillRect(0, 0, 300, 200);
				const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
				return Array.from(new Uint8Array(await blob.arrayBuffer()));
			});
			await section.locator('input[type=file]').setInputFiles({ name: 'me.png', mimeType: 'image/png', buffer: Buffer.from(png) });
			await section.locator('.avatar img').waitFor({ timeout: 5000 });
			await section.getByRole('switch', { name: /Show others what I play/ }).check();

			await pill.waitFor({ timeout: 5000 });
			assert.equal(await pill.getAttribute('aria-label'), 'Listening now: Mira');
			// Over the content column: clear of the rail and of the player.
			const box = async (locator) => locator.evaluate((node) => node.getBoundingClientRect().toJSON());
			const [at, rail, panel] = [await box(pill), await box(viewer.locator('nav.rail')), await box(viewer.locator('.app > .player'))];
			assert.ok(at.left >= rail.right && at.right <= panel.left, `the pill is at ${at.left} to ${at.right}, the rail ends at ${rail.right} and the player starts at ${panel.left}`);

			await pill.click();
			const dialog = viewer.locator('dialog.listening');
			const row = dialog.locator('li.listener', { hasText: 'Mira' });
			await row.getByText('Song 7b').waitFor({ timeout: 5000 });
			// The picture arrived as the square the browser cut: 256 by 256.
			await viewer.waitForFunction(() => document.querySelector('dialog.listening li.listener .avatar img')?.naturalWidth === 256, null, { timeout: 5000 });
			assert.equal(await row.locator('.avatar img').evaluate((image) => image.naturalHeight), 256);
			assert.equal(await row.locator('a.art').getAttribute('href'), '/albums/al7');
			// The popup opens out of the pill: they share the corner.
			const opened = await box(dialog);
			assert.ok(Math.abs(opened.right - at.right) < 1 && Math.abs(opened.bottom - at.bottom) < 1, `the popup's corner is ${opened.right},${opened.bottom}, the pill's ${at.right},${at.bottom}`);

			await row.getByRole('button', { name: 'Play it here' }).click();
			await titleIs(viewer, 'Song 7b');
			await viewer.waitForFunction(() => !document.querySelector('dialog.listening')?.open, null, { timeout: 5000 });

			// On a phone the pill sits above the dock.
			await viewer.setViewportSize({ width: 393, height: 641 });
			await viewer.waitForFunction(
				() => {
					const pill = document.querySelector('button.heads')?.getBoundingClientRect();
					const dock = document.querySelector('.phone-dock')?.getBoundingClientRect();
					return pill && dock && dock.height > 0 && pill.bottom <= dock.top && pill.bottom > dock.top - 24;
				},
				null,
				{ timeout: 5000 }
			);
			await viewer.setViewportSize({ width: 1440, height: 900 });

			// A name made of markup is shown as the text it is, in the pill and the popup.
			const markup = '<img src=x onerror=alert(1)>';
			const alerts = [];
			viewer.on('dialog', (dialog) => {
				alerts.push(dialog.message());
				dialog.dismiss().catch(() => {});
			});
			assert.equal((await write('PATCH', '/api/profile', { name: markup })).status(), 200);
			await viewer.waitForFunction((label) => document.querySelector('button.heads')?.getAttribute('aria-label') === label, `Listening now: ${markup}`, { timeout: 5000 });
			await pill.click();
			await dialog.locator('li.listener', { hasText: markup }).waitFor({ timeout: 5000 });
			assert.equal(await viewer.locator('img[src="x"]').count(), 0, 'the name was drawn as an element');
			await viewer.keyboard.press('Escape');
			assert.deepEqual(alerts, []);

			// Paused, the account is gone from the other's screen.
			await shown.locator('aside.panel').getByRole('button', { name: 'Pause', exact: true }).click();
			await pill.waitFor({ state: 'detached', timeout: 5000 });
		} finally {
			subsonic.state.audio = null;
			await write('PATCH', '/api/profile', { shown: false, name: null });
			await write('DELETE', '/api/profile/avatar');
		}
		assert.deepEqual([...problems, ...shownProblems], []);
	});


	test('a visitor with no account joins, follows a skip and a pause, and a reaction reaches the host', async () => {
		const { page: hostPage, problems } = await signedInPage();
		const guestContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
		browsers.push(guestContext);
		const guest = await guestContext.newPage();
		const guestAudio = () =>
			guest.evaluate(() => {
				const a = document.querySelector('audio.together-audio');
				return { src: a?.getAttribute('src') ?? '', paused: a?.paused ?? true, time: a?.currentTime ?? 0, at: Date.now() };
			});
		subsonic.state.audio = { type: 'audio/wav', body: silentWav(60) };
		try {
			await hostPage.goto(remoteApp.url + '/albums/al17', { waitUntil: 'load' });
			await hostPage.getByRole('button', { name: 'Play Song 17a', exact: true }).click();
			await hostPage.waitForFunction(() => [...document.querySelectorAll('audio')].some((a) => !a.paused), null, { timeout: 5000 });

			await hostPage.getByRole('button', { name: 'Share a link to this song' }).click();
			await hostPage.getByRole('button', { name: 'Listen together' }).click();
			const field = hostPage.getByRole('textbox', { name: 'Listen-together link' });
			await field.waitFor({ timeout: 5000 });
			const link = await field.inputValue();
			assert.match(link, /\/together\/[\w-]+$/);
			await hostPage.locator('dialog.together p', { hasText: 'Only share music you have the right to share.' }).waitFor();
			await hostPage.locator('dialog.together').getByRole('button', { name: 'Close' }).click();

			await guest.goto(link, { waitUntil: 'load' });
			await guest.locator('h1', { hasText: 'Song 17a' }).waitFor({ timeout: 5000 });
			await guest.getByRole('button', { name: 'Join' }).click();
			await guest.waitForFunction(() => !document.querySelector('audio.together-audio')?.paused, null, { timeout: 5000 });
			const joined = await guestAudio();
			assert.match(joined.src, /\?song=s17a$/);
			const host = await hostPage.evaluate(() => ({ time: [...document.querySelectorAll('audio')].find((a) => !a.paused)?.currentTime ?? 0, at: Date.now() }));
			// The two are read one after the other, and with the browser files
			// running side by side seconds passed between them: the host's time is
			// taken back to the moment the guest's was read.
			const hostTime = host.time - (host.at - joined.at) / 1000;
			assert.ok(Math.abs(joined.time - hostTime) < 1.5, `the guest is at ${joined.time}, the host at ${hostTime} by the same clock`);
			await hostPage.locator('aside.panel .live', { hasText: '1 listening' }).waitFor({ timeout: 5000 });

			await hostPage.locator('aside.panel button.step').nth(1).click();
			await guest.locator('h1', { hasText: 'Song 17b' }).waitFor({ timeout: 5000 });
			await guest.waitForFunction(() => /\?song=s17b$/.test(document.querySelector('audio.together-audio')?.getAttribute('src') ?? ''), null, { timeout: 5000 });

			// The guest's audio fails as the host goes back to the first track: the page hears of
			// the change and cannot fetch it. Then it loads the track again by itself; the
			// element once stayed in its error, silent until a reload. Only the stream is
			// cut: offline, the event stream sometimes went too, and the page never heard.
			const stream = (url) => url.pathname.endsWith('/stream');
			await guestContext.route(stream, (route) => route.abort('internetdisconnected'));
			// Picked on the album page: "previous" past 3 seconds into a track restarts it, and a slow runner got there.
			await hostPage.getByRole('button', { name: 'Play Song 17a', exact: true }).click();
			await guest.waitForFunction(() => document.querySelector('audio.together-audio')?.error, null, { timeout: 10000 });
			await guestContext.unroute(stream);
			await guest.waitForFunction(
				() => {
					const a = document.querySelector('audio.together-audio');
					return /\?song=s17a$/.test(a?.getAttribute('src') ?? '') && !a.error && !a.paused && a.currentTime > 0;
				},
				null,
				{ timeout: 10000 }
			);
			assert.equal(await guest.locator('[role=alert]').count(), 0, 'the guest was asked to press Join again');

			await hostPage.keyboard.press('Space');
			await guest.waitForFunction(() => document.querySelector('audio.together-audio')?.paused === true, null, { timeout: 5000 });

			await guest.getByRole('button', { name: 'Send 🔥' }).click();
			await hostPage.locator('.reactions .reaction', { hasText: '🔥' }).waitFor({ timeout: 5000 });

			await hostPage.locator('aside.panel .live').click();
			await hostPage.getByRole('button', { name: 'End listening together' }).click();
			await guest.locator('h1', { hasText: 'It has ended' }).waitFor({ timeout: 5000 });
		} finally {
			subsonic.state.audio = null;
		}
		assert.deepEqual(problems, []);
	});

	/*
	 * Two accounts on one music server. The mock's search for "Artist 0005"
	 * finds Song 5a, Song 6b and Song 7a, and the host's account is made
	 * unable to read the last.
	 */
	test("a member's tracks play after the current one in the order added, a visitor only watches, and the host removes a track and then the member", async () => {
		const { page: hostPage, problems } = await signedInPage();
		const { page: member, problems: memberProblems } = await signedInPage('seconduser', 'secondpass');
		const visitorContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
		browsers.push(visitorContext);
		const visitor = await visitorContext.newPage();
		/** The host's queue from the playing track on, each row with who added it. */
		const hostQueue = () =>
			hostPage.evaluate(() => {
				const rows = [...document.querySelectorAll('aside.panel .queue-list > li')];
				return rows.slice(rows.findIndex((row) => row.querySelector('.row.current'))).map((row) => {
					const by = /Added by (.+)$/.exec(row.querySelector('.row-sub')?.textContent.trim() ?? '');
					return `${row.querySelector('.row-title')?.textContent.trim()}${by ? ` (${by[1]})` : ''}`;
				});
			});
		/** What a party page shows as up next, each row with who added it and whether it can be taken back. */
		const upNext = (page) =>
			page.evaluate(() =>
				[...document.querySelectorAll('ol.rows > li')].map((row) => {
					const by = /Added by (.+)$/.exec(row.querySelector('.sub')?.textContent.trim() ?? '');
					return `${row.querySelector('.title')?.textContent.trim()}${by ? ` (${by[1]})` : ''}${row.querySelector('button') ? ' [Remove]' : ''}`;
				})
			);
		const settles = async (read, want, what) => {
			const deadline = Date.now() + 5000;
			let got;
			do {
				got = await read();
				if (JSON.stringify(got) === JSON.stringify(want)) return;
				await new Promise((done) => setTimeout(done, 100));
			} while (Date.now() < deadline);
			assert.deepEqual(got, want, what);
		};
		const add = (title) => member.getByRole('button', { name: `Add ${title} to the queue` }).click();
		const told = (text) => member.locator('.next .note', { hasText: text }).waitFor({ timeout: 5000 });
		/** Additions are held to one every 2 seconds per member. */
		const gap = () => new Promise((done) => setTimeout(done, 2100));
		subsonic.state.audio = { type: 'audio/wav', body: silentWav(60) };
		subsonic.state.hidden.set('testuser', new Set(['s7a']));
		try {
			await hostPage.goto(remoteApp.url + '/albums/al17', { waitUntil: 'load' });
			await hostPage.getByRole('button', { name: 'Play Song 17a', exact: true }).click();
			await hostPage.waitForFunction(() => [...document.querySelectorAll('audio')].some((a) => !a.paused), null, { timeout: 5000 });
			await hostPage.getByRole('button', { name: 'Share a link to this song' }).click();
			await hostPage.getByRole('button', { name: 'Listen together' }).click();
			const field = hostPage.getByRole('textbox', { name: 'Listen-together link' });
			await field.waitFor({ timeout: 5000 });
			const link = await field.inputValue();
			await hostPage.locator('dialog.together').getByRole('button', { name: 'Close' }).click();
			await hostPage.locator('aside.panel').getByRole('button', { name: 'Queue', exact: true }).click();
			await settles(hostQueue, ['Song 17a', 'Song 17b'], "the host's queue before anyone joins");

			// The visitor sees the queue, and has nothing to add with.
			await visitor.goto(link, { waitUntil: 'load' });
			await visitor.getByRole('button', { name: 'Join', exact: true }).click();
			await settles(() => upNext(visitor), ['Song 17b'], 'what the visitor is shown as up next');

			await member.goto(link, { waitUntil: 'load' });
			assert.equal(await member.locator('form.search').count(), 0, 'the search is there before the member joined');
			await member.getByRole('button', { name: 'Join as seconduser' }).click();
			const search = member.getByRole('searchbox', { name: 'Search your library' });
			await search.waitFor({ timeout: 5000 });
			await hostPage.locator('aside.panel .live', { hasText: '2 listening' }).waitFor({ timeout: 5000 });

			await search.fill('Artist 0005');
			await search.press('Enter');
			await member.getByRole('list', { name: 'Search results' }).getByRole('listitem').nth(2).waitFor({ timeout: 5000 });
			await add('Song 5a');
			await told('Song 5a was added.');
			// Inside the 2 seconds.
			await add('Song 6b');
			await told('One track every 2 seconds.');
			await gap();
			await add('Song 7a');
			await told("Not in the host's library");
			await gap();
			await add('Song 6b');
			await told('Song 6b was added.');

			// After the current track, in the order added, ahead of the host's own next track.
			await settles(hostQueue, ['Song 17a', 'Song 5a (seconduser)', 'Song 6b (seconduser)', 'Song 17b'], "the host's queue after two additions");
			await settles(() => upNext(member), ['Song 5a (you) [Remove]', 'Song 6b (you) [Remove]', 'Song 17b'], 'what the member is shown');
			await settles(() => upNext(visitor), ['Song 5a (seconduser)', 'Song 6b (seconduser)', 'Song 17b'], 'what the visitor is shown');
			assert.equal(await visitor.locator('form.search').count(), 0, 'a visitor has a search to add from');

			await hostPage.locator('aside.panel button.step').nth(1).click();
			await titleIs(hostPage, 'Song 5a');
			await member.locator('h1', { hasText: 'Song 5a' }).waitFor({ timeout: 5000 });
			await member.waitForFunction(() => /\?song=s5a$/.test(document.querySelector('audio.together-audio')?.getAttribute('src') ?? ''), null, { timeout: 5000 });
			await settles(hostQueue, ['Song 5a (seconduser)', 'Song 6b (seconduser)', 'Song 17b'], "the host's queue after the skip");

			// The host removes the member's track, and then the member.
			await hostPage.getByRole('button', { name: 'Remove Song 6b from the queue' }).click();
			await settles(() => upNext(member), ['Song 17b'], 'what the member is shown after the host removed their track');
			await hostPage.locator('aside.panel .live').click();
			await hostPage.getByRole('button', { name: 'Remove seconduser from listening together' }).click();
			await member.locator('h1', { hasText: 'You were removed' }).waitFor({ timeout: 5000 });
			await member.waitForFunction(() => document.querySelector('audio.together-audio')?.paused === true, null, { timeout: 5000 });
			assert.equal(await member.locator('form.search').count(), 0);
			assert.equal((await member.goto(link, { waitUntil: 'load' })).status(), 403, 'the removed member came back');
			await hostPage.locator('dialog.together p.count', { hasText: '1 listening with you' }).waitFor({ timeout: 5000 });
			assert.equal(await hostPage.locator('dialog.together .members li').count(), 0);
			assert.equal(await visitor.locator('h1').textContent(), 'Song 5a', 'the visitor was taken out with the member');
		} finally {
			subsonic.state.audio = null;
			subsonic.state.hidden.clear();
		}
		// The refusals above are the server's answers, which the browser logs.
		const refused = /status of (403|404|429)/;
		assert.deepEqual([...problems, ...memberProblems].filter((problem) => !refused.test(problem)), []);
	});
});

describe('casting', () => {
	/*
	 * No receiver answers in a headless browser, so the Remote Playback API is
	 * stood in for: a device is always available, a prompt connects, and
	 * `__disconnect()` ends it. This checks Heddohon's side: the addresses the
	 * element plays from, and the one element.
	 */
	async function castingContext() {
		const casting = await browser.newContext({ viewport: { width: 1440, height: 900 } });
		await casting.addInitScript(() => {
			class FakeRemote extends EventTarget {
				state = 'disconnected';
				watchAvailability(callback) {
					callback(true);
					return Promise.resolve(1);
				}
				cancelWatchAvailability() {
					return Promise.resolve();
				}
				prompt() {
					this.state = 'connected';
					setTimeout(() => this.dispatchEvent(new Event('connect')));
					return Promise.resolve();
				}
			}
			const remotes = new WeakMap();
			Object.defineProperty(HTMLMediaElement.prototype, 'remote', {
				configurable: true,
				get() {
					if (!remotes.has(this)) remotes.set(this, new FakeRemote());
					return remotes.get(this);
				}
			});
			window.__disconnect = () => {
				for (const element of document.querySelectorAll('audio')) {
					if (element.remote.state !== 'connected') continue;
					element.remote.state = 'disconnected';
					element.remote.dispatchEvent(new Event('disconnect'));
				}
			};
		});
		const signIn = await casting.request.post(`${app.url}/login`, {
			form: { username: 'testuser', password: 'testpass', backend: 'subsonic', next: '/' },
			headers: { origin: app.url, accept: 'text/html' },
			maxRedirects: 0
		});
		assert.equal(signIn.status(), 303);
		return casting;
	}

	test('is offered in the list of outputs as well, and starts from there', async () => {
		const casting = await castingContext();
		const page = await casting.newPage();
		subsonic.state.audio = { type: 'audio/wav', body: silentWav(30) };
		try {
			await page.goto(app.url + '/albums/al11', { waitUntil: 'networkidle' });
			await page.getByRole('button', { name: 'Play Song 11a', exact: true }).click();
			await page.getByRole('button', { name: /^Audio output/ }).click();
			const chip = page.locator('.outputs').getByRole('button', { name: 'Cast…' });
			await chip.click();
			await page.locator('.outputs').getByRole('button', { name: 'Casting' }).waitFor({ timeout: 5000 });
			await page.waitForFunction(() => [...document.querySelectorAll('audio')].some((a) => (a.getAttribute('src') ?? '').startsWith('/cast/')), null, {
				timeout: 5000
			});
		} finally {
			subsonic.state.audio = null;
			await casting.close();
		}
	});

	test('plays each track from a cast address on one element, and goes back when disconnected', async () => {
		const casting = await castingContext();
		const page = await casting.newPage();
		const problems = [];
		page.on('pageerror', (err) => problems.push(err.message));
		const sources = () => page.evaluate(() => [...document.querySelectorAll('audio')].map((a) => a.getAttribute('src') ?? ''));
		const playingFrom = async (pattern) =>
			page.waitForFunction((source) => [...document.querySelectorAll('audio')].some((a) => new RegExp(source).test(a.getAttribute('src') ?? '')), pattern.source, {
				timeout: 5000
			});

		subsonic.state.audio = { type: 'audio/wav', body: silentWav(15) };
		subsonic.state.albumSongs = 4;
		try {
			await page.goto(app.url + '/albums/al9', { waitUntil: 'networkidle' });
			await page.getByRole('button', { name: 'Play Song 9a', exact: true }).click();
			await page.waitForFunction(() => document.querySelector('aside.panel h2.title')?.textContent === 'Song 9a');

			// Chromium lists outputs, so casting is the last of them and has no
			// button of its own.
			assert.equal(await page.getByRole('button', { name: 'Cast to a speaker or a TV' }).count(), 0);
			await page.getByRole('button', { name: /^Audio output/ }).click();
			await page.locator('.outputs').getByRole('button', { name: 'Cast…' }).click();
			await page.locator('.outputs').getByRole('button', { name: 'Casting' }).waitFor({ timeout: 5000 });
			await playingFrom(/^\/cast\//);

			await page.locator('aside.panel button.step').nth(1).click();
			await page.waitForFunction(() => document.querySelector('aside.panel h2.title')?.textContent === 'Song 9b');
			await playingFrom(/^\/cast\//);
			// Nothing buffered into the other element: the receiver follows one.
			// The track is 15 seconds, inside the 20 before its end where the next
			// one would be preloaded, which happens on a `timeupdate`.
			await page.waitForFunction(() => [...document.querySelectorAll('audio')].some((a) => !a.paused && a.currentTime > 1), null, {
				timeout: 5000
			});
			assert.equal((await sources()).filter(Boolean).length, 1, `two sources: ${await sources()}`);

			await page.evaluate(() => window.__disconnect());
			await page.locator('.outputs').getByRole('button', { name: 'Cast…' }).waitFor({ timeout: 5000 });
			await page.locator('aside.panel button.step').nth(1).click();
			await page.waitForFunction(() => document.querySelector('aside.panel h2.title')?.textContent === 'Song 9c');
			await playingFrom(/^\/api\/stream\//);
		} finally {
			subsonic.state.audio = null;
			subsonic.state.albumSongs = 2;
			await casting.close();
		}
		assert.deepEqual(problems, []);
	});
});

describe('your listening', () => {
	test('draws the hour and the day in this browser\'s time, with the run of days', async () => {
		const { page, problems } = await watchedPage();
		try {
			for (const songId of ['s15a', 's15a', 's16a']) {
				const response = await context.request.post(`${app.url}/api/playback`, {
					data: { songId, event: 'stop', position: 100, completed: true },
					headers: { origin: app.url }
				});
				assert.equal(response.status(), 200);
			}
			await page.goto(app.url + '/stats', { waitUntil: 'networkidle' });
			assert.equal(await page.locator('.plot').nth(0).locator('.column').count(), 24);
			assert.equal(await page.locator('.plot').nth(1).locator('.column').count(), 7);
			// This test's three plays were in one hour, so the busiest hour holds at
			// least three. Which hour it is, is not checked: other tests play too,
			// and an earlier one leaves Playwright's clock on this context.
			const peak = page.locator('.plot').nth(0).locator('.column.peak');
			assert.equal(await peak.count(), 1);
			const label = await peak.getAttribute('aria-label');
			assert.ok(Number(/: (\d+) plays$/.exec(label ?? '')?.[1] ?? 0) >= 3, `the busiest hour reads "${label}"`);
			// At least today. A run of the suite that crosses midnight makes it two.
			const run = page.locator('.figure', { hasText: 'Longest run' }).locator('.number');
			assert.ok(Number(await run.textContent()) >= 1);
		} finally {
			await page.close();
		}
		assert.deepEqual(problems, []);
	});

	test('the recap of this year names its busiest day and saves a card as a picture', async () => {
		const { page, problems } = await watchedPage();
		try {
			const response = await context.request.post(`${app.url}/api/playback`, {
				data: { songId: 's17b', event: 'stop', position: 100, completed: true },
				headers: { origin: app.url }
			});
			assert.equal(response.status(), 200);
			await page.goto(app.url + '/stats/recap', { waitUntil: 'networkidle' });
			assert.equal(await page.locator('h1').textContent(), String(new Date().getUTCFullYear()));
			const busiest = page.locator('.figure', { hasText: 'Busiest day' }).locator('.value');
			assert.notEqual((await busiest.textContent()).trim(), '–');
			assert.equal(await page.locator('.months li').count(), 12);

			const download = page.waitForEvent('download');
			await page.getByRole('button', { name: 'Save as a picture' }).click();
			const file = await download;
			assert.match(file.suggestedFilename(), /^heddohon-recap-\d{4}\.png$/);
			const bytes = await readFile(await file.path());
			// A PNG, 1080 by 1350: the signature, then the width and height in IHDR.
			assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
			assert.deepEqual([bytes.readUInt32BE(16), bytes.readUInt32BE(20)], [1080, 1350]);
		} finally {
			await page.close();
		}
		assert.deepEqual(problems, []);
	});
});

describe('your listening, day by day', () => {
	/*
	 * Plays today, three days ago and ten days ago, the two older ones brought
	 * in from the music server with their dates.
	 */
	test('draws the days as a line and a calendar, the hours against the weekdays, and the parts of the day', async () => {
		const daysAgo = (days) => new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
		subsonic.state.played.set('s18a', daysAgo(3));
		subsonic.state.played.set('s19a', daysAgo(10));
		const { page, problems } = await watchedPage();
		try {
			for (const songId of ['s17a', 's17a']) {
				await context.request.post(`${app.url}/api/playback`, { data: { songId, event: 'stop', position: 100, completed: true }, headers: { origin: app.url } });
			}
			const imported = await context.request.post(`${app.url}/settings?/importHistory`, {
				headers: { origin: app.url, 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', 'x-sveltekit-action': 'true' },
				data: ''
			});
			assert.equal((await imported.json()).type, 'success');
			await page.goto(app.url + '/stats', { waitUntil: 'networkidle' });

			// The line: one stop for the keyboard, a point for each of the 31 days.
			const line = page.getByRole('slider', { name: /^Plays by day/ });
			assert.equal(await line.getAttribute('aria-valuemax'), '30');
			assert.equal(await line.getAttribute('aria-valuetext'), 'No day chosen');
			await line.focus();
			await page.keyboard.press('End');
			const today = await line.getAttribute('aria-valuetext');
			assert.match(today, /: \d+ plays?$/);
			assert.ok(Number(/: (\d+) play/.exec(today)[1]) >= 2, `today reads "${today}"`);
			await page.keyboard.press('ArrowLeft');
			assert.notEqual(await line.getAttribute('aria-valuetext'), today);
			assert.equal(await line.getAttribute('aria-valuenow'), '29');
			assert.match(await page.locator('.trend .readout').textContent(), /plays?/);
			await page.keyboard.press('Escape');
			assert.equal(await line.getAttribute('aria-valuetext'), 'No day chosen');

			// The calendar: whole weeks, the three days lit, and a line of text under the pointer.
			const calendar = page.locator('.calendar .weeks');
			const cells = await calendar.locator('.cell').count();
			assert.equal(cells % 7 === 0 || cells >= 31, true);
			assert.equal(await calendar.locator('.cell:not(.blank)').count(), 31);
			assert.ok((await calendar.locator('.cell:not([data-level="0"]):not(.blank)').count()) >= 3, 'the days played on are not lit');
			await calendar.locator('.cell[data-level="4"]').first().hover();
			const tip = page.locator('.tip[aria-hidden="true"]').last();
			await tip.waitFor();
			assert.match(await tip.textContent(), /\d+ plays?/);
			// Inside the window, and off when the pointer leaves the charts.
			const box = await tip.boundingBox();
			assert.ok(box.x >= 0 && box.x + box.width <= 1440, JSON.stringify(box));
			await page.locator('h1').hover();
			assert.equal(await page.locator('.maps ~ .tip, .tip.hh-numeric[style*="left"]').count(), 0, 'the line of text stayed');

			// The hours against the weekdays: 7 rows of 24, with as many plays as the page counts.
			assert.equal(await page.locator('.punch .row').count(), 7);
			assert.equal(await page.locator('.punch .row .cell').count(), 168);
			const inRows = await page.locator('.punch .row').evaluateAll((rows) => rows.reduce((sum, row) => sum + Number(/: ([\d,.]+) play/.exec(row.getAttribute('aria-label'))[1].replace(/\D/g, '')), 0));
			// The figure counts up as it comes into view, and is the total once it lands.
			await page.waitForFunction(
				(want) => Number(document.querySelector('.figure.hero .number')?.textContent.replace(/\D/g, '')) === want,
				inRows,
				{ timeout: 5000 }
			);

			// The parts of the day are shares of the same plays.
			const shares = await page.locator('.parts .count').allTextContents();
			assert.equal(shares.length, 4);
			const percent = shares.reduce((sum, text) => sum + Number(/^(\d+)%/.exec(text.trim())[1]), 0);
			assert.ok(percent >= 98 && percent <= 102, `the parts add to ${percent}%`);

			// Each chart has its values as a table.
			assert.equal(await page.locator('.trend details.table tbody tr').count(), 31);
			assert.equal(await page.locator('.maps details.table').nth(1).locator('tbody tr').count(), 24);
		} finally {
			subsonic.state.played.clear();
			await page.close();
		}
		assert.deepEqual(problems, []);
	});
});

describe('the living-room screen', () => {
	test('shows what plays with its lyrics, keeps playing on the way in, and takes a remote\'s keys', async () => {
		const { page, problems } = await watchedPage();
		const title = () => page.locator('.screen h1.title').textContent();
		subsonic.state.audio = { type: 'audio/wav', body: silentWav(30) };
		subsonic.state.lyrics.set('s14a', [
			{ start: 0, value: 'First line on the screen' },
			{ start: 60_000, value: 'A line a minute in' }
		]);
		try {
			await page.goto(app.url + '/albums/al14', { waitUntil: 'networkidle' });
			await page.getByRole('button', { name: 'Play Song 14a', exact: true }).click();
			await page.waitForFunction(() => [...document.querySelectorAll('audio')].some((a) => !a.paused), null, { timeout: 5000 });

			// From the rail, in place: the music does not stop on the way.
			await page.locator('nav.rail a[href="/screen"]').click();
			await page.waitForURL(/\/screen$/);
			await page.waitForFunction(() => document.querySelector('.screen h1.title')?.textContent === 'Song 14a');
			assert.equal(await page.locator('nav.rail').count(), 0, 'the rail is drawn on the screen');
			assert.equal(await page.locator('aside.panel').count(), 0, 'the player panel is drawn on the screen');
			assert.ok(await page.evaluate(() => [...document.querySelectorAll('audio')].some((a) => !a.paused)), 'playback stopped on the way in');
			await page.locator('.screen .lyrics .now', { hasText: 'First line on the screen' }).waitFor({ timeout: 5000 });
			assert.equal(await page.locator('.screen .lyrics .next').textContent(), 'A line a minute in');
			assert.match(await page.locator('.screen .up-next').textContent(), /Song 14b/);

			await page.keyboard.press('ArrowRight');
			await page.waitForFunction(() => document.querySelector('.screen h1.title')?.textContent === 'Song 14b');
			await page.keyboard.press('Enter');
			await page.waitForFunction(() => [...document.querySelectorAll('audio')].every((a) => a.paused), null, { timeout: 5000 });
			assert.equal(await page.locator('.screen .hh-eyebrow').first().textContent(), 'Paused');
			await page.keyboard.press('Space');
			await page.waitForFunction(() => [...document.querySelectorAll('audio')].some((a) => !a.paused), null, { timeout: 5000 });
			const before = await page.evaluate(() => [...document.querySelectorAll('audio')].find((a) => !a.paused).volume);
			await page.keyboard.press('ArrowDown');
			await page.waitForFunction((was) => [...document.querySelectorAll('audio')].find((a) => !a.paused)?.volume < was, before, { timeout: 5000 });
			assert.equal(await title(), 'Song 14b');

			await page.keyboard.press('Escape');
			await page.waitForURL((url) => url.pathname === '/');
			await page.locator('nav.rail').waitFor();
		} finally {
			subsonic.state.audio = null;
			subsonic.state.lyrics.clear();
			await page.close();
		}
		assert.deepEqual(problems, []);
	});
});
