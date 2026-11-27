/**
 * Settings: scrobblers, the queue restored, the offline page, the audio output, the tabs, On this day, and the colours of the themes.
 *
 *   npm run build
 *   node --test tests/browser/settings.test.mjs
 *
 * Runs the built app against the mock servers of `tests/e2e`; see `suite.mjs`.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { silentWav } from '../e2e/mocks.mjs';
import { subsonic, app, browser, context, select, pick, autosaved, optionsOf, shown, watchedPage, playable, setUpSuite } from './suite.mjs';

setUpSuite();

describe('linking scrobblers from Settings', () => {
	test('ListenBrainz by token, and Last.fm through last.fm and back', async () => {
		const { page, problems } = await watchedPage();
		const nd = subsonic.state.navidrome;
		// last.fm is not reachable from here. Its approval page does one thing
		// Heddohon relies on: send the browser to `cb` with `token` appended.
		let approval = null;
		await page.route('https://www.last.fm/**', (route) => {
			approval = new URL(route.request().url());
			const back = `${approval.searchParams.get('cb')}&token=lastfm-ok`;
			return route.fulfill({ status: 302, headers: { location: back } });
		});
		try {
			await page.goto(app.url + '/settings', { waitUntil: 'networkidle' });
			await page.getByRole('navigation', { name: 'Settings' }).getByRole('link', { name: 'Connections' }).click();
			const section = page.locator('#scrobbling');
			await section.waitFor();

			await section.getByLabel('ListenBrainz user token').fill(subsonic.LISTENBRAINZ_TOKEN);
			await section.getByRole('button', { name: 'Link', exact: true }).click();
			await section.getByLabel('ListenBrainz user token').waitFor({ state: 'detached' });
			assert.equal(nd.linked.listenbrainz, true);

			await section.getByRole('button', { name: 'Link on last.fm' }).click();
			await page.waitForURL(/\/settings\?lastfm=linked$/);
			assert.equal(approval?.searchParams.get('api_key'), 'mock-lastfm-key');
			assert.equal(nd.linked.lastfm, true);
			await page.getByText('Last.fm is linked.').waitFor();

			await section.getByRole('button', { name: 'Unlink' }).first().click();
			await section.getByRole('button', { name: 'Link on last.fm' }).waitFor();
			assert.equal(nd.linked.lastfm, false);
		} finally {
			nd.linked.lastfm = false;
			nd.linked.listenbrainz = false;
			await page.close();
		}
		assert.deepEqual(problems, []);
	});
});

describe('restoring the queue', () => {
	/*
	 * On Subsonic every queued id was a `getSong` call, eight at a time, and
	 * the player stayed empty until the last had answered. The current track
	 * is looked up on its own first; the rest of the queue is one `/api/song`
	 * request on Navidrome. Both are held here, the queue's for longer, so the
	 * track has to show before the queue answers.
	 */
	test('the current track shows before the rest of the queue, and a save made meanwhile keeps the whole queue', async () => {
		const ids = Array.from({ length: 40 }, (_, i) => `s${i}a`);
		const put = await context.request.put(`${app.url}/api/play-state`, {
			data: { songIds: ids, index: 20, position: 0, repeat: 'off', shuffle: false },
			headers: { origin: app.url }
		});
		assert.equal(put.status(), 200);
		subsonic.state.delays.set('getSong', 300);
		subsonic.state.delays.set('/api/song', 3000);
		subsonic.calls.reset();
		let restAnswered = false;

		const { page, problems } = await watchedPage();
		const saved = [];
		page.on('request', (request) => {
			if (request.method() === 'PUT' && request.url().endsWith('/api/play-state')) {
				saved.push(request.postDataJSON());
			}
		});
		try {
			const whole = page
				.waitForResponse(
					(response) => response.url().endsWith('/api/songs') && response.request().postDataJSON().ids.length === 40,
					{ timeout: 15_000 }
				)
				.then((response) => {
					restAnswered = true;
					return response;
				});
			await page.goto(app.url + '/');
			await page.waitForFunction(() => document.querySelector('aside.panel h2.title')?.textContent === 'Song 20a', null, {
				timeout: 5000
			});
			// The 1-id lookup answered and the 40-id one has not: the whole
			// queue is still out when the track is already on screen.
			assert.equal(restAnswered, false, 'the rest of the queue answered before the current track showed');
			assert.ok(subsonic.calls.get('getSong') < 41, `looked up ${subsonic.calls.get('getSong')} before showing`);

			// A save while only the current track is in: it must carry the saved queue.
			await page.getByRole('button', { name: 'Repeat: off' }).click();
			await page.waitForTimeout(1500);
			assert.ok(saved.length > 0, 'the repeat change was saved');
			assert.equal(subsonic.calls.get('/api/song'), 1, 'the rest of the queue in one request');
			assert.ok(subsonic.calls.get('getSong') < 41, 'the save landed before the rest of the queue');
			assert.deepEqual(saved.at(-1).songIds, ids);
			assert.equal(saved.at(-1).index, 20);

			await whole;
			await page.getByRole('button', { name: 'Next track' }).click();
			await page.waitForFunction(() => document.querySelector('aside.panel h2.title')?.textContent === 'Song 21a', null, {
				timeout: 5000
			});
		} finally {
			subsonic.state.delays.clear();
			await context.request.put(`${app.url}/api/play-state`, {
				data: { songIds: [], index: 0, position: 0, repeat: 'off', shuffle: false },
				headers: { origin: app.url }
			});
			await page.close();
		}
		assert.deepEqual(problems, []);
	});

	/*
	 * A play pressed while the saved queue's current track was being looked up
	 * was replaced by the saved queue when the lookup answered: the dock showed
	 * the new track, then the old one, and the next save wrote the old queue
	 * back. It surfaced in CI as phone tests that came back to the previous
	 * test's album after a page load.
	 */
	test('a track played while the saved queue is being looked up stays, and is what is saved', async (t) => {
		playable(t);
		await context.request.put(`${app.url}/api/play-state`, {
			data: { songIds: ['s30a', 's30b'], index: 0, position: 0, repeat: 'off', shuffle: false },
			headers: { origin: app.url }
		});
		subsonic.state.delays.set('getSong', 1500);
		const page = await context.newPage();
		const title = () => page.evaluate(() => document.querySelector('aside.panel h2.title')?.textContent);
		try {
			// The restore's first lookup going out means the layout has hydrated.
			const lookup = page.waitForRequest((request) => request.url().endsWith('/api/songs'));
			await page.goto(app.url + '/albums/al31', { waitUntil: 'load' });
			await lookup;
			await page.getByRole('button', { name: 'Play Song 31a', exact: true }).click();
			await page.waitForFunction(() => document.querySelector('aside.panel h2.title')?.textContent === 'Song 31a');

			// Past the lookup's 1.5s, and the 1.2s the save waits for.
			await page.waitForTimeout(3000);
			assert.equal(await title(), 'Song 31a', 'the saved queue replaced the track played');
			const saved = await (await context.request.get(`${app.url}/api/play-state`)).json();
			assert.deepEqual(saved.songIds, ['s31a', 's31b'], 'the saved queue was written back');
		} finally {
			subsonic.state.delays.clear();
			await context.request.put(`${app.url}/api/play-state`, {
				data: { songIds: [], index: 0, position: 0, repeat: 'off', shuffle: false },
				headers: { origin: app.url }
			});
			await page.close();
		}
	});

	/*
	 * A hidden or closed page wrote its queue whether or not it had changed
	 * it. A browser left open with a queue from days before wrote it over the
	 * one another browser had played since, and the account reopened on the
	 * old track. Brought back to the front, it also kept showing the old one.
	 */
	test('a browser left idle does not write its queue over one played since, and takes the newer one when returned to', async () => {
		const other = await browser.newContext({ viewport: { width: 1440, height: 900 } });
		const signIn = await other.request.post(`${app.url}/login`, {
			form: { username: 'testuser', password: 'testpass', backend: 'subsonic', next: '/' },
			headers: { origin: app.url, accept: 'text/html' },
			maxRedirects: 0
		});
		assert.equal(signIn.status(), 303);
		await context.request.put(`${app.url}/api/play-state`, {
			data: { songIds: ['s30a', 's30b'], index: 0, position: 0, repeat: 'off', shuffle: false },
			headers: { origin: app.url }
		});
		const title = (page) => page.evaluate(() => document.querySelector('aside.panel h2.title')?.textContent);
		const saved = async () => (await (await context.request.get(`${app.url}/api/play-state`)).json()).songIds;
		const show = (page, hidden) =>
			page.evaluate((hidden) => {
				Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
				document.dispatchEvent(new Event('visibilitychange'));
			}, hidden);

		const playing = (page) =>
			page.waitForFunction(() => [...document.querySelectorAll('audio')].some((a) => !a.paused && a.currentTime > 0.2), null, {
				timeout: 10_000
			});
		const pause = async (page) => {
			await page.locator('aside.panel').getByRole('button', { name: 'Pause', exact: true }).click();
			await page.locator('aside.panel').getByRole('button', { name: 'Play', exact: true }).waitFor();
			// Past the 1.2s the save waits for.
			await page.waitForTimeout(1800);
		};
		subsonic.state.audio = { type: 'audio/wav', body: silentWav(60) };

		const idle = await other.newPage();
		const active = await context.newPage();
		try {
			// The idle browser plays the old queue and pauses, so its element holds
			// the old track.
			await idle.goto(app.url + '/', { waitUntil: 'load' });
			await idle.waitForFunction(() => document.querySelector('aside.panel h2.title')?.textContent === 'Song 30a');
			await idle.locator('aside.panel button.play').click();
			await playing(idle);
			await pause(idle);
			await show(idle, true);

			await active.goto(app.url + '/albums/al31', { waitUntil: 'load' });
			await active.waitForFunction(() => document.querySelector('aside.panel h2.title')?.textContent === 'Song 30a');
			await active.getByRole('button', { name: 'Play Song 31a', exact: true }).click();
			await active.waitForFunction(() => document.querySelector('aside.panel h2.title')?.textContent === 'Song 31a');
			await playing(active);
			await pause(active);
			assert.deepEqual(await saved(), ['s31a', 's31b']);

			// Returned to: the newer queue, and play starts its track.
			await show(idle, false);
			await idle.waitForFunction(() => document.querySelector('aside.panel h2.title')?.textContent === 'Song 31a', null, {
				timeout: 5000
			});
			await show(idle, true);
			await idle.evaluate(() => window.dispatchEvent(new Event('pagehide')));
			await idle.waitForTimeout(800);
			assert.deepEqual(await saved(), ['s31a', 's31b'], 'the idle browser wrote its queue over the newer one');
			await show(idle, false);
			await idle.locator('aside.panel button.play').click();
			await playing(idle);
			assert.equal(await title(idle), 'Song 31a');
			assert.deepEqual(
				await idle.evaluate(() => [...document.querySelectorAll('audio')].filter((a) => !a.paused).map((a) => new URL(a.src).pathname)),
				['/api/stream/s31a'],
				'play started another track than the one shown'
			);

			// A browser that is playing keeps its queue when returned to.
			await active.getByRole('button', { name: 'Play Song 31b', exact: true }).click();
			await active.waitForFunction(() => document.querySelector('aside.panel h2.title')?.textContent === 'Song 31b');
			await playing(active);
			await pause(active);
			assert.deepEqual(await saved(), ['s31a', 's31b']);
			await show(idle, true);
			await show(idle, false);
			await idle.waitForTimeout(1500);
			assert.equal(await title(idle), 'Song 31a', 'a playing browser took the saved queue');
		} finally {
			subsonic.state.audio = null;
			await idle.close();
			await active.close();
			await other.close();
			await context.request.put(`${app.url}/api/play-state`, {
				data: { songIds: [], index: 0, position: 0, repeat: 'off', shuffle: false },
				headers: { origin: app.url }
			});
		}
	});
});

