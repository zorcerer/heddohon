/**
 * The tint, resuming a transcode, page headings, instant mix, album links, playlists, waiting for a page, and playing across page changes.
 *
 *   npm run build
 *   node --test tests/browser/pages.test.mjs
 *
 * Runs the built app against the mock servers of `tests/e2e`; see `suite.mjs`.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { silentWav } from '../e2e/mocks.mjs';
import { subsonic, app, browser, context, pickLabel, optionsOf, shown, watchedPage, playable, setUpSuite } from './suite.mjs';

setUpSuite();

describe('the tint on the rail and the player', () => {
	/*
	 * Each surface cross-fades two washes. When the one on screen was hidden
	 * and the other shown in the same frame, a GPU that drew the second a frame
	 * late showed neither: a dark flash on every colour change. Headless
	 * Chromium draws in step, so this checks that no layer jumps between
	 * frames.
	 */
	test('a colour change fades both layers, without a jump', async () => {
		subsonic.state.coverColors.set('al-21', [200, 40, 40]);
		subsonic.state.coverColors.set('al-22', [40, 60, 210]);
		const { page, problems } = await watchedPage();
		try {
			await page.goto(app.url + '/albums/al21', { waitUntil: 'networkidle' });
			// The first change, from the idle colour to the first cover.
			await page.waitForTimeout(1500);

			await page.evaluate(() => {
				const rail = document.querySelector('nav.rail');
				const frames = [];
				window.__tintFrames = frames;
				// The frame's own time, which the transition is sampled at.
				// `performance.now()` in the callback runs late behind a busy frame:
				// a 0.60 step between two callbacks 30ms apart on that clock was
				// 450ms of transition on this one (CI run 36150657301).
				const sample = (time) => {
					frames.push([
						Number(getComputedStyle(rail, '::before').opacity),
						Number(getComputedStyle(rail, '::after').opacity),
						time
					]);
					if (frames.length < 120) requestAnimationFrame(sample);
				};
				requestAnimationFrame(sample);
				const link = document.createElement('a');
				link.href = '/albums/al22';
				document.body.append(link);
				setTimeout(() => link.click(), 100);
			});
			await page.waitForFunction(() => window.__tintFrames.length >= 120, null, { timeout: 10_000 });
			const frames = await page.evaluate(() => window.__tintFrames);

			// Only between frames under 50ms apart, by frame time. A CI runner
			// drops frames, and a 900ms fade covers 0.66 across one gap of a few
			// hundred milliseconds (seen once). The reset moved 1.0 in a 16ms frame.
			let jump = 0;
			for (let i = 1; i < frames.length; i++) {
				if (frames[i][2] - frames[i - 1][2] > 50) continue;
				for (const layer of [0, 1]) jump = Math.max(jump, Math.abs(frames[i][layer] - frames[i - 1][layer]));
			}
			// Under 0.9 rather than 0.5: a CI runner stepped 0.52 and 0.60 between
			// frames of an ordinary fade even timed by frame (runs 36150657301 and
			// 36153186069). The reset moved a full 1.0, which this still catches.
			assert.ok(jump < 0.9, `a layer moved ${jump.toFixed(2)} in one frame`);
			assert.ok(
				frames.some(([was]) => was > 0.05 && was < 0.95),
				'no frame between the two colours: no fade ran'
			);
			const last = frames.at(-1);
			assert.ok(last.includes(1) && last.includes(0), `the fade did not finish: ${last}`);
		} finally {
			subsonic.state.coverColors.clear();
			await page.close();
		}
		assert.deepEqual(problems, []);
	});
});

describe('the tint under the player', () => {
	/*
	 * The two washes were at `z-index: 0`, among the panel's contents in
	 * document order, and the second comes after all of them: whenever it was
	 * the wash on screen, it lay over the cover.
	 */
	test('neither wash is painted over the cover', async () => {
		subsonic.state.audio = { type: 'audio/wav', body: silentWav(30) };
		subsonic.state.coverColors.set('al-1', [60, 60, 60]);
		const { page, problems } = await watchedPage();
		try {
			await page.goto(app.url + '/albums/al1', { waitUntil: 'networkidle' });
			await page.getByRole('button', { name: 'Play Song 1a', exact: true }).click();
			await page.waitForFunction(() => document.querySelector('aside.panel .art img.current:not(.pending)')?.complete);
			await page.waitForTimeout(1200);
			const art = await page.evaluate(() => {
				const r = document.querySelector('aside.panel .art').getBoundingClientRect();
				return { x: r.x + r.width * 0.25, y: r.y + r.height * 0.1, width: r.width * 0.5, height: r.height * 0.2 };
			});

			const seen = [];
			for (const mix of ['0', '1']) {
				// Both washes pure red, with no fade, so only the order they are
				// painted in can make a difference.
				await page.evaluate((mix) => {
					const panel = document.querySelector('aside.panel');
					panel.style.setProperty('--tint-morph-ms', '0ms');
					for (const layer of ['a', 'b']) {
						panel.style.setProperty(`--tint-${layer}-h`, '0');
						panel.style.setProperty(`--tint-${layer}-s`, '100%');
						panel.style.setProperty(`--tint-${layer}-l`, '50%');
					}
					panel.style.setProperty('--tint-mix', mix);
				}, mix);
				await page.waitForTimeout(200);
				const png = (await page.screenshot({ clip: art })).toString('base64');
				// Decoded on a blank page: the app's own policy refuses a `data:` image.
				const blank = await context.newPage();
				seen.push(
					await blank.evaluate(async (png) => {
						const image = new Image();
						image.src = `data:image/png;base64,${png}`;
						await image.decode();
						const draw = document.createElement('canvas');
						draw.width = image.width;
						draw.height = image.height;
						const context = draw.getContext('2d');
						context.drawImage(image, 0, 0);
						const data = context.getImageData(0, 0, image.width, image.height).data;
						const sum = [0, 0, 0];
						for (let i = 0; i < data.length; i += 4) for (let c = 0; c < 3; c++) sum[c] += data[i + c];
						return sum.map((value) => Math.round(value / (data.length / 4)));
					}, png)
				);
				await blank.close();
			}
			const [under, over] = seen;
			for (let c = 0; c < 3; c++) {
				assert.ok(Math.abs(under[c] - over[c]) <= 2, `the cover is ${under} with the first wash and ${over} with the second`);
			}
		} finally {
			subsonic.state.audio = null;
			subsonic.state.coverColors.clear();
			await page.close();
		}
		assert.deepEqual(problems, []);
	});
});

