/**
 * Checks that need a browser: what the Content-Security-Policy blocks, and
 * what the interface does on screen.
 *
 *   npm run build
 *   npx playwright install --with-deps chromium   # once
 *   npm run test:browser
 *
 * Runs the built app against the same mock servers as `tests/e2e`.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { chromium } from 'playwright';
import { startApp } from '../e2e/harness.mjs';
import { startJellyfin, startSubsonic } from '../e2e/mocks.mjs';

let subsonic;
let jellyfin;
let app;
let browser;
let context;

before(async () => {
	subsonic = await startSubsonic({ artistCount: 40 });
	jellyfin = await startJellyfin();
	app = await startApp({ subsonicUrl: subsonic.url, jellyfinUrl: jellyfin.url });
	browser = await chromium.launch();
	context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
	const signIn = await context.request.post(`${app.url}/login`, {
		form: { username: 'testuser', password: 'testpass', backend: 'subsonic', next: '/' },
		headers: { origin: app.url, accept: 'text/html' },
		maxRedirects: 0
	});
	assert.equal(signIn.status(), 303);
});

after(async () => {
	await browser?.close();
	await app?.stop();
	await subsonic?.close();
	await jellyfin?.close();
});

/** A page that records every console error and uncaught exception. */
async function watchedPage() {
	const page = await context.newPage();
	const problems = [];
	page.on('console', (message) => {
		if (message.type() === 'error') problems.push(`${page.url()}: ${message.text()}`);
	});
	page.on('pageerror', (err) => problems.push(`${page.url()}: ${err.message}`));
	return { page, problems };
}

describe('the policy', () => {
	/*
	 * A CSP violation is reported on the console and nowhere else: the page
	 * renders, and the thing that was refused (a font subset inlined as a
	 * `data:` URL, an inline `onerror`, a `data:` audio sample) quietly does not
	 * work. Each of those shipped once. An empty console on every page is what
	 * catches the next one.
	 */
	test('no page logs an error', async () => {
		const { page, problems } = await watchedPage();
		const paths = [
			'/',
			'/albums',
			'/albums/al1',
			'/artists',
			'/artists/ar1',
			'/favourites',
			'/genres',
			'/playlists',
			'/search?q=song',
			'/settings'
		];
		for (const path of paths) {
			const response = await page.goto(app.url + path, { waitUntil: 'networkidle' });
			assert.equal(response?.status(), 200, path);
		}
		await page.close();
		assert.deepEqual(problems, []);
	});
});

describe('playing from a card', () => {
	test('a slow play shows it is busy, and a second click is ignored', async () => {
		const { page, problems } = await watchedPage();
		await page.goto(app.url + '/', { waitUntil: 'networkidle' });
		const card = page.locator('a.card:has(button.play)').first();
		const button = card.locator('button.play');
		const state = () =>
			button.evaluate((b) => {
				const spinner = b.querySelector('.spinner');
				return {
					busy: b.getAttribute('aria-busy'),
					spinner: spinner ? getComputedStyle(spinner).opacity : null,
					glyph: getComputedStyle(b.querySelector('.glyph')).opacity,
					button: getComputedStyle(b).opacity
				};
			});

		// Hovering preloads the album page, which calls `getAlbum` itself.
		await card.hover();
		await page.waitForTimeout(600);
		subsonic.state.delays.set('getAlbum', 1500);
		subsonic.calls.reset();
		try {
			// From the keyboard: the button takes no pointer clicks unless it is
			// focused or busy, since the cover's hover no longer shows it.
			await button.focus();
			await page.keyboard.press('Enter');
			await page.waitForTimeout(60);
			// The button fades in on the press now (hover no longer shows it), so its
			// own opacity is checked at the next step, once the fade is over.
			const early = await state();
			assert.deepEqual({ ...early, button: undefined }, { busy: 'true', spinner: '0', glyph: '1', button: undefined }, 'no spinner before 150ms');

			await page.waitForTimeout(340);
			await page.keyboard.press('Enter');
			await page.mouse.move(5, 5);
			await page.waitForTimeout(100);
			assert.deepEqual(await state(), { busy: 'true', spinner: '1', glyph: '0', button: '1' }, 'spinner shown, button held up');

			await page.waitForFunction((b) => b?.getAttribute('aria-busy') === 'false', await button.elementHandle(), {
				timeout: 5000
			});
			assert.equal((await state()).spinner, null);
			assert.equal(subsonic.calls.get('getAlbum'), 1, 'the second click must not fetch again');
		} finally {
			subsonic.state.delays.clear();
		}
		await page.close();
		assert.deepEqual(problems, []);
	});

	test('a fast play never shows the spinner', async () => {
		const { page } = await watchedPage();
		await page.goto(app.url + '/', { waitUntil: 'networkidle' });
		const card = page.locator('a.card:has(button.play)').first();
		const button = card.locator('button.play');
		await card.hover();
		// Hovering preloads the album page. Clicking while that is still loading
		// put the tracks request behind it, past 150ms on a CI runner once, and
		// the spinner the test says never shows did.
		await page.waitForTimeout(600);
		await button.focus();
		await page.keyboard.press('Enter');
		for (let sample = 0; sample < 8; sample++) {
			const opacity = await button.evaluate((b) => {
				const spinner = b.querySelector('.spinner');
				return spinner ? getComputedStyle(spinner).opacity : '0';
			});
			assert.equal(opacity, '0');
			await page.waitForTimeout(20);
		}
		await page.close();
	});
});