describe('the offline page', () => {
	test('a page load with no connection shows the offline page, which reloads when the connection returns', async () => {
		// A context of its own, so going offline touches no other test.
		const offline = await browser.newContext();
		try {
			const page = await offline.newPage();
			await page.goto(`${app.url}/login`, { waitUntil: 'networkidle' });
			await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout: 10_000 });

			await offline.setOffline(true);
			const response = await page.goto(`${app.url}/login`);
			assert.equal(response?.status(), 200, 'the worker answered the failed load');
			// Shown at a private address, with the headers any page carries.
			const headers = response?.headers() ?? {};
			assert.equal(headers['x-frame-options'], 'SAMEORIGIN');
			assert.match(headers['content-security-policy'] ?? '', /default-src 'none'/);
			assert.match(headers['permissions-policy'] ?? '', /camera=\(\)/);
			await page.getByRole('heading', { name: 'Heddohon cannot reach its server' }).waitFor();

			await offline.setOffline(false);
			// The page asks every 5 seconds and on the browser's `online` event.
			await page.locator('input[name="username"]').waitFor({ timeout: 10_000 });
			assert.equal(new URL(page.url()).pathname, '/login');
		} finally {
			await offline.close();
		}
	});
});

describe('playing from favourites', () => {
	for (const [kind, heading] of [
		['artist', 'Artist 0000'],
		['album', 'Album 0']
	]) {
		test(`a favourite track keeps playing after following its ${kind} link`, async () => {
			subsonic.state.audio = { type: 'audio/wav', body: silentWav(30) };
			const { page, problems } = await watchedPage();
			try {
				await page.goto(`${app.url}/favourites?tab=songs`, { waitUntil: 'networkidle' });
				await page.getByRole('button', { name: 'Play Song 0a', exact: true }).first().click();
				await page.waitForFunction(() =>
					[...document.querySelectorAll('audio')].some((a) => !a.paused && a.currentTime > 0)
				);
				// A full page load would drop this.
				await page.evaluate(() => (window.__stayed = true));

				const row = page.locator('li, tr, [role="row"]').filter({ hasText: 'Song 0a' }).first();
				await row.locator(`a[href^="/${kind}s/"]`).first().click();
				await page.getByRole('heading', { name: heading, exact: true }).first().waitFor();
				await page.waitForTimeout(1500);

				assert.equal(await page.evaluate(() => window.__stayed === true), true, 'the page was reloaded');
				const playing = await page.evaluate(() =>
					[...document.querySelectorAll('audio')].some((a) => !a.paused && a.currentTime > 0)
				);
				assert.ok(playing, `playback stopped on the way to the ${kind} page`);
			} finally {
				subsonic.state.audio = null;
				await page.close();
			}
			assert.deepEqual(problems, []);
		});
	}

	test('Enter on a track\'s artist link opens the artist rather than playing the row', async () => {
		const { page, problems } = await watchedPage();
		try {
			await page.goto(`${app.url}/favourites?tab=songs`, { waitUntil: 'networkidle' });
			const current = await page.evaluate(() => document.querySelector('aside.panel h2.title')?.textContent ?? null);
			await page.locator('li').filter({ hasText: 'Song 1a' }).first().locator('a[href^="/artists/"]').focus();
			await page.keyboard.press('Enter');
			await page.waitForURL(/\/artists\/ar1$/);
			assert.equal(
				await page.evaluate(() => document.querySelector('aside.panel h2.title')?.textContent ?? null),
				current,
				'the row\'s song was started'
			);
		} finally {
			await page.close();
		}
		assert.deepEqual(problems, []);
	});
});