describe('the tint through changes that come close together', () => {
	/** Samples each tint layer of the rail on every frame until `stop()`. */
	async function sampleLayers(page) {
		await page.evaluate(() => {
			const rail = document.querySelector('nav.rail');
			const frames = (window.__layers = []);
			window.__sampling = true;
			const sample = () => {
				frames.push(
					['::before', '::after'].map((pseudo) => {
						const style = getComputedStyle(rail, pseudo);
						return [style.backgroundColor, Number(style.opacity)];
					})
				);
				if (window.__sampling) requestAnimationFrame(sample);
			};
			requestAnimationFrame(sample);
		});
		return async () => {
			await page.evaluate(() => (window.__sampling = false));
			return page.evaluate(() => window.__layers);
		};
	}

	/** Frames where a layer that was visible in both changed colour. */
	function repaintsWhileVisible(frames) {
		const found = [];
		for (let i = 1; i < frames.length; i++) {
			for (const layer of [0, 1]) {
				const [was, wasOpacity] = frames[i - 1][layer];
				const [now, nowOpacity] = frames[i][layer];
				if (was !== now && wasOpacity > 0.02 && nowOpacity > 0.02) found.push(`frame ${i}: ${was} -> ${now}`);
			}
		}
		return found;
	}

	const navigate = (page, href) =>
		page.evaluate((to) => {
			const link = document.createElement('a');
			link.href = to;
			document.body.append(link);
			link.click();
		}, href);

	test('a track change on an album page changes the tint once', async () => {
		subsonic.state.coverColors.set('al-23', [200, 40, 40]);
		subsonic.state.coverColors.set('al-24', [40, 60, 210]);
		subsonic.state.coverColors.set('al-25', [40, 190, 60]);
		subsonic.state.audio = { type: 'audio/wav', body: silentWav(8) };
		const { page, problems } = await watchedPage();
		try {
			// Albums no other test opens. A cover fetched before its colour was set
			// is held in the server's cover cache and the browser's, as the 1px PNG.
			// The queue is album 23's last track, then album 24, and the page open
			// at the change is album 25. The tracks are 8s long, so the change
			// comes after the observer below is watching.
			await page.goto(app.url + '/albums/al23', { waitUntil: 'networkidle' });
			await page.getByRole('button', { name: 'Play Song 23b', exact: true }).click();
			await page.waitForFunction(() =>
				[...document.querySelectorAll('audio')].some((a) => !a.paused && a.currentTime > 0)
			);
			await navigate(page, '/albums/al24');
			// The URL changes before the page does, so a click on the URL alone
			// sometimes queued album 23 again.
			await page.getByRole('heading', { name: 'Album 24', exact: true }).waitFor();
			await page.getByRole('button', { name: 'Add to queue', exact: true }).first().click();
			await navigate(page, '/albums/al25');
			await page.waitForURL(/\/albums\/al25$/);
			await page.waitForTimeout(1200);

			const changes = await page.evaluate(() => {
				const rail = document.querySelector('nav.rail');
				const seen = (window.__mixes = []);
				new MutationObserver(() => seen.push(rail.style.getPropertyValue('--tint-mix'))).observe(rail, {
					attributes: true,
					attributeFilter: ['style']
				});
				return true;
			});
			assert.ok(changes);
			const stop = await sampleLayers(page);
			await page.waitForFunction(() => document.querySelector('aside.panel h2.title')?.textContent === 'Song 24a', null, {
				timeout: 12000
			});
			await page.waitForTimeout(1200);
			const frames = await stop();
			const mixes = await page.evaluate(() => window.__mixes);

			assert.equal(new Set(mixes).size, 1, `the tint changed ${mixes.length} times: ${mixes}`);
			assert.deepEqual(repaintsWhileVisible(frames), []);
		} finally {
			subsonic.state.audio = null;
			subsonic.state.coverColors.clear();
			await page.close();
		}
		assert.deepEqual(problems, []);
	});

	test('a second colour during a fade waits instead of repainting a visible layer', async () => {
		subsonic.state.coverColors.set('al-31', [200, 40, 40]);
		subsonic.state.coverColors.set('al-32', [40, 60, 210]);
		subsonic.state.coverColors.set('al-33', [40, 190, 60]);
		const { page, problems } = await watchedPage();
		/*
		 * The fade to the second album is held halfway, both layers on screen,
		 * for longer than the 900ms it is meant to take. That is a busy machine
		 * made certain: the transition starts late and the clock runs out first.
		 * Timed by the clock alone, the third colour was written into a visible
		 * layer then, and this check lost about one full run in four (#262).
		 */
		const tint = (call) =>
			page.evaluate((call) => {
				const running = [...document.querySelectorAll('.hh-tint-morph')].flatMap((surface) =>
					surface.getAnimations().filter((animation) => animation.transitionProperty === '--tint-mix')
				);
				for (const transition of running) {
					if (call === 'hold') {
						transition.pause();
						transition.currentTime = 450;
					} else transition.play();
				}
				return running.length;
			}, call);
		try {
			await page.goto(app.url + '/albums/al31', { waitUntil: 'networkidle' });
			await page.waitForTimeout(1200);

			const stop = await sampleLayers(page);
			await navigate(page, '/albums/al32');
			await page.waitForURL(/\/albums\/al32$/);
			await page.waitForFunction(() =>
				[...document.querySelectorAll('.hh-tint-morph')].some((surface) =>
					surface.getAnimations().some((animation) => animation.transitionProperty === '--tint-mix')
				)
			);
			assert.ok((await tint('hold')) > 0, 'no fade to hold');
			await navigate(page, '/albums/al33');
			await page.waitForURL(/\/albums\/al33$/);
			// Past the clock's end of the fade, with the fade still halfway.
			await page.waitForTimeout(1500);
			await tint('play');
			await page
				.waitForFunction(
					() => {
						const last = window.__layers?.at(-1);
						if (!last) return false;
						const front = last[0][1] > 0.5 ? last[0][0] : last[1][0];
						const [r, g, b] = front.match(/[\d.]+/g).map(Number);
						return g > r && g > b;
					},
					null,
					{ timeout: 10_000 }
				)
				.catch(() => undefined);
			await page.waitForTimeout(1000);
			const frames = await stop();

			assert.deepEqual(repaintsWhileVisible(frames), []);
			const last = frames.at(-1);
			const front = last[0][1] > 0.5 ? last[0][0] : last[1][0];
			const [r, g, b] = front.match(/[\d.]+/g).map(Number);
			assert.ok(g > r && g > b, `the rail did not end on the last album's green: ${front}`);
		} finally {
			subsonic.state.coverColors.clear();
			await page.close();
		}
		assert.deepEqual(problems, []);
	});
});