/**
 * A WAV of `seconds` of silence, 8 kHz mono 8-bit, which Chromium decodes and
 * plays. The HTTP suite's stream body is not audio, and these checks need
 * `timeupdate` to fire.
 */
function silentWav(seconds) {
	const rate = 8000;
	const data = rate * seconds;
	const wav = Buffer.alloc(44 + data, 128);
	wav.write('RIFF', 0);
	wav.writeUInt32LE(36 + data, 4);
	wav.write('WAVEfmt ', 8);
	wav.writeUInt32LE(16, 16);
	wav.writeUInt16LE(1, 20);
	wav.writeUInt16LE(1, 22);
	wav.writeUInt32LE(rate, 24);
	wav.writeUInt32LE(rate, 28);
	wav.writeUInt16LE(1, 32);
	wav.writeUInt16LE(8, 34);
	wav.write('data', 36);
	wav.writeUInt32LE(data, 40);
	return wav;
}

describe('the sleep timer', () => {
	test('fades out over the last seconds, then pauses and puts the level back', async () => {
		subsonic.state.audio = { type: 'audio/wav', body: silentWav(120) };
		const { page, problems } = await watchedPage();
		try {
			await page.clock.install();
			await page.goto(app.url + '/albums/al1', { waitUntil: 'networkidle' });
			await page.getByRole('button', { name: 'Play Song 1a', exact: true }).click();
			// Read in the same poll that finds it playing: read separately, the element
			// was once between states on a CI runner and none was found.
			const full = await (
				await page.waitForFunction(
					() => [...document.querySelectorAll('audio')].find((a) => !a.paused && a.currentTime > 0)?.volume ?? null
				)
			).jsonValue();
			assert.ok(full > 0.5, `playing at ${full}`);

			await page.getByRole('button', { name: 'Sleep timer' }).click();
			await page.getByRole('button', { name: '15 min', exact: true }).click();
			await page.waitForFunction(() => document.querySelector('[aria-label^="Sleep timer, pausing in 15"]'));

			// 6 of the 12 fade seconds left: sin(pi/4) of the level, about 0.71.
			await page.clock.fastForward('14:54');
			await page.waitForFunction(
				(limit) => {
					const a = [...document.querySelectorAll('audio')].find((e) => !e.paused);
					return a && a.volume < limit;
				},
				full * 0.85,
				{ timeout: 3000 }
			);

			await page.clock.fastForward(10_000);
			await page.waitForFunction(() => [...document.querySelectorAll('audio')].every((a) => a.paused), null, {
				timeout: 3000
			});
			const levels = await page.evaluate(() => [...document.querySelectorAll('audio')].map((a) => a.volume));
			assert.ok(levels.every((level) => level === full), `levels after the pause: ${levels}`);
			assert.equal(await page.locator('button[aria-label="Sleep timer"]').count(), 1, 'the timer is cleared');
		} finally {
			subsonic.state.audio = null;
			await page.close();
		}
		assert.deepEqual(problems, []);
	});

	test('"End of track" stops at the end with the next track loaded', async () => {
		subsonic.state.audio = { type: 'audio/wav', body: silentWav(3) };
		const { page, problems } = await watchedPage();
		try {
			await page.goto(app.url + '/albums/al1', { waitUntil: 'networkidle' });
			await page.getByRole('button', { name: 'Play Song 1a', exact: true }).click();
			await page.waitForFunction(() =>
				[...document.querySelectorAll('audio')].some((a) => !a.paused && a.currentTime > 0)
			);
			const title = page.locator('aside.panel h2.title');
			assert.equal(await title.textContent(), 'Song 1a');

			await page.getByRole('button', { name: 'Sleep timer' }).click();
			await page.getByRole('button', { name: 'End of track' }).click();

			await page.waitForFunction(() => document.querySelector('aside.panel h2.title')?.textContent === 'Song 1b', null, {
				timeout: 8000
			});
			await page.waitForTimeout(500);
			const audio = await page.evaluate(() => [...document.querySelectorAll('audio')].map((a) => a.paused));
			assert.ok(audio.every(Boolean), 'nothing plays after the track ends');
			assert.equal(await page.locator('aside.panel button.play').getAttribute('aria-label'), 'Play');
			assert.equal(await page.locator('button[aria-label="Sleep timer"]').count(), 1, 'the timer is cleared');
		} finally {
			subsonic.state.audio = null;
			await page.close();
		}
		assert.deepEqual(problems, []);
	});
});