describe('the audio output', () => {
	test('sits right of the volume slider, lists the default, and asks for names only on request', async () => {
		const { page, problems } = await watchedPage();
		try {
			await page.goto(`${app.url}/albums`, { waitUntil: 'networkidle' });
			const button = page.locator('aside.panel .volume button[aria-label^="Audio output"]');
			await button.waitFor();
			const [slider, control] = await Promise.all([
				page.locator('aside.panel .volume-slider').boundingBox(),
				button.boundingBox()
			]);
			assert.ok(control.x >= slider.x + slider.width, 'the output control is not right of the slider');
			assert.equal(await button.getAttribute('aria-label'), 'Audio output: System default');

			await button.click();
			const outputs = page.getByRole('group', { name: 'Audio output' });
			await outputs.getByRole('button', { name: 'System default' }).waitFor();
			assert.match(await outputs.getByRole('button', { name: 'System default' }).getAttribute('class'), /active/);

			// Nothing asks for the microphone until the button says it will. With
			// fake devices Chromium may name the outputs already, and then there is
			// no button to press.
			const list = outputs.getByRole('button', { name: 'List outputs' });
			if (await list.count()) {
				await list.click();
				await page.waitForFunction(
					() => document.querySelector('.outputs [role="status"]') || !document.querySelector('.outputs .output-note'),
					null,
					{ timeout: 5000 }
				);
			}

			await outputs.getByRole('button', { name: 'System default' }).click();
			const sinks = await page.evaluate(() => [...document.querySelectorAll('audio')].map((a) => a.sinkId));
			assert.deepEqual(sinks, ['', '']);
		} finally {
			await page.close();
		}
		assert.deepEqual(problems, []);
	});

	/*
	 * Chrome refuses the microphone at once, without a prompt, on a computer
	 * with none connected. One sentence covered every refusal, so "List
	 * outputs" there looked like nothing happened. The browser's answers are
	 * stubbed: headless Chromium has no outputs to name.
	 */
	async function outputPanel(stub, arg) {
		const { page, problems } = await watchedPage();
		await page.addInitScript(stub, arg);
		await page.goto(`${app.url}/albums`, { waitUntil: 'networkidle' });
		await page.locator('aside.panel .volume button[aria-label^="Audio output"]').click();
		return { page, problems, outputs: page.getByRole('group', { name: 'Audio output' }) };
	}

	for (const [error, expected] of [
		['NotFoundError', /no microphone is connected/],
		['NotAllowedError', /blocked for this site/]
	]) {
		test(`"List outputs" says why when the microphone is refused (${error})`, async () => {
			const { page, problems, outputs } = await outputPanel((name) => {
				navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('refused', name));
				navigator.mediaDevices.enumerateDevices = async () => [{ kind: 'audiooutput', deviceId: '', label: '', groupId: '' }];
			}, error);
			try {
				await outputs.getByRole('button', { name: 'List outputs' }).click();
				await outputs.getByRole('status').filter({ hasText: expected }).waitFor({ timeout: 3000 });
				assert.equal(await outputs.getByRole('button', { name: 'List outputs' }).isEnabled(), true);
			} finally {
				await page.close();
			}
			assert.deepEqual(problems, []);
		});
	}

	test('"List outputs" names the outputs once the microphone is granted', async () => {
		const { page, problems, outputs } = await outputPanel(() => {
			let granted = false;
			navigator.mediaDevices.getUserMedia = async () => {
				granted = true;
				return new MediaStream();
			};
			navigator.mediaDevices.enumerateDevices = async () => [
				{ kind: 'audiooutput', deviceId: 'default', label: granted ? 'Default' : '', groupId: 'g' },
				{ kind: 'audiooutput', deviceId: granted ? 'dac' : '', label: granted ? 'USB DAC' : '', groupId: 'g' }
			];
		});
		try {
			await outputs.getByRole('button', { name: 'List outputs' }).click();
			await outputs.getByRole('button', { name: 'USB DAC' }).waitFor({ timeout: 3000 });
			assert.equal(await outputs.getByRole('button', { name: 'List outputs' }).count(), 0);
			assert.equal(await outputs.getByRole('button', { name: 'Default', exact: true }).count(), 0, 'the default entry is not listed twice');
		} finally {
			await page.close();
		}
		assert.deepEqual(problems, []);
	});

	test('the sign-in page forgets the output saved in this browser', async () => {
		// Signed out, as a browser is after signing out: a signed-in one is sent
		// on from the sign-in page before it loads.
		const signedOut = await browser.newContext();
		try {
			const page = await signedOut.newPage();
			await page.goto(`${app.url}/offline.html`);
			await page.evaluate(() =>
				localStorage.setItem('heddohon:audio-output', JSON.stringify({ id: 'headset', label: 'Work headset' }))
			);
			await page.goto(`${app.url}/login`, { waitUntil: 'networkidle' });
			assert.equal(await page.evaluate(() => localStorage.getItem('heddohon:audio-output')), null);
		} finally {
			await signedOut.close();
		}
	});

	test('an output saved in this browser that is gone leaves the sound on the default', async () => {
		const { page, problems } = await watchedPage();
		try {
			await page.goto(`${app.url}/albums`, { waitUntil: 'networkidle' });
			await page.evaluate(() =>
				localStorage.setItem('heddohon:audio-output', JSON.stringify({ id: 'unplugged', label: 'Old headphones' }))
			);
			await page.reload({ waitUntil: 'networkidle' });
			const button = page.locator('aside.panel .volume button[aria-label^="Audio output"]');
			await button.waitFor();
			assert.equal(await button.getAttribute('aria-label'), 'Audio output: System default');
		} finally {
			await page.evaluate(() => localStorage.removeItem('heddohon:audio-output')).catch(() => undefined);
			await page.close();
		}
		assert.deepEqual(problems, []);
	});
});