describe('resuming a transcode', () => {
	/*
	 * A transcode arrives as a stream without ranges until the server has read
	 * it whole, and a seek into that lands nowhere: resuming at a position
	 * played the song from the start. The player waits for the position.
	 */
	test('a restored queue picks up at its saved position', async () => {
		const origin = { origin: app.url, 'content-type': 'application/json' };
		await context.request.patch(`${app.url}/api/settings`, { headers: origin, data: { transcode: true } });
		subsonic.state.audio = { type: 'audio/wav', body: silentWav(60) };
		await context.request.put(`${app.url}/api/play-state`, {
			headers: origin,
			data: { songIds: ['s5a', 's5b'], index: 0, position: 25, repeat: 'off', shuffle: false }
		});
		const { page, problems } = await watchedPage();
		try {
			await page.goto(app.url + '/albums', { waitUntil: 'networkidle' });
			await page.waitForFunction(() => document.querySelector('aside.panel h2.title')?.textContent === 'Song 5a');
			// The position restored, before anything plays. A page closed by the
			// test before this one saves its queue on the way out, and a slow runner
			// once delivered that after the state above was written. Checked here,
			// such a run fails as a restore and not as a seek.
			await page.waitForFunction(
				() => document.querySelector('aside.panel .times .hh-numeric')?.textContent === '0:25',
				null,
				{ timeout: 5000 }
			);
			await page.locator('aside.panel button.play').click();
			// The track, not the second element: at the first press of Play it
			// plays a muted `/silence.wav` once, to be allowed to play later. On a
			// slow runner that was under way before the track, and was read as
			// playback from 0.0s (dev, 2026-10-08).
			await page.waitForFunction(
				() => [...document.querySelectorAll('audio')].some((a) => !a.paused && a.currentTime > 0 && a.currentSrc.includes('/api/stream/')),
				null,
				{ timeout: 15_000 }
			);
			const at = await page.evaluate(() =>
				Math.max(...[...document.querySelectorAll('audio')].filter((a) => !a.paused && a.currentSrc.includes('/api/stream/')).map((a) => a.currentTime))
			);
			assert.ok(at >= 24, `playback started at ${at.toFixed(1)}s instead of 25s`);
		} finally {
			subsonic.state.audio = null;
			await context.request.patch(`${app.url}/api/settings`, { headers: origin, data: { transcode: false } });
			await context.request.put(`${app.url}/api/play-state`, {
				headers: origin,
				data: { songIds: [], index: 0, position: 0, repeat: 'off', shuffle: false }
			});
			await page.close();
		}
		assert.deepEqual(problems, []);
	});

	/*
	 * The server no longer holding the transcode (15 minutes after it was last
	 * asked for) is the case that began as a stream. Chromium takes a position
	 * up in one, and Firefox and WebKit played from the start. So the track is
	 * asked for whole, and the element is never given the stream.
	 */
	test('a restored queue asks for the transcode whole, and waits at its saved position', async () => {
		const origin = { origin: app.url, 'content-type': 'application/json' };
		await context.request.patch(`${app.url}/api/settings`, { headers: origin, data: { transcode: true } });
		subsonic.state.audio = { type: 'audio/wav', body: silentWav(60) };
		subsonic.state.ignoreRange = true;
		subsonic.state.streamSlowMs = 2000;
		await context.request.put(`${app.url}/api/play-state`, {
			headers: origin,
			data: { songIds: ['s8a', 's8b'], index: 0, position: 25, repeat: 'off', shuffle: false }
		});
		const { page, problems } = await watchedPage();
		try {
			const streams = [];
			page.on('response', (response) => {
				const url = new URL(response.url());
				if (response.request().method() !== 'GET' || url.pathname !== '/api/stream/s8a') return;
				streams.push({ whole: url.searchParams.has('whole'), ranges: response.headers()['accept-ranges'] ?? null });
			});
			await page.goto(app.url + '/albums', { waitUntil: 'networkidle' });
			const shown = () => page.locator('aside.panel .times .hh-numeric').first().textContent();
			await page.waitForFunction(
				() => document.querySelector('aside.panel .times .hh-numeric')?.textContent === '0:25',
				null,
				{ timeout: 5000 }
			);
			await page.locator('aside.panel button.play').click();
			// The read is a second from done: nothing plays, and the bar has not gone to 0:00.
			await page.waitForTimeout(1000);
			assert.equal(await shown(), '0:25');
			assert.equal(await page.evaluate(() => [...document.querySelectorAll('audio')].some((a) => a.currentTime > 0)), false);

			await page.waitForFunction(
				() => [...document.querySelectorAll('audio')].some((a) => !a.paused && a.currentTime > 0 && a.currentSrc.includes('/api/stream/')),
				null,
				{ timeout: 15_000 }
			);
			const at = await page.evaluate(() =>
				Math.max(...[...document.querySelectorAll('audio')].filter((a) => !a.paused && a.currentSrc.includes('/api/stream/')).map((a) => a.currentTime))
			);
			assert.ok(at >= 24, `playback started at ${at.toFixed(1)}s instead of 25s`);
			assert.ok(streams.length > 0);
			assert.deepEqual(streams.filter((s) => !s.whole || s.ranges !== 'bytes'), [], 'the element was given a stream without ranges');
		} finally {
			subsonic.state.audio = null;
			subsonic.state.ignoreRange = false;
			subsonic.state.streamSlowMs = 0;
			await context.request.patch(`${app.url}/api/settings`, { headers: origin, data: { transcode: false } });
			await context.request.put(`${app.url}/api/play-state`, {
				headers: origin,
				data: { songIds: [], index: 0, position: 0, repeat: 'off', shuffle: false }
			});
			await page.close();
		}
		assert.deepEqual(problems, []);
	});

	/*
	 * Firefox reports nothing seekable in a stream without ranges for as long
	 * as the element holds it, and ignores a position set on it. Chromium seeks
	 * in one by waiting for the bytes, so this test gives its elements
	 * Firefox's answers until the page has learnt from the server that the
	 * transcode is whole.
	 */
	test('a seek in a transcode that began as a stream is made once the server has it whole', async () => {
		const origin = { origin: app.url, 'content-type': 'application/json' };
		await context.request.patch(`${app.url}/api/settings`, { headers: origin, data: { transcode: true } });
		subsonic.state.audio = { type: 'audio/wav', body: silentWav(180) };
		subsonic.state.ignoreRange = true;
		// The server's read of the transcode takes this long, and the seek is made inside it.
		subsonic.state.streamSlowMs = 3000;
		const { page, problems } = await watchedPage();
		try {
			await page.addInitScript(() => {
				let whole = false;
				const seekable = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'seekable');
				const time = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime');
				const none = { length: 0, start: () => 0, end: () => 0 };
				Object.defineProperty(HTMLMediaElement.prototype, 'seekable', {
					get() {
						return whole ? seekable.get.call(this) : none;
					}
				});
				Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', {
					get() {
						return time.get.call(this);
					},
					set(value) {
						if (whole) time.set.call(this, value);
					}
				});
				const fetched = window.fetch;
				window.__heads = 0;
				window.fetch = async (...args) => {
					const response = await fetched(...args);
					if (args[1]?.method === 'HEAD') {
						window.__heads += 1;
						if (response.headers.get('accept-ranges') === 'bytes') whole = true;
					}
					return response;
				};
			});
			const streams = [];
			page.on('request', (request) => {
				if (request.method() === 'GET' && request.url().includes('/api/stream/')) streams.push(request.url());
			});
			await page.goto(app.url + '/albums/al6', { waitUntil: 'domcontentloaded' });
			await page.getByRole('button', { name: 'Play', exact: true }).first().click();
			const position = () =>
				page.evaluate(() => Math.max(0, ...[...document.querySelectorAll('audio')].filter((a) => !a.paused).map((a) => a.currentTime)));
			await page.waitForFunction(() => [...document.querySelectorAll('audio')].some((a) => !a.paused && a.currentTime > 0.3), null, { timeout: 15_000 });
			const before = streams.length;

			const bar = await page.locator('aside.panel [role=slider][aria-label="Seek within track"]').boundingBox();
			await page.mouse.click(bar.x + bar.width * 0.6, bar.y + bar.height / 2);
			// Not there yet, and the music has not stopped to wait for it.
			await page.waitForTimeout(700);
			const waiting = await position();
			assert.ok(waiting > 0.5 && waiting < 30, `at ${waiting.toFixed(1)}s while the transcode is being read`);

			// 60% of three minutes is 1:48.
			await page.waitForFunction(
				() => [...document.querySelectorAll('audio')].some((a) => !a.paused && a.currentTime >= 108),
				null,
				{ timeout: 15_000 }
			);
			const after = await position();
			assert.ok(after < 125, `landed at ${after.toFixed(1)}s`);
			assert.ok(streams.length > before, 'the track was not asked for again');
			assert.ok((await page.evaluate(() => window.__heads)) >= 1);
			assert.equal(await page.locator('aside.panel .times .hh-numeric').first().textContent(), `1:${String(Math.floor(after) - 60).padStart(2, '0')}`);
		} finally {
			subsonic.state.audio = null;
			subsonic.state.ignoreRange = false;
			subsonic.state.streamSlowMs = 0;
			await context.request.patch(`${app.url}/api/settings`, { headers: origin, data: { transcode: false } });
			await context.request.put(`${app.url}/api/play-state`, {
				headers: origin,
				data: { songIds: [], index: 0, position: 0, repeat: 'off', shuffle: false }
			});
			await page.close();
		}
		assert.deepEqual(problems, []);
	});
});