describe('crossfade where the volume cannot be set', () => {
	/*
	 * iOS ignores a `volume` written from script and reads back 1. A crossfade
	 * there started the next track at full level while the current one still
	 * had its last seconds to play. Here `volume` is made to behave that way.
	 */
	test('the next track starts when the current one ends, not over it', async () => {
		subsonic.state.audio = { type: 'audio/wav', body: silentWav(6) };
		const settings = (patch) =>
			context.request.patch(`${app.url}/api/settings`, { data: patch, headers: { origin: app.url } });
		assert.equal((await settings({ transition: 'crossfade', crossfadeSeconds: 4 })).status(), 200);
		const { page, problems } = await watchedPage();
		try {
			await page.addInitScript(() => {
				Object.defineProperty(HTMLMediaElement.prototype, 'volume', {
					configurable: true,
					get: () => 1,
					set: () => {}
				});
			});
			await page.goto(app.url + '/albums/al1', { waitUntil: 'networkidle' });
			await page.evaluate(() => {
				window.__together = 0;
				setInterval(() => {
					// Tracks only: the second element plays a muted `/silence.wav` once, at
					// the first press of Play, to be allowed to play later.
					const playing = [...document.querySelectorAll('audio')].filter(
						(a) => !a.paused && a.currentTime > 0 && a.currentSrc.includes('/api/stream/')
					);
					window.__together = Math.max(window.__together, playing.length);
				}, 50);
			});
			await page.getByRole('button', { name: 'Play Song 1a', exact: true }).click();
			await page.waitForFunction(() => document.querySelector('aside.panel h2.title')?.textContent === 'Song 1b', null, {
				timeout: 12_000
			});
			await page.waitForTimeout(500);
			assert.equal(await page.evaluate(() => window.__together), 1, 'two tracks played at once');
		} finally {
			await settings({ transition: 'gapless' });
			subsonic.state.audio = null;
			await page.close();
		}
		assert.deepEqual(problems, []);
	});
});