describe('shuffle', () => {
	test('turning shuffle off puts the queue back in its order, around the track playing', async (t) => {
		playable(t);
		// Album 36, which no other test opens, with ten tracks.
		subsonic.state.albumSongs = 10;
		const { page, problems } = await watchedPage();
		const titles = () => page.locator('aside.panel .queue-list .row-title').allTextContents();
		try {
			await page.goto(`${app.url}/albums/al36`, { waitUntil: 'networkidle' });
			await page.getByRole('button', { name: 'Play Song 36c', exact: true }).click();
			await page.locator('aside.panel button[aria-label="Queue"]').click();
			const inOrder = [...'abcdefghij'].map((side) => `Song 36${side}`);
			await page.waitForFunction((n) => document.querySelectorAll('aside.panel .queue-list .row-title').length === n, 10);
			assert.deepEqual(await titles(), inOrder);

			const shuffle = page.locator('aside.panel button[aria-label="Shuffle"]');
			await shuffle.click();
			const mixed = await titles();
			assert.equal(mixed[0], 'Song 36c', 'the playing track moved');
			assert.deepEqual([...mixed].sort(), inOrder);

			await shuffle.click();
			assert.deepEqual(await titles(), inOrder, 'shuffle off left the queue shuffled');
			assert.equal(await page.locator('aside.panel h2.title').textContent(), 'Song 36c');
		} finally {
			subsonic.state.albumSongs = 2;
			await page.close();
		}
		assert.deepEqual(problems, []);
	});
});