describe('the album heading', () => {
	test('sweeps in from the left after a navigation, not on the first paint', async () => {
		const { page, problems } = await watchedPage();
		const running = () =>
			page.evaluate(() =>
				[...document.querySelectorAll('.hero .details > *, .hero .details .actions > *')].filter(
					// The sweep is a Web Animation; a colour transition as the room's
					// tint settles is a CSSTransition and does not count.
					(el) => el.getAnimations().some((a) => !(a instanceof CSSTransition) && !(a instanceof CSSAnimation))
				).length
			);
		try {
			await page.goto(app.url + '/albums/al4', { waitUntil: 'networkidle' });
			assert.equal(await running(), 0, 'a server-rendered album page animated its heading');

			await page.goto(app.url + '/albums', { waitUntil: 'networkidle' });
			await page.evaluate(() => {
				window.__sweep = 0;
				const look = () => {
					if (location.pathname.startsWith('/albums/al')) {
						const moving = [...document.querySelectorAll('.hero .details > *')].filter(
							(el) => el.getAnimations().some((a) => !(a instanceof CSSTransition) && !(a instanceof CSSAnimation))
						);
						if (moving.length > 0) {
							window.__sweep = moving.length;
							window.__masked = getComputedStyle(moving[0]).maskImage || getComputedStyle(moving[0]).webkitMaskImage;
							return;
						}
					}
					requestAnimationFrame(look);
				};
				requestAnimationFrame(look);
			});
			await page.locator('a.card').nth(3).click({ position: { x: 20, y: 20 } });
			await page.waitForFunction(() => window.__sweep > 0, null, { timeout: 5000 });
			const { lines, masked } = await page.evaluate(() => ({ lines: window.__sweep, masked: window.__masked }));
			assert.ok(lines >= 3, `only ${lines} heading lines moved`);
			assert.match(masked, /linear-gradient/);
		} finally {
			await page.close();
		}
		assert.deepEqual(problems, []);
	});
});

describe('the artist and playlist headings', () => {
	for (const path of ['/artists/ar2', '/playlists/pl1']) {
		test(`sweep in from the left after a navigation: ${path}`, async () => {
			const { page, problems } = await watchedPage();
			try {
				await page.goto(app.url + '/albums', { waitUntil: 'networkidle' });
				await page.evaluate((target) => {
					window.__sweep = 0;
					const look = () => {
						if (location.pathname === target) {
							const moving = [...document.querySelectorAll('.hero .details > *, .hero .details .actions button')].filter(
								(el) => el.getAnimations().some((a) => !(a instanceof CSSTransition) && !(a instanceof CSSAnimation))
							);
							if (moving.length > 0) {
								window.__sweep = moving.length;
								return;
							}
						}
						requestAnimationFrame(look);
					};
					requestAnimationFrame(look);
					const link = document.createElement('a');
					link.href = target;
					document.body.append(link);
					link.click();
				}, path);
				await page.waitForFunction(() => window.__sweep > 0, null, { timeout: 5000 });
				assert.ok((await page.evaluate(() => window.__sweep)) >= 3);
			} finally {
				await page.close();
			}
			assert.deepEqual(problems, []);
		});
	}
});

describe('instant mix', () => {
	test('says when there is nothing similar, and otherwise plays the mix', async (t) => {
		playable(t);
		const { page, problems } = await watchedPage();
		try {
			await page.goto(app.url + '/albums/al18', { waitUntil: 'networkidle' });
			// By its class: its name is its label, which says what happened for four seconds.
			const button = page.locator('main button.mix');

			const title = () => page.evaluate(() => document.querySelector('aside.panel h2.title')?.textContent);
			// Whatever an earlier test left in the queue, restored on arrival.
			await page.waitForTimeout(500);
			const before = await title();

			subsonic.state.mixSize = 0;
			await button.click();
			await page.getByText('Nothing similar on your music server').waitFor({ timeout: 5000 });
			assert.equal(await title(), before, 'an empty mix changed the queue');

			subsonic.state.mixSize = 4;
			await button.click();
			await page.waitForFunction(() => document.querySelector('aside.panel h2.title')?.textContent === 'Song 19a');
		} finally {
			subsonic.state.mixSize = 0;
			await page.close();
		}
		assert.deepEqual(problems, []);
	});

	test('is at the head of the queue, from the playing track', async () => {
		subsonic.state.audio = { type: 'audio/wav', body: silentWav(30) };
		const { page, problems } = await watchedPage();
		try {
			await page.goto(app.url + '/albums/al2', { waitUntil: 'networkidle' });
			await page.getByRole('button', { name: 'Play Song 2a', exact: true }).click();
			await page.waitForFunction(() => document.querySelector('aside.panel h2.title')?.textContent === 'Song 2a');
			await page.locator('aside.panel button[aria-label="Queue"]').click();
			const mix = page.locator('aside.panel .queue-head button.mix');
			assert.equal(await mix.getAttribute('title'), 'Instant mix from the playing track');
			subsonic.state.mixSize = 4;
			await mix.click();
			// The mix starts with the track it is made from, and the queue is the mix.
			await page.waitForFunction(() => document.querySelector('aside.panel button[aria-label="Queue"] .count')?.textContent === '5', null, { timeout: 5000 });
			// Not among the track's details any more.
			await page.getByRole('button', { name: 'Track details' }).click();
			assert.equal(await page.locator('aside.panel .facts button.mix, aside.panel .details button.mix').count(), 0);
		} finally {
			subsonic.state.mixSize = 0;
			subsonic.state.audio = null;
			await page.close();
		}
		assert.deepEqual(problems, []);
	});
});

describe('an album link', () => {
	test('is made from the album page, and plays from any track on the shared page', async () => {
		subsonic.state.audio = { type: 'audio/wav', body: silentWav(30) };
		const { page, problems } = await watchedPage();
		const visitor = await browser.newContext({ viewport: { width: 1280, height: 900 } });
		try {
			// The device's share sheet, standing in: it records what it was handed.
			await page.addInitScript(() => {
				navigator.share = async (data) => void (window.__shared = data);
			});
			await page.goto(app.url + '/albums/al10', { waitUntil: 'networkidle' });
			await page.getByRole('button', { name: 'Share a link to this album' }).click();
			await page.getByRole('button', { name: 'Create link' }).waitFor();
			// The reminder about rights is one line of the small print, not a box of its own.
			const reminder = page.locator('dialog.share p', { hasText: 'Only share music you have the right to share.' });
			assert.equal((await reminder.innerText()).trim(), 'Only share music you have the right to share.');
			assert.deepEqual(
				await reminder.evaluate((p) => [p.className.includes('note'), getComputedStyle(p).borderTopWidth, getComputedStyle(p).backgroundColor]),
				[true, '0px', 'rgba(0, 0, 0, 0)']
			);
			await page.getByRole('button', { name: 'Create link' }).click();
			const url = await page.locator('dialog input.url').inputValue();
			assert.match(url, /\/share\/[A-Za-z0-9_-]{43}$/);
			await page.getByRole('button', { name: 'Share…' }).click();
			assert.deepEqual(await page.evaluate(() => window.__shared), { title: 'Album 10 · Artist 0010', url });

			const shared = await visitor.newPage();
			await shared.goto(url, { waitUntil: 'networkidle' });
			await shared.getByText('An album, shared with you.').waitFor();
			await shared.getByRole('list', { name: 'Tracks' }).getByRole('button', { name: /Song 10b/ }).click();
			await shared.waitForFunction(() => document.querySelector('.card h2.title')?.textContent === 'Song 10b');
			await shared.waitForFunction(() => {
				const audio = document.querySelector('.card audio');
				return audio && !audio.paused && audio.src.endsWith('/stream/1');
			});
		} finally {
			subsonic.state.audio = null;
			await visitor.close();
			await page.close();
		}
		assert.deepEqual(problems, []);
	});
});