describe('the tint on the rail and the player', () => {
	/*
	 * Each surface cross-fades two washes. When the one on screen was hidden and
	 * the other shown in the same frame, a GPU that drew the second a frame late
	 * showed neither, which was reported as a dark flash on every colour change.
	 * Headless Chromium draws in step, so the flash cannot be seen here; what
	 * can be checked is that no layer jumps between frames.
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
				// The frame's own time, which is what the transition is sampled at.
				// `performance.now()` in the callback runs late behind a busy frame,
				// and a 0.60 step between two callbacks 30ms apart on that clock was
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

			// Only between frames under 50ms apart, by frame time. A CI runner drops frames, and a
			// 900ms fade covers 0.66 across one gap of a few hundred milliseconds
			// (seen once). The reset this guards against moved 1.0 in a 16ms frame.
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
	 * The two washes were positioned at `z-index: 0`, among the panel's
	 * contents in document order, and the second one comes after all of them:
	 * whenever it was the wash on screen, it lay over the cover.
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
			// The queue is album 23's last track, then album 24; the page open at
			// the change is album 25. The tracks are 8s long, so the change comes
			// after the observer below is watching.
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
		try {
			await page.goto(app.url + '/albums/al31', { waitUntil: 'networkidle' });
			await page.waitForTimeout(1200);

			const stop = await sampleLayers(page);
			await navigate(page, '/albums/al32');
			await page.waitForURL(/\/albums\/al32$/);
			await navigate(page, '/albums/al33');
			await page.waitForURL(/\/albums\/al33$/);
			await page.waitForTimeout(2200);
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
	 * played the song from the start. The player now waits for the position.
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
			await page.locator('aside.panel button.play').click();
			await page.waitForFunction(
				() => [...document.querySelectorAll('audio')].some((a) => !a.paused && a.currentTime > 0),
				null,
				{ timeout: 15_000 }
			);
			const at = await page.evaluate(() =>
				Math.max(...[...document.querySelectorAll('audio')].filter((a) => !a.paused).map((a) => a.currentTime))
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

describe('track rows', () => {
	test('a double press on a row\'s heart does not play that row', async () => {
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
			await card.hover();
			await page.waitForTimeout(450);
			const state = await card.evaluate((el) => {
				const play = el.querySelector('button.play');
				const shine = getComputedStyle(el.querySelector('.cover'), '::after');
				return {
					play: getComputedStyle(play).opacity,
					clicks: getComputedStyle(play).pointerEvents,
					shine: shine.translate,
					glow: getComputedStyle(el.querySelector('.art')).filter
				};
			});
			assert.equal(state.play, '0', 'the play button showed on hover');
			assert.equal(state.clicks, 'none');
			assert.notEqual(state.shine, '-130% 0px', 'the light did not cross the cover');
			assert.match(state.glow, /drop-shadow/);
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
			assert.ok(!(await back.isDisabled()), 'back is not offered once it has moved');
		} finally {
			await page.close();
		}
		assert.deepEqual(problems, []);
	});
});

describe('the aurora', () => {
	test('is off by default, and drifts or holds still from Settings', async () => {
		const origin = { origin: app.url, 'content-type': 'application/json' };
		const { page, problems } = await watchedPage();
		const state = () =>
			page.evaluate(() => {
				const aurora = document.querySelector('.aurora');
				if (!aurora) return { shown: false, running: false };
				const animation = aurora.getAnimations({ subtree: true }).find((a) => a.animationName === 'aurora');
				return { shown: true, running: animation?.playState === 'running' };
			});
		try {
			await page.goto(app.url + '/albums', { waitUntil: 'networkidle' });
			assert.deepEqual(await state(), { shown: false, running: false });

			await context.request.patch(`${app.url}/api/settings`, { headers: origin, data: { aurora: 'moving' } });
			await page.reload({ waitUntil: 'networkidle' });
			assert.deepEqual(await state(), { shown: true, running: true });

			await context.request.patch(`${app.url}/api/settings`, { headers: origin, data: { aurora: 'still' } });
			await page.reload({ waitUntil: 'networkidle' });
			assert.deepEqual(await state(), { shown: true, running: false });
		} finally {
			await context.request.patch(`${app.url}/api/settings`, { headers: origin, data: { aurora: 'off' } });
			await page.close();
		}
		assert.deepEqual(problems, []);
	});
});

describe('the player on a skip', () => {
	test('the song text slides in from the right on next and from the left on previous', async () => {
		const { page, problems } = await watchedPage();
		const from = () =>
			page.evaluate(() => {
				const text = document.querySelector('aside.panel .text');
				const animation = text.getAnimations().find((a) => !(a instanceof CSSTransition) && !(a instanceof CSSAnimation));
				return animation ? String(animation.effect.getKeyframes()[0].translate) : null;
			});
		try {
			await page.goto(app.url + '/albums/al8', { waitUntil: 'networkidle' });
			await page.getByRole('button', { name: 'Play Song 8a', exact: true }).click();
			await page.waitForFunction(() => document.querySelector('aside.panel h2.title')?.textContent === 'Song 8a');
			await page.waitForTimeout(600);

			await page.locator('aside.panel button.step').nth(1).click();
			await page.waitForFunction(() => document.querySelector('aside.panel h2.title')?.textContent === 'Song 8b');
			assert.match((await from()) ?? '', /^1\.25rem/, 'next did not slide in from the right');
			await page.waitForTimeout(600);

			await page.locator('aside.panel button.step').nth(0).click();
			await page.waitForFunction(() => document.querySelector('aside.panel h2.title')?.textContent === 'Song 8a');
			assert.match((await from()) ?? '', /^-1\.25rem/, 'previous did not slide in from the left');
		} finally {
			await page.close();
		}
		assert.deepEqual(problems, []);
	});
});

describe('sliders and the playlist picker', () => {
	/** Width transitions running on the volume slider's fill. */
	const fillGliding = (page) =>
		page.evaluate(() =>
			document
				.querySelector('[role="slider"][aria-label="Volume"] .played')
				.getAnimations()
				.some((a) => a instanceof CSSTransition && a.transitionProperty === 'width')
		);
	const fillWidth = (page) =>
		page.locator('[role="slider"][aria-label="Volume"] .played').evaluate((el) => parseFloat(el.style.width));

	test('the volume glides to a new level and empties on mute', async () => {
		const { page, problems } = await watchedPage();
		try {
			await page.goto(app.url + '/albums', { waitUntil: 'networkidle' });
			const before = await fillWidth(page);
			assert.ok(before > 50);

			await page.getByRole('button', { name: 'Mute', exact: true }).click();
			await page.waitForTimeout(60);
			assert.ok(await fillGliding(page), 'muting cut to empty instead of gliding');
			await page.waitForTimeout(500);
			assert.equal(await fillWidth(page), 0);

			await page.getByRole('button', { name: 'Unmute', exact: true }).click();
			await page.waitForTimeout(500);
			assert.equal(Math.round(await fillWidth(page)), Math.round(before));

			const bar = page.locator('[role="slider"][aria-label="Volume"]');
			const box = await bar.boundingBox();
			await page.mouse.click(box.x + box.width * 0.25, box.y + box.height / 2);
			await page.waitForTimeout(60);
			assert.ok(await fillGliding(page), 'a click cut to the level instead of gliding');
		} finally {
			// Put the volume back for the tests after.
			const bar = page.locator('[role="slider"][aria-label="Volume"]');
			const box = await bar.boundingBox();
			if (box) await page.mouse.click(box.x + box.width * 0.85, box.y + box.height / 2);
			await page.waitForTimeout(300);
			await page.close();
		}
		assert.deepEqual(problems, []);
	});

	test('the playlist picker brings its rows in and marks the one added to', async () => {
		const { page, problems } = await watchedPage();
		try {
			await page.goto(app.url + '/albums/al1', { waitUntil: 'networkidle' });
			await page.locator('.page').getByRole('button', { name: 'Add to playlist', exact: true }).first().click();
			const row = page.locator('dialog.picker .row').first();
			await row.waitFor();
			const rising = await row.evaluate((el) => el.getAnimations().some((a) => a.animationName === 'list-rise'));
			assert.ok(rising, 'the rows appeared without coming in');

			await row.click();
			await page.locator('dialog.picker .row.added').waitFor({ timeout: 5000 });
			await page.waitForTimeout(500);
			const check = await page
				.locator('dialog.picker .row.added .check')
				.evaluate((el) => ({ opacity: getComputedStyle(el).opacity, width: el.getBoundingClientRect().width }));
			assert.equal(check.opacity, '1');
			assert.ok(check.width > 10, 'the check did not open beside the name');
		} finally {
			await page.close();
		}
		assert.deepEqual(problems, []);
	});
});