describe('the libraries an account browses', () => {
	// Issue #365.
	test('one switch a library under Account, saved as switched, and the last one left on stays on', async () => {
		const { page, problems } = await watchedPage();
		const settings = () => context.request.patch(`${app.url}/api/settings`, { data: { libraries: [] }, headers: { origin: app.url } });
		subsonic.state.musicFolders = [
			{ id: 1, name: 'Music' },
			{ id: 2, name: 'Audiobooks' }
		];
		try {
			await page.goto(app.url + '/settings?tab=account', { waitUntil: 'networkidle' });
			const card = page.locator('#libraries');
			await card.waitFor();
			const music = card.getByRole('switch', { name: 'Music' });
			const books = card.getByRole('switch', { name: 'Audiobooks' });
			assert.equal(await music.getAttribute('aria-checked'), 'true');
			assert.equal(await books.getAttribute('aria-checked'), 'true');

			const saved = page.waitForResponse((response) => response.url().endsWith('/api/settings') && response.request().method() === 'PATCH');
			await books.click();
			assert.deepEqual((await (await saved).json()).libraries, ['1']);
			assert.equal(await books.getAttribute('aria-checked'), 'false');
			// Music is the one left: it cannot be switched off.
			assert.equal(await music.isDisabled(), true);

			await page.reload({ waitUntil: 'networkidle' });
			assert.equal(await card.getByRole('switch', { name: 'Audiobooks' }).getAttribute('aria-checked'), 'false', 'the choice was not kept');
		} finally {
			await settings();
			subsonic.state.musicFolders = [{ id: 1, name: 'Music' }];
			await page.close();
		}
		assert.deepEqual(problems, []);

		// One library: no choice to make.
		const { page: one } = await watchedPage();
		try {
			await one.goto(app.url + '/settings?tab=account', { waitUntil: 'networkidle' });
			assert.equal(await one.locator('#libraries').count(), 0);
		} finally {
			await one.close();
		}
	});
});