describe('reordering a playlist', () => {
	const titles = (page) =>
		page.evaluate(() => [...document.querySelectorAll('main .track .title')].map((el) => el.textContent));

	test('a row is dragged to its new place by its handle', async () => {
		subsonic.state.playlistEntries = ['s1a', 's2a', 's3a'];
		const { page, problems } = await watchedPage();
		try {
			await page.goto(app.url + '/playlists/pl1', { waitUntil: 'networkidle' });
			assert.deepEqual(await titles(page), ['Song 1a', 'Song 2a', 'Song 3a']);

			const grip = page.locator('main .grip').first();
			const box = await grip.boundingBox();
			const rowHeight = await page.locator('main .tracks > li').first().evaluate((li) => li.offsetHeight);
			await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
			await page.mouse.down();
			for (let step = 1; step <= 10; step++) {
				await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + (rowHeight * 2 * step) / 10);
				await page.waitForTimeout(16);
			}
			// The move is saved by this request; network idle can come before it starts.
			const saved = page.waitForResponse((r) => r.request().method() === 'PATCH' && r.url().endsWith('/tracks'));
			await page.mouse.up();

			await page.waitForFunction(
				() => [...document.querySelectorAll('main .track .title')].map((el) => el.textContent).join() === 'Song 2a,Song 3a,Song 1a'
			);
			await saved;
			assert.deepEqual(subsonic.state.playlistEntries, ['s2a', 's3a', 's1a']);
		} finally {
			subsonic.state.playlistEntries = ['s1a', 's2a'];
			await page.close();
		}
		assert.deepEqual(problems, []);
	});

	test('a focused handle moves its row with the arrow keys, and keeps focus', async () => {
		subsonic.state.playlistEntries = ['s1a', 's2a', 's3a'];
		const { page, problems } = await watchedPage();
		try {
			await page.goto(app.url + '/playlists/pl1', { waitUntil: 'networkidle' });
			await page.locator('main .grip').first().focus();
			const saved = page.waitForResponse((r) => r.request().method() === 'PATCH' && r.url().endsWith('/tracks'));
			await page.keyboard.press('ArrowDown');
			await page.waitForFunction(
				() => [...document.querySelectorAll('main .track .title')].map((el) => el.textContent).join() === 'Song 2a,Song 1a,Song 3a'
			);
			await saved;
			assert.deepEqual(subsonic.state.playlistEntries, ['s2a', 's1a', 's3a']);
			// The handle has its focus back once the row is drawn in its new place,
			// which on a loaded CI runner came after the save's answer.
			await page
				.waitForFunction(() => /^Move Song 1a/.test(document.activeElement?.getAttribute('aria-label') ?? ''), null, { timeout: 5000 })
				.catch(() => {});
			const focused = await page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? '');
			assert.match(focused, /^Move Song 1a, number 2 of 3/);
			// Enter on a handle is the handle's: it does not start the row's song.
			await page.keyboard.press('Enter');
			await page.waitForTimeout(300);
			assert.notEqual(
				await page.evaluate(() => document.querySelector('aside.panel h2.title')?.textContent),
				'Song 1a'
			);
		} finally {
			subsonic.state.playlistEntries = ['s1a', 's2a'];
			await page.close();
		}
		assert.deepEqual(problems, []);
	});
});

describe('importing a playlist', () => {
	test('a file is read, its tracks looked for, what was found shown, and the playlist saved with what is kept', async () => {
		const { page, problems } = await watchedPage();
		try {
			await page.goto(app.url + '/playlists', { waitUntil: 'networkidle' });
			await page.getByRole('link', { name: 'Import', exact: true }).click();
			await page.waitForURL(app.url + '/playlists/import');
			const file =
				'#EXTM3U\n#PLAYLIST:Road trip\n' +
				'#EXTINF:180,Artist 0003 - Song 3a\n/music/a.flac\n' +
				'#EXTINF:181,Artist 0004 - Song 4b (Live)\n/music/b.flac\n' +
				'/music/Nobody/Nothing/01 - Nothing like it.flac\n';
			await page.locator('input[type=file]').setInputFiles({ name: 'road.m3u8', mimeType: 'audio/x-mpegurl', buffer: Buffer.from(file) });
			assert.equal(await page.getByLabel('Name', { exact: true }).inputValue(), 'Road trip');
			await page.getByRole('button', { name: 'Look for them in your library' }).click();
			const summary = page.locator('.summary');
			await summary.waitFor();
			assert.equal((await summary.textContent()).replace(/\s+/g, ' ').trim(), '1 found, 1 close, 1 not in your library.');

			await page.getByRole('checkbox', { name: 'Keep Song 4b' }).uncheck();
			await page.getByRole('button', { name: 'Save playlist (1 track)' }).waitFor();
			await page.getByRole('checkbox', { name: 'Keep Song 4b' }).check();

			// The mock makes no new playlists, so the one request is answered here.
			let sent = null;
			await page.route('**/api/playlists', async (route) => {
				if (route.request().method() !== 'POST') return route.fallback();
				sent = route.request().postDataJSON();
				await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ id: 'pl1', name: 'Road trip', added: 2 }) });
			});
			await page.getByRole('button', { name: 'Save playlist (2 tracks)' }).click();
			await page.waitForURL(app.url + '/playlists/pl1');
			assert.deepEqual(sent, { name: 'Road trip', songIds: ['s3a', 's4b'] });
		} finally {
			await page.close();
		}
		assert.deepEqual(problems, []);
	});

	test('a Spotify export with several playlists offers each, and a file with no tracks says so', async () => {
		const { page, problems } = await watchedPage();
		try {
			await page.goto(app.url + '/playlists/import', { waitUntil: 'networkidle' });
			const spotify = {
				playlists: [
					{ name: 'First', items: [{ track: { trackName: 'Song 1a', artistName: 'Artist 0001', albumName: 'Album 1' } }] },
					{ name: 'Second', items: [{ track: { trackName: 'Song 2a', artistName: 'Artist 0002' } }, { track: { trackName: 'Song 2b', artistName: 'Artist 0002' } }] }
				]
			};
			await page.locator('input[type=file]').setInputFiles({ name: 'Playlist1.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(spotify)) });
			const which = page.getByRole('combobox', { name: 'Playlist in the file' });
			assert.deepEqual((await optionsOf(which)).map(([, label]) => label), ['First (1)', 'Second (2)']);
			await pickLabel(which, 'Second (2)');
			assert.equal(await page.getByLabel('Name', { exact: true }).inputValue(), 'Second');
			await page.getByRole('button', { name: 'Look for them in your library' }).click();
			await page.locator('.summary').waitFor();
			assert.match(await page.locator('.summary').textContent(), /^2 found/);

			await page.locator('input[type=file]').setInputFiles({ name: 'empty.csv', mimeType: 'text/csv', buffer: Buffer.from('title,artist\n') });
			assert.equal(await page.getByRole('alert').textContent(), 'No tracks were found in the file.');
		} finally {
			await page.close();
		}
		assert.deepEqual(problems, []);
	});
});

describe('waiting for a page', () => {
	test('a slow page shows the press, a line and a softened page, and clears them when it lands', async () => {
		subsonic.state.delays.set('getAlbumList2', 1500);
		const { page, problems } = await watchedPage();
		try {
			await page.goto(app.url + '/settings', { waitUntil: 'networkidle' });
			const link = page.locator('nav.rail').getByRole('link', { name: 'Albums' });
			await link.click();
			await page.waitForTimeout(500);
			const during = await page.evaluate(() => {
				const box = (el) => {
					const r = el.getBoundingClientRect();
					return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
				};
				return {
					pending: document.querySelector('nav.rail a[href="/albums"]').classList.contains('hh-pending'),
					veil: document.querySelector('.wait-veil').classList.contains('waiting'),
					line: document.querySelector('.nav-progress').classList.contains('waiting'),
					veilBox: box(document.querySelector('.wait-veil')),
					rail: box(document.querySelector('nav.rail')),
					panel: box(document.querySelector('aside.panel')),
					path: location.pathname
				};
			});
			assert.equal(during.path, '/settings', 'the page changed before its data arrived');
			assert.ok(during.pending, 'the link pressed was not marked');
			assert.ok(during.veil, 'the page being left was not softened');
			assert.ok(during.line, 'there was no progress line');
			const overlaps = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
			assert.ok(!overlaps(during.veilBox, during.rail), 'the wait layer is behind the rail');
			assert.ok(!overlaps(during.veilBox, during.panel), 'the wait layer is behind the player');

			await page.waitForURL(/\/albums$/);
			await page.waitForTimeout(400);
			const after = await page.evaluate(() => ({
				pending: document.querySelectorAll('.hh-pending').length,
				veil: document.querySelector('.wait-veil').classList.contains('waiting'),
				line: document.querySelector('.nav-progress').classList.contains('waiting')
			}));
			assert.deepEqual(after, { pending: 0, veil: false, line: false });
		} finally {
			subsonic.state.delays.delete('getAlbumList2');
			await page.close();
		}
		assert.deepEqual(problems, []);
	});

	test('a fast page shows none of it', async () => {
		const { page, problems } = await watchedPage();
		try {
			await page.goto(app.url + '/settings', { waitUntil: 'networkidle' });
			await page.evaluate(() => {
				window.__waited = false;
				new MutationObserver(() => {
					if (document.querySelector('.wait-veil.waiting, .nav-progress.waiting')) window.__waited = true;
				}).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class'] });
			});
			await page.locator('nav.rail').getByRole('link', { name: 'Playlists' }).click();
			await page.waitForURL(/\/playlists$/);
			await page.waitForTimeout(300);
			assert.equal(await page.evaluate(() => window.__waited), false, 'a fast page showed the wait');
		} finally {
			await page.close();
		}
		assert.deepEqual(problems, []);
	});
});