describe('the volume slider', () => {
	/*
	 * The seek bar draws in whole seconds to save repaints, and the volume
	 * slider is the same component with values from 0 to 1. With the
	 * one-second floor applied to it, every level below full drew as 0.
	 */
	test('draws the level the player is at', async () => {
		const { page, problems } = await watchedPage();
		try {
			await page.goto(app.url + '/albums', { waitUntil: 'networkidle' });
			const drawn = await page
				.locator('[role="slider"][aria-label="Volume"] .played')
				.evaluate((el) => parseFloat(el.style.width));
			const level = await page.locator('[role="slider"][aria-label="Volume"]').getAttribute('aria-valuetext');
			assert.ok(drawn > 50, `the slider drew ${drawn}% for a level of ${level}`);
			assert.equal(Math.round(drawn), parseInt(level ?? '', 10));
		} finally {
			await page.close();
		}
		assert.deepEqual(problems, []);
	});
});

describe('motion', () => {
	test('the rail marker travels to the destination at the click, and lands under it', async () => {
		const { page, problems } = await watchedPage();
		try {
			await page.goto(app.url + '/albums', { waitUntil: 'networkidle' });
			const marker = page.locator('nav.rail .marker');
			const centreOf = (locator) =>
				locator.evaluate((el) => {
					const r = el.getBoundingClientRect();
					return r.top + r.height / 2;
				});
			await page.waitForFunction(() => document.querySelector('nav.rail')?.classList.contains('measured'));
			const albums = await centreOf(page.locator('nav.rail a[href="/albums"]'));
			assert.ok(Math.abs((await centreOf(marker)) - albums) < 1.5, 'the marker starts under Albums');

			// The playlists page held back, so the marker has to move on the click and
			// not wait for the page it is pointing at.
			subsonic.state.delays.set('getPlaylists', 3000);
			// Sampled every frame from the click: it has to pass through the space
			// between the two, not appear at the other end.
			await page.evaluate(() => {
				const el = document.querySelector('nav.rail .marker');
				const seen = (window.__marker = []);
				const sample = () => {
					const r = el.getBoundingClientRect();
					seen.push(r.top + r.height / 2);
					if (seen.length < 60) requestAnimationFrame(sample);
				};
				requestAnimationFrame(sample);
			});
			await page.locator('nav.rail').getByRole('link', { name: 'Playlists', exact: true }).click();
			await page.waitForFunction(() => window.__marker.length >= 60, null, { timeout: 5000 });
			const path = await page.evaluate(() => window.__marker);
			assert.equal(new URL(page.url()).pathname, '/albums', 'the playlists page arrived before the marker was checked');
			const playlists = await centreOf(page.locator('nav.rail a[href="/playlists"]'));

			assert.ok(Math.abs(path.at(-1) - playlists) < 1.5, `the marker ended at ${path.at(-1)}, not under Playlists at ${playlists}`);
			const between = path.filter((y) => y > albums + 4 && y < playlists - 4);
			// A loaded runner renders two or three frames of a 480ms move.
			assert.ok(between.length >= 1, `the marker jumped rather than travelled: ${path.map(Math.round).join(' ')}`);
		} finally {
			subsonic.state.delays.clear();
			await page.close();
		}
		assert.deepEqual(problems, []);
	});

	test('a page opened from the rail rises in and its cards follow one by one', async () => {
		const { page, problems } = await watchedPage();
		try {
			await page.goto(app.url + '/playlists', { waitUntil: 'networkidle' });
			const onFirstPaint = await page.evaluate(() =>
				document.getAnimations().map((a) => a.animationName).filter((name) => /rise/.test(name ?? ''))
			);
			assert.deepEqual(onFirstPaint, [], 'a server-rendered page must not animate in');

			await page.evaluate(() => {
				window.__rise = null;
				const look = () => {
					const names = document.getAnimations().map((a) => a.animationName);
					if (names.includes('list-rise')) {
						const cards = [...document.querySelectorAll('.content .hh-stagger > *')].slice(0, 4);
						window.__rise = {
							// Svelte scopes keyframes in a component: `svelte-…-page-rise`. A
							// Web Animations or Svelte animation has no name at all.
							page: names.some((name) => (name ?? '').endsWith('page-rise')),
							delays: cards.map((card) => getComputedStyle(card).animationDelay)
						};
						return;
					}
					requestAnimationFrame(look);
				};
				requestAnimationFrame(look);
			});
			await page.locator('nav.rail').getByRole('link', { name: 'Albums', exact: true }).click();
			await page.waitForFunction(() => window.__rise !== null, null, { timeout: 5000 });
			const rise = await page.evaluate(() => window.__rise);
			assert.ok(rise.page, 'the page did not rise');
			assert.deepEqual(rise.delays, ['0s', '0.024s', '0.048s', '0.072s']);
		} finally {
			await page.close();
		}
		assert.deepEqual(problems, []);
	});
});