describe('the settings tabs', () => {
	test('are a list down the side on a wide page and a row across a phone', async () => {
		for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
			const wide = viewport.width > 1000;
			const visit = await browser.newContext({ viewport, isMobile: !wide, hasTouch: !wide });
			const signIn = await visit.request.post(`${app.url}/login`, {
				form: { username: 'testuser', password: 'testpass', backend: 'subsonic', next: '/' },
				headers: { origin: app.url, accept: 'text/html' },
				maxRedirects: 0
			});
			assert.equal(signIn.status(), 303);
			const page = await visit.newPage();
			try {
				await page.goto(app.url + '/settings?tab=security', { waitUntil: 'networkidle' });
				const seen = await page.evaluate(() => {
					const tabs = [...document.querySelectorAll('nav.tabs .tab')].map((tab) => tab.getBoundingClientRect());
					const row = document.querySelector('nav.tabs');
					const shown = (selector) => [...document.querySelectorAll(selector)].filter((node) => node.getBoundingClientRect().width > 0).map((node) => node.textContent.trim());
					return {
						stacked: tabs.every((rect, index) => index === 0 || rect.top >= tabs[index - 1].bottom),
						clipped: row.scrollWidth - row.clientWidth,
						subs: shown('nav.tabs .sub'),
						chips: shown('nav.chips .chip')
					};
				});
				const at = `at ${viewport.width}px`;
				assert.equal(seen.stacked, wide, `${at}: the tabs stacked`);
				// All five across a phone, Server not scrolled off the edge.
				assert.equal(seen.clipped, 0, `${at}: the tab row scrolls`);
				assert.deepEqual(seen.subs, wide ? ['Account', 'Security', 'History'] : [], at);
				assert.deepEqual(seen.chips, wide ? [] : ['Account', 'Security', 'History'], at);
			} finally {
				await visit.close();
			}
		}
	});

	test('show one group at a time, switch without reloading, and save the fields on other tabs', async () => {
		await context.request.patch(`${app.url}/api/settings`, {
			headers: { origin: app.url },
			data: { theme: 'dark', transcode: true, transcodeBitrateKbps: 256 }
		});
		const { page, problems } = await watchedPage();
		try {
			await page.goto(app.url + '/settings', { waitUntil: 'networkidle' });
			const tabs = page.getByRole('navigation', { name: 'Settings' });
			const heading = (name) => page.getByRole('heading', { name, exact: true });
			assert.equal(await tabs.getByRole('link', { name: 'Look', exact: true }).getAttribute('aria-current'), 'page');
			assert.ok(await heading('Appearance').isVisible());
			for (const name of ['Playback', 'Transcoding', 'Session & security', 'Cover cache']) {
				assert.equal(await heading(name).isVisible(), false, `${name} shows on the Appearance tab`);
			}

			// A switch reads nothing from the server.
			let fetched = 0;
			page.on('request', (request) => {
				// The page or its data, not the PATCH that marks features seen when
				// the Server tab opens on one an administrator has not looked at.
				if (new URL(request.url()).pathname.startsWith('/settings') && request.resourceType() !== 'image') {
					fetched++;
				}
			});
			await tabs.getByRole('link', { name: 'Server' }).click();
			await heading('Cover cache').waitFor();
			assert.equal(await heading('Appearance').isVisible(), false);
			assert.match(page.url(), /\/settings\?tab=storage$/);
			assert.equal(fetched, 0, 'the tab switch asked the server for the page');

			// Saving from Appearance keeps what the Playback tab holds.
			await tabs.getByRole('link', { name: 'Look', exact: true }).click();
			await autosaved(page, () => pick(select(page, 'theme'), 'light'));
			await page.getByText('Settings saved.').waitFor();
			const saved = await (await context.request.get(`${app.url}/api/settings`)).json();
			assert.equal(saved.theme, 'light');
			assert.equal(saved.transcode, true);
			assert.equal(saved.transcodeBitrateKbps, 256);

			// A link to a tab opens on it.
			await page.goto(app.url + '/settings?tab=account', { waitUntil: 'networkidle' });
			assert.ok(await heading('Session & security').isVisible());
			assert.equal(await page.locator('form[action="?/save"]').isVisible(), false);
		} finally {
			await context.request.patch(`${app.url}/api/settings`, {
				headers: { origin: app.url },
				data: { theme: 'dark', transcode: false, transcodeBitrateKbps: 192 }
			});
			await page.close();
		}
		assert.deepEqual(problems, []);
	});
});