describe('a shared album\'s transport', () => {
	test('puts play in the middle, with the track details behind the info button', async () => {
		const made = await (
			await context.request.post(`${app.url}/api/shares`, {
				data: { kind: 'album', id: 'al19', days: 1 },
				headers: { origin: app.url }
			})
		).json();
		const visitor = await browser.newContext({ viewport: { width: 1280, height: 900 } });
		try {
			const shared = await visitor.newPage();
			await shared.goto(app.url + made.path, { waitUntil: 'networkidle' });
			const layout = await shared.evaluate(() => {
				const row = document.querySelector('.card .transport');
				const buttons = [...row.querySelectorAll('button')];
				const centre = (el) => {
					const r = el.getBoundingClientRect();
					return r.left + r.width / 2;
				};
				return {
					labels: buttons.map((b) => b.getAttribute('aria-label')),
					offset: Math.abs(centre(row.querySelector('.play')) - centre(row))
				};
			});
			assert.deepEqual(layout.labels, ['Track details', 'Previous track', 'Play', 'Next track', 'Mute']);
			assert.ok(layout.offset < 2, `play is ${layout.offset}px off the middle`);

			await shared.getByRole('button', { name: 'Track details' }).click();
			await shared.waitForTimeout(500);
			const facts = await shared.locator('.card .fold.open dt').allTextContents();
			assert.deepEqual(facts, ['Format', 'Depth and rate', 'Bitrate', 'Album', 'Year', 'Track']);
		} finally {
			await visitor.close();
			await context.request.delete(`${app.url}/api/shares/${made.id}`, { headers: { origin: app.url } });
		}
	});
});