describe('moving between pages', () => {
	/*
	 * In Safari and Firefox the rail and the player went dark on every page
	 * change while the veil faded behind them. The glass cannot be watched
	 * from here, so what is checked is that the veil is never behind it.
	 */
	test('the veil never goes behind the rail or the player', async () => {
		const { page, problems } = await watchedPage();
		try {
			await page.goto(app.url + '/settings', { waitUntil: 'networkidle' });
			await page.evaluate(() => {
				const seen = (window.__veil = []);
				const box = (el) => {
					const r = el.getBoundingClientRect();
					return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
				};
				const watch = () => {
					const veil = document.querySelector('.page-veil');
					if (veil) {
						seen.push({
							veil: box(veil),
							rail: box(document.querySelector('nav.rail')),
							panel: box(document.querySelector('aside.panel'))
						});
					}
					if (seen.length < 5) requestAnimationFrame(watch);
				};
				requestAnimationFrame(watch);
			});
			await page.locator('nav.rail').getByRole('link', { name: 'Playlists' }).click();
			await page.waitForFunction(() => window.__veil.length >= 5, null, { timeout: 5000 });
			const samples = await page.evaluate(() => window.__veil);

			const overlaps = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
			for (const { veil, rail, panel } of samples) {
				assert.ok(!overlaps(veil, rail), `the veil ${JSON.stringify(veil)} is behind the rail ${JSON.stringify(rail)}`);
				assert.ok(!overlaps(veil, panel), `the veil ${JSON.stringify(veil)} is behind the player ${JSON.stringify(panel)}`);
			}
		} finally {
			await page.close();
		}
		assert.deepEqual(problems, []);
	});
});