describe('the Last.fm notice', () => {
	test('is looked up by its own keys only', async () => {
		const { page, problems } = await watchedPage();
		try {
			for (const key of ['constructor', 'toString', '__proto__']) {
				await page.goto(`${app.url}/settings?lastfm=${key}`, { waitUntil: 'networkidle' });
				await page.locator('#scrobbling').waitFor();
				const text = await page.locator('#scrobbling').innerText();
				assert.ok(!text.includes('native code') && !text.includes('[object Object]'), key);
			}
			await page.goto(`${app.url}/settings?lastfm=linked`, { waitUntil: 'networkidle' });
			await page.getByText('Last.fm is linked.').waitFor();
		} finally {
			await page.close();
		}
		assert.deepEqual(problems, []);
	});
});

describe('On this day', () => {
	/*
	 * In a time zone 14 hours ahead of UTC, where the local date and the UTC
	 * date differ for 14 hours of every day. A play at 00:30 on this local
	 * date a year ago was on the day before in UTC, and one at 23:30 on the
	 * local day before was on that day in UTC too; only the first is shown.
	 */
	test('shows the albums played on this date in earlier years, by the browser\'s date', async () => {
		const ahead = await browser.newContext({ viewport: { width: 1440, height: 900 }, timezoneId: 'Pacific/Kiritimati' });
		const HOUR_MS = 60 * 60 * 1000;
		const local = new Date(Date.now() + 14 * HOUR_MS);
		const lastYear = (days, hours, minutes) =>
			new Date(
				Date.UTC(local.getUTCFullYear() - 1, local.getUTCMonth(), local.getUTCDate() + days, hours, minutes) - 14 * HOUR_MS
			).toISOString();
		subsonic.state.played.set('s1a', lastYear(0, 0, 30));
		subsonic.state.played.set('s2a', lastYear(-1, 23, 30));
		const action = (name) =>
			ahead.request.post(`${app.url}/settings?/${name}`, {
				headers: { origin: app.url, accept: 'application/json', 'x-sveltekit-action': 'true', 'content-type': 'application/x-www-form-urlencoded' },
				data: ''
			});
		try {
			const signIn = await ahead.request.post(`${app.url}/login`, {
				form: { username: 'testuser', password: 'testpass', backend: 'subsonic', next: '/' },
				headers: { origin: app.url, accept: 'text/html' },
				maxRedirects: 0
			});
			assert.equal(signIn.status(), 303);
			assert.equal((await action('importHistory')).status(), 200);
			const page = await ahead.newPage();
			await page.goto(app.url + '/', { waitUntil: 'networkidle' });
			const shelf = page.locator('section.shelf', { has: page.getByRole('heading', { name: 'On this day' }) });
			await shelf.waitFor();
			const albums = await shelf.locator('a[href^="/albums/"]').evaluateAll((links) => [...new Set(links.map((a) => a.getAttribute('href')))]);
			assert.deepEqual(albums, ['/albums/al1']);
			const text = await shelf.innerText();
			assert.match(text, new RegExp(`${local.getUTCFullYear() - 1}\\s+A year ago`, 'i'), 'the year is not marked');
			assert.equal(await shelf.locator('time').getAttribute('datetime'), local.toISOString().slice(0, 10), 'the calendar leaf is not the browser\'s date');
		} finally {
			subsonic.state.played.clear();
			await action('clearHistory');
			await ahead.close();
		}
	});
});