describe('playing across page changes', () => {
	/*
	 * Playback stopped on a page change for three causes so far. An effect in
	 * the layout that read what `player.attach` reads detached and re-attached
	 * the player on navigation: every attach restores the queue from
	 * `/api/play-state`, so a second request there is a re-attach. And
	 * SvelteKit turns a page change into a full page load, which tears down the
	 * audio, when the page's code is gone after an image update or its data
	 * request fails: a second `load` event is a full page load.
	 */
	async function playAndWatch(page) {
		const restores = [];
		page.on('request', (r) => {
			if (r.method() === 'GET' && new URL(r.url()).pathname === '/api/play-state') restores.push(r.url());
		});
		await page.goto(app.url + '/albums/al20', { waitUntil: 'networkidle' });
		const row = page.getByRole('button', { name: 'Play Song 20a', exact: true });
		await row.evaluate((el) => el.scrollIntoView({ block: 'center' }));
		await row.click();
		await page.waitForFunction(() => [...document.querySelectorAll('audio')].some((a) => !a.paused && a.currentTime > 0.3));
		return restores;
	}

	/** Still playing, and further in than a moment ago. */
	async function assertPlaying(page, where) {
		const first = await page.evaluate(() => Math.max(...[...document.querySelectorAll('audio')].map((a) => (a.paused ? -1 : a.currentTime))));
		await page.waitForTimeout(400);
		const second = await page.evaluate(() => Math.max(...[...document.querySelectorAll('audio')].map((a) => (a.paused ? -1 : a.currentTime))));
		assert.ok(first >= 0 && second > first, `playback stopped at ${where} (${first} then ${second})`);
	}

	before(() => {
		subsonic.state.audio = { type: 'audio/wav', body: silentWav(300) };
	});

	after(() => {
		subsonic.state.audio = null;
	});

	test('on a wide screen, through the rail and by cards', async () => {
		const { page, problems } = await watchedPage();
		try {
			const restores = await playAndWatch(page);
			const count = restores.length;
			const rail = (name) => page.locator('nav.rail').getByRole('link', { name, exact: true });
			const steps = [
				['rail Albums', () => rail('Albums').click(), /\/albums$/],
				['an album card', () => page.locator('main a[href="/albums/al3"]').first().click(), /\/albums\/al3$/],
				['rail Artists', () => rail('Artists').click(), /\/artists$/],
				['an artist card', () => page.locator('main a[href="/artists/ar4"]').first().click(), /\/artists\/ar4$/],
				['rail Genres', () => rail('Genres').click(), /\/genres$/],
				['rail Playlists', () => rail('Playlists').click(), /\/playlists$/],
				['a playlist card', () => page.locator('main a[href="/playlists/pl1"]').first().click(), /\/playlists\/pl1$/],
				['rail Favourites', () => rail('Favourites').click(), /\/favourites/],
				['rail Search', () => rail('Search').click(), /\/search$/],
				['rail Home', () => rail('Home').click(), /\/$/],
				['a home card', () => page.locator('main a[href^="/albums/al"]').first().click(), /\/albums\/al\d+$/],
				['back', () => page.goBack(), /\/$/],
				['rail Settings', () => page.locator('nav.rail a[href="/settings"]').click(), /\/settings$/],
				['rail Albums again', () => rail('Albums').click(), /\/albums$/],
				['a sort chip', () => page.locator('main a[href*="sort="]').nth(1).click(), /sort=/],
				['rail Home again', () => rail('Home').click(), /\/$/]
			];
			for (const [where, go, url] of steps) {
				await go();
				await page.waitForURL(url);
				await page.waitForLoadState('networkidle');
				await assertPlaying(page, where);
			}
			assert.equal(restores.length, count, `the player was attached again ${restores.length - count} times`);
		} finally {
			await page.close();
		}
		assert.deepEqual(problems, []);
	});

	test('on a phone, through the dock, the Library page and cards', async () => {
		const phone = await browser.newContext({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true });
		const signIn = await phone.request.post(`${app.url}/login`, {
			form: { username: 'testuser', password: 'testpass', backend: 'subsonic', next: '/' },
			headers: { origin: app.url, accept: 'text/html' },
			maxRedirects: 0
		});
		assert.equal(signIn.status(), 303);
		const page = await phone.newPage();
		const problems = [];
		page.on('pageerror', (err) => problems.push(err.message));
		try {
			const restores = await playAndWatch(page);
			const count = restores.length;
			const tab = (name) => page.locator('.phone-dock').getByRole('link', { name, exact: true });
			const steps = [
				['dock Library', () => tab('Library').tap(), /\/library$/],
				['Library Albums', () => page.locator('main a[href="/albums"]').first().tap(), /\/albums$/],
				['an album card', () => page.locator('main a[href="/albums/al5"]').first().tap(), /\/albums\/al5$/],
				['dock Home', () => tab('Home').tap(), /\/$/],
				['dock Favourites', () => tab('Favourites').tap(), /\/favourites/],
				['dock Search', () => tab('Search').tap(), /\/search$/],
				['a genre tile', () => page.locator('main a[href^="/genres/"]').first().tap(), /\/genres\//],
				['dock Library again', () => tab('Library').tap(), /\/library$/],
				['Library Artists', () => page.locator('main a[href="/artists"]').first().tap(), /\/artists$/],
				['an artist card', () => page.locator('main a[href="/artists/ar6"]').first().tap(), /\/artists\/ar6$/],
				['back', () => page.goBack(), /\/artists$/],
				['dock Library, Playlists', () => tab('Library').tap(), /\/library$/],
				['Library Playlists', () => page.locator('main a[href="/playlists"]').first().tap(), /\/playlists$/],
				['a playlist card', () => page.locator('main a[href="/playlists/pl1"]').first().tap(), /\/playlists\/pl1$/],
				['dock Home again', () => tab('Home').tap(), /\/$/],
				// On a phone, Settings is under the Library tab.
				['dock Library for Settings', () => tab('Library').tap(), /\/library$/],
				['settings', () => page.locator('main a[href="/settings"]').first().tap(), /\/settings$/]
			];
			for (const [where, go, url] of steps) {
				// The dock folds away while the page scrolls down.
				await page.evaluate(() => scrollTo(0, 0));
				await go();
				await page.waitForURL(url);
				await page.waitForLoadState('networkidle');
				await assertPlaying(page, where);
			}
			assert.equal(restores.length, count, `the player was attached again ${restores.length - count} times`);
		} finally {
			await phone.close();
		}
		assert.deepEqual(problems, []);
	});

	test('after an image update removed the pages the tab had not opened', async () => {
		const { page, problems } = await watchedPage();
		let loads = 0;
		page.on('load', () => loads++);
		try {
			await playAndWatch(page);
			// The layout fetches every page's code 3 seconds after signing in.
			await page.waitForTimeout(4000);
			await page.waitForLoadState('networkidle');
			// The new build: the old build's page files answer 404 and the
			// version names a different build.
			await page.route('**/_app/immutable/nodes/**', (route) => route.fulfill({ status: 404, body: 'Not Found' }));
			await page.route('**/_app/version.json*', (route) =>
				route.fulfill({ contentType: 'application/json', body: '{"version":"next"}' })
			);
			const before = loads;
			const rail = (name) => page.locator('nav.rail').getByRole('link', { name, exact: true });
			for (const [where, go, url] of [
				['rail Playlists', () => rail('Playlists').click(), /\/playlists$/],
				['a playlist card', () => page.locator('main a[href="/playlists/pl1"]').first().click(), /\/playlists\/pl1$/],
				['rail Genres', () => rail('Genres').click(), /\/genres$/]
			]) {
				await go();
				await page.waitForURL(url);
				await assertPlaying(page, where);
			}
			assert.equal(loads, before, 'a page change loaded the whole page');
		} finally {
			await page.close();
		}
		assert.deepEqual(problems, []);
	});

	test('when a page\'s data request fails three times in a row', async () => {
		const { page, problems } = await watchedPage();
		let loads = 0;
		page.on('load', () => loads++);
		try {
			await playAndWatch(page);
			const before = loads;
			let failures = 3;
			await page.route('**/__data.json*', (route) => (failures-- > 0 ? route.abort('failed') : route.continue()));
			await page.locator('nav.rail').getByRole('link', { name: 'Playlists', exact: true }).click();
			await page.waitForURL(/\/playlists$/);
			await assertPlaying(page, 'the playlists page');
			assert.ok(failures < 0, 'every failure was used');
			assert.equal(loads, before, 'the page change loaded the whole page');
		} finally {
			await page.close();
		}
		// Chromium reports each aborted request on the console.
		assert.deepEqual(problems.filter((problem) => !problem.endsWith('Failed to load resource: net::ERR_FAILED')), []);
	});
});

describe('shuffle', () => {
	test('a queue played in order turns it off, and the saved state says so', async (t) => {
		playable(t);
		const { page, problems } = await watchedPage();
		try {
			await page.goto(app.url + '/albums/al12', { waitUntil: 'networkidle' });
			const main = page.locator('main');
			const title = () => page.locator('aside.panel h2.title').textContent();
			// Waited for rather than read after the title changes: a shuffled
			// queue can already be on the track pressed next, and then the title
			// matches before the press has landed.
			const shuffleIs = (on) =>
				page.waitForFunction(
					(on) => document.querySelector('aside.panel button[aria-label="Shuffle"]')?.getAttribute('aria-pressed') === String(on),
					on,
					{ timeout: 5000 }
				);
			const litAgain = () => shuffleIs(true);
			await main.getByRole('button', { name: 'Shuffle', exact: true }).click();
			await litAgain();

			// It stayed on over every queue started in order after one shuffle.
			const saved = page.waitForRequest(
				(r) =>
					new URL(r.url()).pathname === '/api/play-state' &&
					r.method() !== 'GET' &&
					(r.postData() ?? '').includes('"shuffle":false')
			);
			await main.getByRole('button', { name: 'Play', exact: true }).click();
			await shuffleIs(false);
			await page.waitForFunction(() => document.querySelector('aside.panel h2.title')?.textContent === 'Song 12a');
			await saved;

			await main.getByRole('button', { name: 'Shuffle', exact: true }).click();
			await litAgain();
			// A row other than the one playing: pressing that one pauses it and
			// leaves the queue as it is.
			const playing = await title();
			const other = ['Song 12a', 'Song 12b'].find((name) => name !== playing);
			await page.getByRole('button', { name: `Play ${other}`, exact: true }).click();
			await shuffleIs(false);
			assert.equal(await title(), other);
		} finally {
			await page.close();
		}
		assert.deepEqual(problems, []);
	});
});

describe('the featured release', () => {
	test('zooms and lifts its shade gradually under the pointer', async () => {
		const { page, problems } = await watchedPage();
		try {
			await page.goto(app.url + '/', { waitUntil: 'networkidle' });
			// Past the 1800ms arrival.
			await page.waitForTimeout(2000);
			const read = () =>
				page.evaluate(() => ({
					scale: Number(getComputedStyle(document.querySelector('.featured .art')).scale),
					shade: Number(getComputedStyle(document.querySelector('.featured .scrim')).opacity)
				}));
			assert.deepEqual(await read(), { scale: 1.14, shade: 1 });
			const panel = await page.locator('.featured').boundingBox();
			await page.mouse.move(panel.x + panel.width * 0.75, panel.y + panel.height * 0.25);
			// Read from the transition itself, paused and set partway. Sampled on the
			// clock, a slow runner read it before the first frame (the zoom "snapped to
			// 1.14") or after the last.
			const midway = await page.evaluate(async () => {
				const until = performance.now() + 1000;
				while (performance.now() < until && document.getAnimations().length === 0) {
					await new Promise((done) => requestAnimationFrame(done));
				}
				for (const animation of document.getAnimations()) {
					animation.pause();
					const end = Number(animation.effect?.getComputedTiming().endTime ?? 0);
					if (end > 0) animation.currentTime = end / 2;
				}
				return {
					scale: Number(getComputedStyle(document.querySelector('.featured .art')).scale),
					shade: Number(getComputedStyle(document.querySelector('.featured .scrim')).opacity)
				};
			});
			// It jumped straight to 1.2: the arrival animation, filled forwards,
			// held `scale` and the transition never ran.
			assert.ok(midway.scale > 1.14 && midway.scale < 1.195, `the zoom snapped to ${midway.scale}`);
			assert.ok(midway.shade > 0.8 && midway.shade < 1, `the shade did not fade (${midway.shade})`);
			await page.evaluate(() => {
				for (const animation of document.getAnimations()) animation.finish();
			});
			assert.deepEqual(await read(), { scale: 1.2, shade: 0.8 });
		} finally {
			await page.close();
		}
		assert.deepEqual(problems, []);
	});
});

describe('track rows', () => {
	test('a double press on a row\'s heart does not play that row', async (t) => {
		playable(t);
		const { page, problems } = await watchedPage();
		try {
			await page.goto(app.url + '/albums/al3', { waitUntil: 'networkidle' });
			await page.getByRole('button', { name: 'Play Song 3a', exact: true }).click();
			const title = page.locator('aside.panel h2.title');
			await page.waitForFunction(() => document.querySelector('aside.panel h2.title')?.textContent === 'Song 3a');

			const second = page.locator('.track').nth(1);
			await second.hover();
			await second.locator('.fav').dblclick();
			await page.waitForTimeout(400);
			assert.equal(await title.textContent(), 'Song 3a', 'the double press started the row it was in');
		} finally {
			await page.close();
		}
		assert.deepEqual(problems, []);
	});
});

describe('presses, cards and arriving at an album', () => {
	const scripted = (el) => el.getAnimations().some((a) => !(a instanceof CSSTransition) && !(a instanceof CSSAnimation));

	test('a press on a button ripples from where it landed', async () => {
		const { page, problems } = await watchedPage();
		try {
			await page.goto(app.url + '/albums/al6', { waitUntil: 'networkidle' });
			const play = page.locator('.page .hh-button--primary').first();
			const box = await play.boundingBox();
			await page.mouse.move(box.x + 10, box.y + box.height / 2);
			await page.mouse.down();
			const pressed = await play.evaluate((el) => ({
				pressed: el.classList.contains('pressed'),
				x: el.style.getPropertyValue('--press-x'),
				ripple: el.getAnimations().some((a) => a.animationName === 'press-ripple')
			}));
			await page.mouse.up();
			assert.ok(pressed.pressed && pressed.ripple, 'no ripple on the press');
			assert.equal(pressed.x, '10px');
		} finally {
			await page.close();
		}
		assert.deepEqual(problems, []);
	});

	test('hovering a card lights the cover instead of showing a play button', async () => {
		const { page, problems } = await watchedPage();
		try {
			await page.goto(app.url + '/albums', { waitUntil: 'networkidle' });
			const card = page.locator('a.card:has(button.play)').first();
			// The glow's opacity on every frame from before the hover. It has to
			// pass through values between 0 and 1: a `drop-shadow` transitioned from
			// `none` drew nothing until it ended and then all of it. Sampled, not
			// read at a fixed time: a CI runner had not started the hover 100ms in.
			await card.evaluate((el) => {
				const glow = getComputedStyle(el.querySelector('.art'), '::before');
				window.__glow = [];
				const sample = () => {
					window.__glow.push(Number(glow.opacity));
					if (window.__glow.length < 120) requestAnimationFrame(sample);
				};
				requestAnimationFrame(sample);
			});
			await card.hover();
			await page.waitForTimeout(700);
			const frames = await page.evaluate(() => window.__glow);
			assert.ok(frames.some((value) => value > 0 && value < 1), `the glow did not fade in: ${[...new Set(frames)].join(', ')}`);
			const state = await card.evaluate((el) => {
				const play = el.querySelector('button.play');
				const shine = getComputedStyle(el.querySelector('.cover'), '::after');
				return {
					play: getComputedStyle(play).opacity,
					clicks: getComputedStyle(play).pointerEvents,
					shine: shine.translate,
					glow: getComputedStyle(el.querySelector('.art'), '::before').opacity
				};
			});
			assert.equal(state.play, '0', 'the play button showed on hover');
			assert.equal(state.clicks, 'none');
			assert.notEqual(state.shine, '-130% 0px', 'the light did not cross the cover');
			assert.equal(state.glow, '1');
		} finally {
			await page.close();
		}
		assert.deepEqual(problems, []);
	});

	test('arriving at an album drops its track list in, and fades the cover up without a morph', async () => {
		const { page, problems } = await watchedPage();
		try {
			await page.goto(app.url + '/albums', { waitUntil: 'networkidle' });
			await page.evaluate(() => {
				window.__arrival = null;
				const look = () => {
					const rows = [...document.querySelectorAll('.content .tracks > li')];
					const art = document.querySelector('.hero .art');
					if (location.pathname === '/albums/al7' && rows.length > 0 && art) {
						const scripted = (el) =>
							el.getAnimations().some((a) => !(a instanceof CSSTransition) && !(a instanceof CSSAnimation));
						window.__arrival = { rows: rows.filter(scripted).length, cover: scripted(art) };
						return;
					}
					requestAnimationFrame(look);
				};
				requestAnimationFrame(look);
				// A link rather than a card: no sleeve carries the cover in.
				const link = document.createElement('a');
				link.href = '/albums/al7';
				document.body.append(link);
				link.click();
			});
			await page.waitForFunction(() => window.__arrival !== null, null, { timeout: 5000 });
			const arrival = await page.evaluate(() => window.__arrival);
			assert.ok(arrival.rows >= 2, `only ${arrival.rows} rows dropped in`);
			assert.ok(arrival.cover, 'the cover did not fade up');
			void scripted;
		} finally {
			await page.close();
		}
		assert.deepEqual(problems, []);
	});
});

describe('the album sleeve', () => {
	test('turns toward the pointer, and settles flat when it leaves', async () => {
		const { page, problems } = await watchedPage();
		try {
			await page.goto(app.url + '/albums/al3', { waitUntil: 'networkidle' });
			const holder = page.locator('.hero .holder');
			const transform = () => holder.evaluate((el) => getComputedStyle(el).transform);
			const box = await holder.boundingBox();
			// The upper right: turned toward the viewer on both axes, and lifted.
			await page.mouse.move(box.x + box.width * 0.9, box.y + box.height * 0.1, { steps: 4 });
			await page.waitForTimeout(400);
			const turned = await transform();
			assert.match(turned, /^matrix3d\(/, `the sleeve did not turn: ${turned}`);

			await page.mouse.move(5, 5, { steps: 2 });
			await page.waitForTimeout(900);
			assert.equal(await transform(), 'matrix(1, 0, 0, 1, 0, 0)', 'the sleeve stayed turned');
		} finally {
			await page.close();
		}
		assert.deepEqual(problems, []);
	});
});

describe('shelves', () => {
	test('a shelf pages sideways from its buttons, and stays in its column', async () => {
		const { page, problems } = await watchedPage();
		try {
			await page.goto(app.url + '/', { waitUntil: 'networkidle' });
			const shelf = page.locator('section.shelf', { hasText: 'Recently added' });
			const track = shelf.locator('.track');
			const back = shelf.getByRole('button', { name: 'Scroll Recently added back' });
			const on = shelf.getByRole('button', { name: 'Scroll Recently added on' });
			assert.ok(await back.isDisabled(), 'back is offered at the start');

			// The line is wider than the page, and the page is not.
			const widths = await page.evaluate(() => {
				const content = document.querySelector('main.content');
				const line = document.querySelector('section.shelf .track');
				return { page: content.scrollWidth, column: content.clientWidth, line: line.scrollWidth };
			});
			assert.ok(widths.line > widths.column, 'the line fits, so nothing here pages');
			assert.ok(widths.page <= widths.column, `the page is ${widths.page}px in a ${widths.column}px column`);

			await on.click();
			await page.waitForFunction((el) => el.scrollLeft > 200, await track.elementHandle(), { timeout: 3000 });
			// The button follows the shelf's scroll event, which can land after the
			// position above is read. Read at once, it failed CI three times on
			// 2026-09-28 and 29.
			await page.waitForFunction((button) => !button.disabled, await back.elementHandle(), { timeout: 3000 });
		} finally {
			await page.close();
		}
		assert.deepEqual(problems, []);
	});
});