describe('on a phone', () => {
	/*
	 * Safari on iOS 26 draws the page behind its toolbar only from the
	 * document's own scroll, and fills the strip under the status bar and the
	 * band behind the toolbar with the page's background colour. With the
	 * content column scrolling inside a box one screen tall, an iPhone showed
	 * the page ending at the top of the toolbar with a dark band below it.
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
	 * A tap rather than `click()`. Playwright scrolls a target into view
	 * before clicking it, and with the rail pinned that moved a page scrolled
	 * to 600 back to 286, which a finger on the rail does not do.
	 */
	async function tap(page, locator) {
		const box = await locator.boundingBox();
		await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
	}

	test('the document scrolls to the bottom edge under a pinned rail', async () => {
		// The artists page: 40 of them run to 7800px on a phone, where the home
		// page, with its shelves in single lines, is 1900px.
		const { page, problems } = await phonePage('/artists');
		try {
			await page.evaluate(() => scrollTo(0, 1500));
			await page.waitForTimeout(100);
			const seen = await page.evaluate(() => ({
				scrollY,
				contentOverflow: getComputedStyle(document.querySelector('main.content')).overflowY,
				railTop: document.querySelector('nav.rail').getBoundingClientRect().top,
				contentBottom: document.querySelector('main.content').getBoundingClientRect().bottom,
				height: innerHeight
			}));
			assert.equal(seen.scrollY, 1500, 'the document did not scroll');
			assert.equal(seen.contentOverflow, 'visible', 'the content column is still a scroller');
			assert.equal(seen.railTop, 12, 'the rail scrolled away');
			assert.ok(seen.contentBottom >= seen.height, `the page stops at ${seen.contentBottom}, short of ${seen.height}`);
		} finally {
			await page.close();
		}
		assert.deepEqual(problems, []);
	});

	/*
	 * Scrolled, the content cell runs behind the rail, and the veil in it
	 * faded behind the glass. See 'moving between pages' above.
	 */
	test('the veil stays out from behind the rail on a scrolled page', async () => {
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
					if (veil) seen.push({ veil: box(veil), rail: box(document.querySelector('nav.rail')) });
					if (seen.length < 5) requestAnimationFrame(watch);
				};
				requestAnimationFrame(watch);
			});
			await tap(page, page.locator('nav.rail').getByRole('link', { name: 'Playlists' }));
			await page.waitForFunction(() => window.__veil.length >= 5, null, { timeout: 5000 });
			const samples = await page.evaluate(() => window.__veil);

			const overlaps = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
			for (const { veil, rail } of samples) {
				assert.ok(!overlaps(veil, rail), `the veil ${JSON.stringify(veil)} is behind the rail ${JSON.stringify(rail)}`);
			}
		} finally {
			await page.close();
		}
		assert.deepEqual(problems, []);
	});

	test('the open sheet holds the page still', async () => {
		const { page, problems } = await phonePage('/');
		try {
			await page.evaluate(() => scrollTo(0, 600));
			await tap(page, page.locator('nav.rail .reopen'));
			await page.waitForTimeout(600);
			await page.mouse.move(200, 400);
			await page.mouse.wheel(0, 800);
			await page.waitForTimeout(300);
			assert.equal(await page.evaluate(() => scrollY), 600, 'the page scrolled under the open sheet');

			await tap(page, page.locator('#player-hide'));
			await page.waitForTimeout(600);
			await page.mouse.wheel(0, 800);
			await page.waitForTimeout(300);
			assert.ok((await page.evaluate(() => scrollY)) > 600, 'the page does not scroll once the sheet is closed');
		} finally {
			await page.close();
		}
		assert.deepEqual(problems, []);
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
	 * rail and the player went from 40 to 31 for the length of the transition
	 * and back with a bright frame (recorded, not in this suite). Only the
	 * sleeve may be captured.
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
		const { page, problems } = await watchedPage();
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
			await page.close();
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
	 * On Subsonic every queued id is a `getSong` call, eight at a time, and
	 * the player stayed empty until the last had answered. The current track
	 * is looked up on its own first now.
	 */
	test('the current track shows before the rest of the queue, and a save made meanwhile keeps the whole queue', async () => {
		const ids = Array.from({ length: 40 }, (_, i) => `s${i}a`);
		const put = await context.request.put(`${app.url}/api/play-state`, {
			data: { songIds: ids, index: 20, position: 0, repeat: 'off', shuffle: false },
			headers: { origin: app.url }
		});
		assert.equal(put.status(), 200);
		subsonic.state.delays.set('getSong', 600);
		subsonic.calls.reset();

		const { page, problems } = await watchedPage();
		const saved = [];
		page.on('request', (request) => {
			if (request.method() === 'PUT' && request.url().endsWith('/api/play-state')) {
				saved.push(request.postDataJSON());
			}
		});
		try {
			const whole = page.waitForResponse(
				(response) => response.url().endsWith('/api/songs') && response.request().postDataJSON().ids.length === 40,
				{ timeout: 15_000 }
			);
			await page.goto(app.url + '/');
			await page.waitForFunction(() => document.querySelector('aside.panel h2.title')?.textContent === 'Song 20a', null, {
				timeout: 5000
			});
			assert.ok(subsonic.calls.get('getSong') < 41, `looked up ${subsonic.calls.get('getSong')} before showing`);

			// A save while only the current track is in: it must carry the saved queue.
			await page.getByRole('button', { name: 'Repeat: off' }).click();
			await page.waitForTimeout(1500);
			assert.ok(saved.length > 0, 'the repeat change was saved');
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
});