describe('Paper, the light theme', () => {
	/*
	 * Parchment under ink, and with nothing playing the accent in the rust:
	 * the neutral tint's hue mixed with the rust at a flat 30 percent came out
	 * a plum grey (oklab a 0.025, b 0.016), with neither channel warm enough.
	 */
	test('is parchment, and its accent with nothing playing is the rust', async () => {
		const paper = await browser.newContext({ viewport: { width: 1440, height: 900 } });
		try {
			const signIn = await paper.request.post(`${app.url}/login`, {
				form: { username: 'testuser', password: 'testpass', backend: 'subsonic', next: '/' },
				headers: { origin: app.url, accept: 'text/html' },
				maxRedirects: 0
			});
			assert.equal(signIn.status(), 303);
			await paper.request.patch(`${app.url}/api/settings`, { data: { theme: 'light' }, headers: { origin: app.url } });
			const page = await paper.newPage();
			await page.goto(app.url + '/settings', { waitUntil: 'networkidle' });
			const { ground, accent } = await page.evaluate(() => {
				const probe = document.createElement('div');
				probe.style.color = 'var(--accent)';
				document.body.append(probe);
				const accent = getComputedStyle(probe).color;
				probe.remove();
				return { ground: getComputedStyle(document.documentElement).getPropertyValue('--bg-base').trim(), accent };
			});
			assert.equal(ground, '#f0e7d5');
			const [, a, b] = /oklab\(\s*[\d.]+\s+(-?[\d.]+)\s+(-?[\d.]+)/.exec(accent)?.map(Number) ?? [];
			assert.ok(a > 0.06 && b > 0.04, `the accent is not the rust: ${accent}`);
			assert.equal(new Map(await optionsOf(select(page, 'theme'))).get('light'), 'Paper');
		} finally {
			await paper.request.patch(`${app.url}/api/settings`, { data: { theme: 'dark' }, headers: { origin: app.url } });
			await paper.close();
		}
	});
});

describe("the themes' own colours", () => {
	/*
	 * #182: Liquid's and Paper's colours come from two theme files through
	 * the head of the page, and no longer from `app.css`. Read as drawn, they
	 * are the values the stylesheet held. Terminal and Phosphor keep their own
	 * over them, and a change of theme under Settings needs no new page.
	 */
	test('Liquid and Paper are drawn in the colours of their files, signed out and in, and across a change of theme', async () => {
		const TOKENS = ['bg-base', 'bg-sunken', 'bg-surface', 'bg-raised', 'bg-hover', 'bg-active', 'text-strong', 'text-default', 'text-muted', 'text-faint', 'text-muted-through', 'text-faint-through', 'border-hairline', 'border-strong', 'positive', 'danger'];
		const LIQUID = ['#0b0c0f', '#07080a', '#111317', '#181a1f', '#202329', '#292c33', '#f7f8fa', '#e1e3e7', '#a2a6ae', '#767a84', '#b7b9bd', '#95979b', '#1f2227', '#30343c', '#7fc8a9', '#e0777f'];
		const PAPER = ['#f0e7d5', '#e6ddcc', '#f5eee1', '#faf5eb', '#eae1cf', '#e3d9c6', '#2e241a', '#453b30', '#594f43', '#6c6256', '#4f463b', '#62584c', '#d8cfbe', '#c0b6a6', '#4f6b3a', '#9c2b1b'];
		const view = await browser.newContext({ viewport: { width: 1280, height: 800 } });
		const settings = (patch) => view.request.patch(`${app.url}/api/settings`, { data: patch, headers: { origin: app.url } });
		try {
			const page = await view.newPage();
			const drawn = () =>
				page.evaluate((tokens) => {
					const root = getComputedStyle(document.documentElement);
					return tokens.map((token) => root.getPropertyValue(`--${token}`).trim());
				}, TOKENS);
			// What is painted, and not only what is declared.
			const ground = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);

			await page.goto(`${app.url}/login`, { waitUntil: 'networkidle' });
			assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
			assert.deepEqual(await drawn(), LIQUID, 'signed out');
			assert.equal(await ground(), 'rgb(11, 12, 15)');

			const signIn = await view.request.post(`${app.url}/login`, {
				form: { username: 'testuser', password: 'testpass', backend: 'subsonic', next: '/' },
				headers: { origin: app.url, accept: 'text/html' },
				maxRedirects: 0
			});
			assert.equal(signIn.status(), 303);
			await settings({ theme: 'dark', scheme: 'heddohon' });
			await page.goto(`${app.url}/settings`, { waitUntil: 'networkidle' });
			assert.deepEqual(await drawn(), LIQUID, 'signed in');

			// Paper chosen and saved: the page in front of the reader takes it.
			await autosaved(page, () => pick(select(page, 'theme'), 'light'));
			await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
			assert.deepEqual(await drawn(), PAPER, 'changed without a new page');
			await page.reload({ waitUntil: 'networkidle' });
			assert.deepEqual(await drawn(), PAPER, 'on a new page');
			assert.equal(await ground(), 'rgb(240, 231, 213)');

			// The other two set every one of them, over the root's.
			for (const [theme, base, faint] of [
				['terminal', '#08090a', '#7c828a'],
				['phosphor', '#0a0b0c', '#80868e']
			]) {
				await settings({ theme });
				await page.reload({ waitUntil: 'networkidle' });
				const found = await drawn();
				assert.deepEqual([found[0], found[9]], [base, faint], theme);
				assert.ok(found.every((value, at) => value && value !== LIQUID[at]), `${theme} shows through to Liquid: ${found}`);
			}
			await page.close();
		} finally {
			await settings({ theme: 'dark', scheme: 'heddohon' });
			await view.close();
		}
	});
});
