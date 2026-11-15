/**
 * The player: what the policy lets a page do, playing, the seek bar, the sleep timer, crossfade, the equaliser, the quality badge, the visualiser and the install card.
 *
 *   npm run build
 *   node --test tests/browser/player.test.mjs
 *
 * Runs the built app against the mock servers of `tests/e2e`; see `suite.mjs`.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { silentWav } from '../e2e/mocks.mjs';
import { subsonic, app, browser, context, pick, shown, setSlider, sliderValue, watchedPage, setUpSuite } from './suite.mjs';

setUpSuite();

describe('the policy', () => {
	/*
	 * A CSP violation is reported on the console and nowhere else: the page
	 * renders, and what was refused (a font subset inlined as a `data:` URL, an
	 * inline `onerror`, a `data:` audio sample) does not work. Each of those
	 * shipped once. An empty console on every page catches the next one.
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
			'/radio',
			'/library',
			'/playlists',
			'/playlists/import',
			'/folders',
			'/folders/d-al1',
			'/history',
			'/screen',
			'/stats',
			'/stats/recap',
			'/search?q=song',
			'/people',
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
	/*
	 * The spinner waits 150ms in the CSS (`pending-show` in MediaCard.svelte), and
	 * these checks used to wait that out in real time: on a loaded runner the
	 * tracks request took past 150ms and a "fast" play showed the spinner (#262).
	 * The request is held here until the check lets it go, and the spinner's
	 * delay is read off its animation, paused and set where the check needs it.
	 */
	const holdTracks = async (page) => {
		const held = [];
		let release;
		const released = new Promise((done) => (release = done));
		await page.route('**/api/tracks', async (route) => {
			held.push(route);
			await released;
			await route.continue();
		});
		return { held, release };
	};
	const playButton = (page, href) => {
		const button = page.locator(`a.card[href="${href}"]:has(button.play)`).first().locator('button.play');
		return {
			button,
			state: () =>
				button.evaluate((b) => {
					const spinner = b.querySelector('.spinner');
					return {
						busy: b.getAttribute('aria-busy'),
						spinner: spinner ? getComputedStyle(spinner).opacity : null,
						glyph: getComputedStyle(b.querySelector('.glyph')).opacity
					};
				}),
			// Pauses the spinner's and the icon's 150ms delay at `ms`.
			at: (ms) =>
				button.evaluate((b, ms) => {
					const animations = b.getAnimations({ subtree: true }).filter((a) => /pending-(show|hide)$/.test(a.animationName));
					for (const animation of animations) {
						animation.pause();
						animation.currentTime = ms;
					}
					return animations.length;
				}, ms)
		};
	};

	test('a slow play shows it is busy past 150ms, and a second press is ignored', async () => {
		const { page, problems } = await watchedPage();
		await page.goto(app.url + '/', { waitUntil: 'networkidle' });
		const { held, release } = await holdTracks(page);
		const { button, state, at } = playButton(page, '/albums/al3');
		try {
			// From the keyboard: the button takes no pointer clicks unless it is
			// focused or busy, since the cover's hover no longer shows it.
			await button.focus();
			await page.keyboard.press('Enter');
			await page.waitForFunction(() => document.querySelector('a.card[href="/albums/al3"] button.play .spinner'));
			assert.equal(await at(149), 2, 'the spinner and the icon each have a delay');
			assert.deepEqual(await state(), { busy: 'true', spinner: '0', glyph: '1' }, 'no spinner before 150ms');
			await at(150);
			assert.deepEqual(await state(), { busy: 'true', spinner: '1', glyph: '0' }, 'the spinner from 150ms');

			await page.keyboard.press('Enter');
			assert.equal(held.length, 1, 'the second press must not fetch again');
			release();
			await page.waitForFunction((b) => b?.getAttribute('aria-busy') === 'false', await button.elementHandle(), { timeout: 5000 });
			assert.equal((await state()).spinner, null);
			assert.equal(held.length, 1);
		} finally {
			release();
			await page.unroute('**/api/tracks');
		}
		await page.close();
		assert.deepEqual(problems, []);
	});

	test('a play answered within 150ms never shows the spinner', async () => {
		const { page, problems } = await watchedPage();
		await page.goto(app.url + '/', { waitUntil: 'networkidle' });
		const { release } = await holdTracks(page);
		const { button, state, at } = playButton(page, '/albums/al4');
		try {
			await button.focus();
			await page.keyboard.press('Enter');
			await page.waitForFunction(() => document.querySelector('a.card[href="/albums/al4"] button.play .spinner'));
			// The answer arrives at 149ms on the spinner's clock, however long the
			// runner took to get there.
			await at(149);
			assert.deepEqual(await state(), { busy: 'true', spinner: '0', glyph: '1' });
			release();
			await page.waitForFunction((b) => b?.getAttribute('aria-busy') === 'false', await button.elementHandle(), { timeout: 5000 });
			assert.deepEqual(await state(), { busy: 'false', spinner: null, glyph: '1' }, 'the play icon throughout');
		} finally {
			release();
			await page.unroute('**/api/tracks');
		}
		await page.close();
		assert.deepEqual(problems, []);
	});
});

describe('the length on the seek bar', () => {
	/*
	 * Firefox gives an MP3 transcode still arriving as a stream the length of
	 * what has arrived, 1.4s for a track of 4:36, and AAC without an index a
	 * guess 17 percent over. The bar took the element's figure, so a press on
	 * it went to the start of the track or off its end.
	 */
	test('is the file\'s own for the original, and the library\'s for a transcode the element measures otherwise', async () => {
		// Six seconds of audio for a song the library lists at 180.
		subsonic.state.audio = { type: 'audio/wav', body: silentWav(6) };
		const { page, problems } = await watchedPage();
		const length = async () => {
			await page.getByRole('button', { name: 'Play Song 1a', exact: true }).click();
			await page.waitForFunction(() => [...document.querySelectorAll('audio')].some((a) => !a.paused && a.currentTime > 0));
			return Number(await page.locator('aside.panel [role=slider][aria-label="Seek within track"]').getAttribute('aria-valuemax'));
		};
		try {
			await page.goto(app.url + '/albums/al1', { waitUntil: 'networkidle' });
			assert.equal(await length(), 6, 'the original file\'s own length is not on the bar');

			await context.request.patch(`${app.url}/api/settings`, { data: { transcode: true }, headers: { origin: app.url } });
			await page.goto(app.url + '/albums/al1', { waitUntil: 'networkidle' });
			assert.equal(await length(), 180, 'the bar spans what the element made of the transcode');
		} finally {
			subsonic.state.audio = null;
			await context.request.patch(`${app.url}/api/settings`, { data: { transcode: false }, headers: { origin: app.url } });
			await context.request.put(`${app.url}/api/play-state`, {
				data: { songIds: [], index: 0, position: 0, repeat: 'off', shuffle: false },
				headers: { origin: app.url }
			});
			await page.close();
		}
		assert.deepEqual(problems, []);
	});
});

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
	 * there started the next track at full level over the current one's last
	 * seconds. Here `volume` is made to behave that way.
	 */
	test('the next track starts when the current one ends, not over it', async () => {
		subsonic.state.audio = { type: 'audio/wav', body: silentWav(6) };
		const settings = (patch) =>
			context.request.patch(`${app.url}/api/settings`, { data: patch, headers: { origin: app.url } });
		// Within the album as well: Songs 1a and 1b follow each other on album 1,
		// which otherwise gets the tight handoff whatever the volume does.
		assert.equal(
			(await settings({ transition: 'crossfade', crossfadeSeconds: 4, crossfadeWithinAlbum: true })).status(),
			200
		);
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
			await settings({ transition: 'gapless', crossfadeWithinAlbum: false });
			subsonic.state.audio = null;
			await page.close();
		}
		assert.deepEqual(problems, []);
	});
});

/**
 * The most tracks heard at once from `/api/stream/`, sampled every 50ms from
 * the moment it is called.
 */
async function countOverlap(page) {
	await page.evaluate(() => {
		window.__together = 0;
		setInterval(() => {
			const playing = [...document.querySelectorAll('audio')].filter(
				(a) => !a.paused && a.currentTime > 0 && a.currentSrc.includes('/api/stream/')
			);
			window.__together = Math.max(window.__together, playing.length);
		}, 50);
	});
}

describe('crossfade and the album', () => {
	const settings = (patch) =>
		context.request.patch(`${app.url}/api/settings`, { data: patch, headers: { origin: app.url } });

	/** Plays Song 1a into Song 1b, the next track on the same album, and returns how many played at once. */
	async function overlapOnAlbum(setup) {
		subsonic.state.audio = { type: 'audio/wav', body: silentWav(6) };
		const { page, problems } = await watchedPage();
		try {
			if (setup) await setup(page);
			await page.goto(app.url + '/albums/al1', { waitUntil: 'networkidle' });
			await countOverlap(page);
			await page.getByRole('button', { name: 'Play Song 1a', exact: true }).click();
			await page.waitForFunction(() => document.querySelector('aside.panel h2.title')?.textContent === 'Song 1b', null, {
				timeout: 12_000
			});
			await page.waitForTimeout(500);
			assert.deepEqual(problems, []);
			return await page.evaluate(() => window.__together);
		} finally {
			subsonic.state.audio = null;
			// The context's storage outlives the page; later tests expect processing off.
			await page.evaluate(() => localStorage.removeItem('heddohon:audio-processing')).catch(() => undefined);
			await page.close();
		}
	}

	test('the next track on the same album gets the handoff, unless the fade is asked for there', async () => {
		try {
			await settings({ transition: 'crossfade', crossfadeSeconds: 3, crossfadeWithinAlbum: false });
			assert.equal(await overlapOnAlbum(), 1, 'faded into the next track on the album');
			await settings({ crossfadeWithinAlbum: true });
			assert.equal(await overlapOnAlbum(), 2, 'no crossfade with it asked for within the album');
		} finally {
			await settings({ transition: 'gapless', crossfadeWithinAlbum: false });
		}
	});

	/*
	 * With audio processing on, the ramps are gains in a Web Audio graph, which
	 * iOS applies although it ignores `volume`. `volume` is made to behave as
	 * on iOS, and the crossfade still happens.
	 */
	test('with audio processing on, a crossfade happens where `volume` is ignored', async () => {
		try {
			await settings({ transition: 'crossfade', crossfadeSeconds: 3, crossfadeWithinAlbum: true });
			const together = await overlapOnAlbum(async (page) => {
				await page.addInitScript(() => {
					localStorage.setItem('heddohon:audio-processing', JSON.stringify({ enabled: true, gains: [3, 0, 0, 0, 0, 0, 0, 0, 0, -3] }));
					Object.defineProperty(HTMLMediaElement.prototype, 'volume', { configurable: true, get: () => 1, set: () => {} });
				});
			});
			assert.equal(together, 2);
		} finally {
			await settings({ transition: 'gapless', crossfadeWithinAlbum: false });
		}
	});
});

describe('a pause, a skip and a seek through the graph', () => {
	/*
	 * The output gain cannot be read from the page, so its ramps are recorded
	 * as they are scheduled: `[target, seconds]` for each linear ramp, the only
	 * ones the duck makes (the bands and the level use `setTargetAtTime`).
	 */
	const recordRamps = (page, processing) =>
		page.addInitScript((on) => {
			if (on) localStorage.setItem('heddohon:audio-processing', JSON.stringify({ enabled: true, gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] }));
			window.__ramps = [];
			const ramp = AudioParam.prototype.linearRampToValueAtTime;
			AudioParam.prototype.linearRampToValueAtTime = function (value, end) {
				window.__ramps.push([value, Math.round((end - this.__now) * 1000)]);
				return ramp.call(this, value, end);
			};
			const set = AudioParam.prototype.setValueAtTime;
			AudioParam.prototype.setValueAtTime = function (value, at) {
				this.__now = at;
				return set.call(this, value, at);
			};
		}, processing);
	const playing = () => [...document.querySelectorAll('audio')].find((a) => !a.paused && a.currentTime > 0);
	const transport = (page, name) => page.locator('aside.panel').getByRole('button', { name, exact: true });

	async function opened(processing) {
		subsonic.state.audio = { type: 'audio/wav', body: silentWav(60) };
		const { page, problems } = await watchedPage();
		await recordRamps(page, processing);
		await page.goto(app.url + '/albums/al1', { waitUntil: 'networkidle' });
		await page.getByRole('button', { name: 'Play Song 1a', exact: true }).click();
		await page.waitForFunction(() => [...document.querySelectorAll('audio')].some((a) => !a.paused && a.currentTime > 0.3));
		return { page, problems };
	}
	async function closed(page) {
		subsonic.state.audio = null;
		await page.evaluate(() => localStorage.removeItem('heddohon:audio-processing')).catch(() => undefined);
		await page.close();
	}

	test('fade to silence over 150ms first, and a resumed track comes back up', async () => {
		const { page, problems } = await opened(true);
		try {
			// Pause: the element runs on until the output is silent.
			const atPress = await page.evaluate(async () => {
				document.querySelector('aside.panel button[aria-label="Pause"]').click();
				await new Promise((r) => setTimeout(r, 40));
				return [...document.querySelectorAll('audio')].some((a) => !a.paused);
			});
			assert.equal(atPress, true, 'still running 40ms after the press');
			await page.waitForFunction(() => [...document.querySelectorAll('audio')].every((a) => a.paused));
			assert.deepEqual(await page.evaluate(() => window.__ramps), [[0, 150]]);

			// Play: up from silence.
			await transport(page, 'Play').click();
			await page.waitForFunction(() => window.__ramps.length === 2);
			assert.deepEqual(await page.evaluate(() => window.__ramps[1]), [1, 150]);
			await page.waitForFunction(playing);

			// Seek: the bar moves at once, the element after the fade, and the sound comes back.
			await page.evaluate(() => (window.__ramps = []));
			const seek = await page.evaluate(async () => {
				const audio = [...document.querySelectorAll('audio')].find((a) => !a.paused);
				// 5 seconds on, from the keyboard.
				const bar = document.querySelector('aside.panel [aria-label="Seek within track"]');
				bar.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
				const early = audio.currentTime;
				await new Promise((r) => setTimeout(r, 400));
				return { early, late: audio.currentTime };
			});
			assert.ok(seek.early < 4, `the element had not moved at the press: ${seek.early}`);
			assert.ok(seek.late > 5, `the element moved after the fade: ${seek.late}`);
			assert.deepEqual(await page.evaluate(() => window.__ramps), [
				[0, 150],
				[1, 150]
			]);

			// Skip: the next track loads after the fade and starts at full level.
			await page.evaluate(() => (window.__ramps = []));
			await transport(page, 'Next track').click();
			await page.waitForFunction(() => document.querySelector('aside.panel h2.title')?.textContent === 'Song 1b');
			await page.waitForFunction(playing);
			assert.deepEqual(await page.evaluate(() => window.__ramps), [[0, 150]], 'down for the skip, and not ramped up under the new track');
		} finally {
			await closed(page);
		}
		assert.deepEqual(problems, []);
	});

	test('without the graph a pause is immediate', async () => {
		const { page, problems } = await opened(false);
		try {
			const paused = await page.evaluate(() => {
				document.querySelector('aside.panel button[aria-label="Pause"]').click();
				return [...document.querySelectorAll('audio')].every((a) => a.paused);
			});
			assert.equal(paused, true);
			assert.deepEqual(await page.evaluate(() => window.__ramps), []);
		} finally {
			await closed(page);
		}
		assert.deepEqual(problems, []);
	});
});

describe('what the system is told the page plays', () => {
	/*
	 * Safari's Audio Session API, which no browser the suite runs has: a stand-in
	 * is put on `navigator` before the page loads. On an iPhone the type decides
	 * whether a Web Audio graph is suspended when the app leaves the screen.
	 */
	test('is playback, set before anything plays and left alone where the browser has no such setting', async () => {
		const { page, problems } = await watchedPage();
		await page.addInitScript(() => {
			const written = [];
			let type = 'auto';
			Object.defineProperty(navigator, 'audioSession', {
				value: {
					get type() {
						return type;
					},
					set type(value) {
						written.push(value);
						type = value;
					}
				}
			});
			window.__audioSessionTypes = written;
		});
		await page.goto(app.url + '/albums/al1', { waitUntil: 'networkidle' });
		assert.deepEqual(await page.evaluate(() => window.__audioSessionTypes), ['playback']);
		assert.equal(await page.evaluate(() => navigator.audioSession.type), 'playback');
		await page.close();

		// Without it, as in Chromium and Firefox, nothing is written and nothing fails.
		const plain = await watchedPage();
		await plain.page.goto(app.url + '/albums/al1', { waitUntil: 'networkidle' });
		assert.equal(await plain.page.evaluate(() => 'audioSession' in navigator), false);
		await plain.page.close();
		assert.deepEqual([...problems, ...plain.problems], []);
	});

	test('a graph the system stopped while the page was away starts again when the page is back', async () => {
		const { page, problems } = await watchedPage();
		await page.addInitScript(() => {
			localStorage.setItem('heddohon:audio-processing', JSON.stringify({ enabled: true, gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] }));
			const Native = window.AudioContext;
			window.__contexts = [];
			window.AudioContext = class extends Native {
				constructor(...args) {
					super(...args);
					window.__contexts.push(this);
				}
			};
		});
		subsonic.state.audio = { type: 'audio/wav', body: silentWav(30) };
		try {
			await page.goto(app.url + '/albums/al1', { waitUntil: 'networkidle' });
			await page.getByRole('button', { name: 'Play Song 1a', exact: true }).click();
			await page.waitForFunction(() => [...document.querySelectorAll('audio')].some((a) => !a.paused && a.currentTime > 0.2), null, { timeout: 5000 });
			assert.equal(await page.evaluate(() => window.__contexts.length), 1);
			assert.equal(await page.evaluate(() => window.__contexts[0].state), 'running');

			// What iOS does to it with the app in the background: the graph stops
			// and the element goes on, with a position and no sound.
			await page.evaluate(() => window.__contexts[0].suspend());
			assert.equal(await page.evaluate(() => window.__contexts[0].state), 'suspended');
			assert.ok(await page.evaluate(() => [...document.querySelectorAll('audio')].some((a) => !a.paused)));

			await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
			await page.waitForFunction(() => window.__contexts[0].state === 'running', null, { timeout: 5000 });
		} finally {
			subsonic.state.audio = null;
			await page.evaluate(() => localStorage.removeItem('heddohon:audio-processing')).catch(() => undefined);
			await page.close();
		}
		assert.deepEqual(problems, []);
	});
});

describe('the equaliser', () => {
	test('is off until switched on, then kept in this browser with its bands', async () => {
		const { page, problems } = await watchedPage();
		try {
			await page.goto(app.url + '/settings?tab=playback', { waitUntil: 'networkidle' });
			const toggle = page.getByRole('switch', { name: /^Process audio/ });
			assert.equal(await toggle.isChecked(), false);
			assert.equal(await page.getByRole('group', { name: 'Equaliser bands' }).count(), 0);

			await toggle.check();
			await pick(page.getByRole('combobox', { name: 'Equaliser' }), 'bass');
			const band = page.getByRole('slider', { name: '31Hz, in dB' });
			assert.equal(await sliderValue(band), '6');
			await setSlider(band, -4, { min: -12 });
			assert.equal(await shown(page.getByRole('combobox', { name: 'Equaliser' })), 'Custom', 'bands set by hand read as Custom');
			const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('heddohon:audio-processing')));
			assert.deepEqual(saved, { enabled: true, gains: [-4, 5, 4, 2, 0, 0, 0, 0, 0, 0] });

			await page.reload({ waitUntil: 'networkidle' });
			assert.equal(await sliderValue(page.getByRole('slider', { name: '31Hz, in dB' })), '-4');

			await page.getByRole('switch', { name: /^Process audio/ }).uncheck();
			const off = await page.evaluate(() => JSON.parse(localStorage.getItem('heddohon:audio-processing')));
			assert.equal(off.enabled, false);
			assert.deepEqual(off.gains, [-4, 5, 4, 2, 0, 0, 0, 0, 0, 0], 'the bands are kept for the next time');
		} finally {
			await page.evaluate(() => localStorage.removeItem('heddohon:audio-processing')).catch(() => undefined);
			await page.close();
		}
		assert.deepEqual(problems, []);
	});
});

describe('the quality badge in the player', () => {
	test('names what changed the audio and opens the path, which holds the transcoding switch', async () => {
		const origin = { origin: app.url };
		await context.request.patch(`${app.url}/api/settings`, { headers: origin, data: { transcode: false, showQualityBadge: true } });
		const visit = await browser.newContext({ viewport: { width: 1440, height: 900 } });
		await visit.request.post(`${app.url}/login`, {
			form: { username: 'testuser', password: 'testpass', backend: 'subsonic', next: '/' },
			headers: { ...origin, accept: 'text/html' },
			maxRedirects: 0
		});
		const page = await visit.newPage();
		const problems = [];
		page.on('pageerror', (err) => problems.push(err.message));
		const badge = page.locator('aside.panel button.badge');
		const path = page.getByRole('dialog', { name: "What you're hearing" });
		const changed = () => badge.evaluate((node) => node.classList.contains('changed'));
		try {
			await page.goto(app.url + '/albums/al1', { waitUntil: 'networkidle' });
			await page.locator('.details .hh-button--primary').click();
			await badge.waitFor();
			assert.match(await badge.textContent(), /^\s*FLAC [\d.]+\/[\d.]+\s*$/);
			assert.equal(await changed(), false, 'the original file read as changed');

			await badge.click();
			await path.waitFor();
			assert.match(await path.textContent(), /Sends the file as it is[\s\S]*Plays it as received/);
			await path.getByRole('button', { name: 'Transcode to save data' }).click();
			await path.waitFor({ state: 'hidden' });
			await page.waitForFunction(() => /FLAC\s*→/.test(document.querySelector('aside.panel button.badge')?.textContent ?? ''));
			assert.equal(await changed(), true, 'a conversion read as the original');
			assert.equal((await (await visit.request.get(`${app.url}/api/settings`)).json()).transcode, true);

			await badge.click();
			assert.match(await path.textContent(), /Converts to \w+ at \d+ kbps/);
			await path.getByRole('button', { name: 'Send the original' }).click();
			await page.waitForFunction(() => !/→/.test(document.querySelector('aside.panel button.badge')?.textContent ?? ''));
			assert.equal((await (await visit.request.get(`${app.url}/api/settings`)).json()).transcode, false);

			// Through the graph: headless Chromium's output is 44.1 kHz, the file's
			// own rate, so the badge names the equaliser without an arrow.
			await page.evaluate(() => localStorage.setItem('heddohon:audio-processing', JSON.stringify({ enabled: true, gains: [2, 0, 0, 0, 0, 0, 0, 0, 0, 0] })));
			await page.reload({ waitUntil: 'networkidle' });
			await page.locator('.details .hh-button--primary').click();
			await page.waitForFunction(() => /· EQ\s*$/.test(document.querySelector('aside.panel button.badge')?.textContent ?? ''));
			assert.equal(await changed(), true, 'the equaliser read as the original');
			await badge.click();
			assert.match(await path.textContent(), /Equaliser on/);
			assert.equal(await path.getByRole('link', { name: 'Audio processing' }).getAttribute('href'), '/settings?tab=playback#this-browser');
		} finally {
			await context.request.patch(`${app.url}/api/settings`, { headers: origin, data: { transcode: false } });
			await visit.close();
		}
		assert.deepEqual(problems, []);
	});
});

describe('the visualiser', () => {
	/** Eight seconds of a 440 Hz tone, so the analyser has something to show. */
	const toneWav = () => {
		const wav = silentWav(8);
		for (let i = 44; i < wav.length; i++) wav[i] = 128 + Math.round(100 * Math.sin((2 * Math.PI * 440 * (i - 44)) / 8000));
		return wav;
	};
	/** Whether the canvas under `selector` has a pixel drawn on it. */
	const drawn = (selector) => {
		const canvas = document.querySelector(selector);
		const context = canvas?.getContext('2d');
		return !!context && context.getImageData(0, 0, canvas.width, canvas.height).data.some((value, i) => i % 4 === 3 && value > 0);
	};

	test('is drawn from the graph only where processing and the visualiser are on, and not with reduced motion', async () => {
		const { page, problems } = await watchedPage();
		await page.addInitScript(() => {
			if (!sessionStorage.getItem('seeded')) {
				sessionStorage.setItem('seeded', '1');
				localStorage.setItem('heddohon:audio-processing', JSON.stringify({ enabled: true, gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] }));
			}
		});
		subsonic.state.audio = { type: 'audio/wav', body: toneWav() };
		try {
			await page.goto(app.url + '/settings?tab=playback', { waitUntil: 'networkidle' });
			const toggle = page.getByRole('switch', { name: /^Visualiser/ });
			assert.equal(await toggle.isChecked(), false, 'off by default');
			await toggle.check();
			assert.equal((await page.evaluate(() => JSON.parse(localStorage.getItem('heddohon:audio-processing')))).visualiser, true);

			// Song 7a: the screen asks for the lyrics of what plays, and the server keeps the answer,
			// which would leave a song another test gives lyrics to without them.
			await page.goto(app.url + '/albums/al7', { waitUntil: 'networkidle' });
			await page.getByRole('button', { name: 'Play Song 7a', exact: true }).click();
			await page.waitForFunction(drawn, 'aside.panel canvas.visualiser', { timeout: 5000 });
			assert.equal(await page.locator('aside.panel canvas.visualiser').getAttribute('aria-hidden'), 'true');

			await page.emulateMedia({ reducedMotion: 'reduce' });
			await page.locator('canvas.visualiser').waitFor({ state: 'detached' });
			await page.emulateMedia({ reducedMotion: 'no-preference' });

			// The living-room screen, reached without a page load so the tone plays on.
			await page.locator('nav.rail a[href="/screen"]').click();
			await page.waitForURL(/\/screen$/);
			await page.waitForFunction(drawn, '.screen canvas.visualiser', { timeout: 5000 });
		} finally {
			subsonic.state.audio = null;
			await page.evaluate(() => localStorage.removeItem('heddohon:audio-processing')).catch(() => undefined);
			await page.close();
		}
		assert.deepEqual(problems, []);
	});

	test('is not drawn while audio processing is off', async () => {
		const { page, problems } = await watchedPage();
		await page.addInitScript(() => {
			localStorage.setItem('heddohon:audio-processing', JSON.stringify({ enabled: false, gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], visualiser: true }));
		});
		subsonic.state.audio = { type: 'audio/wav', body: toneWav() };
		try {
			await page.goto(app.url + '/albums/al1', { waitUntil: 'networkidle' });
			await page.getByRole('button', { name: 'Play Song 1a', exact: true }).click();
			await page.waitForFunction(() => [...document.querySelectorAll('audio')].some((a) => !a.paused && a.currentTime > 0.3), null, { timeout: 5000 });
			assert.equal(await page.locator('canvas.visualiser').count(), 0);
		} finally {
			subsonic.state.audio = null;
			await page.evaluate(() => localStorage.removeItem('heddohon:audio-processing')).catch(() => undefined);
			await page.close();
		}
		assert.deepEqual(problems, []);
	});
});

describe('the install card', () => {
	const settings = (patch) => context.request.patch(`${app.url}/api/settings`, { data: patch, headers: { origin: app.url } });
	const card = (page) => page.locator('aside[aria-label="Install the app"]');
	const RELEASES = 'https://github.com/zorcerer/heddohon/releases/latest';
	/** Chrome's `beforeinstallprompt`, which headless Chromium does not fire by itself. */
	const offerInstall = (page) =>
		page.evaluate(() => {
			const event = new Event('beforeinstallprompt', { cancelable: true });
			event.prompt = async () => {
				window.__prompted = (window.__prompted ?? 0) + 1;
			};
			event.userChoice = Promise.resolve({ outcome: 'dismissed' });
			window.dispatchEvent(event);
		});
	const play = async (page) => {
		await page.getByRole('button', { name: 'Play Song 1a', exact: true }).click();
		await page.waitForFunction(() => [...document.querySelectorAll('audio')].some((a) => !a.paused && a.currentTime > 0));
	};
	/** A context of its own with this user agent, signed in. */
	async function signedIn(userAgent) {
		const view = await browser.newContext({ viewport: { width: 1440, height: 900 }, userAgent });
		const signIn = await view.request.post(`${app.url}/login`, {
			form: { username: 'testuser', password: 'testpass', backend: 'subsonic', next: '/' },
			headers: { origin: app.url, accept: 'text/html' },
			maxRedirects: 0
		});
		assert.equal(signIn.status(), 303);
		return view;
	}

	before(async () => {
		subsonic.state.audio = { type: 'audio/wav', body: silentWav(30) };
		assert.equal((await settings({ installCardDismissed: false })).status(), 200);
	});

	after(async () => {
		subsonic.state.audio = null;
		// Off again for the rest of the suite, where it would sit over the content.
		await settings({ installCardDismissed: true });
	});

	// The suite's own browser is Chromium on Linux, which is pointed at the AppImage.
	test('on Linux, waits for something to play, points at the release and not at the browser\'s install, and stays away once dismissed', async () => {
		const { page, problems } = await watchedPage();
		try {
			await page.goto(app.url + '/albums/al1', { waitUntil: 'networkidle' });
			await page.waitForTimeout(300);
			assert.equal(await card(page).count(), 0, 'not before anything plays');

			await play(page);
			await card(page).waitFor();
			assert.match(await card(page).innerText(), /^Heddohon for Linux$/m);
			const link = card(page).getByRole('link', { name: 'Get the app' });
			assert.deepEqual(
				await link.evaluate((a) => [a.href, a.target, a.rel]),
				[RELEASES, '_blank', 'noopener noreferrer']
			);
			// The browser offering to install the page changes nothing here.
			await offerInstall(page);
			await page.waitForTimeout(200);
			assert.equal(await card(page).getByRole('button', { name: 'Install', exact: true }).count(), 0);

			await card(page).getByRole('button', { name: 'Not now' }).click();
			await card(page).waitFor({ state: 'detached' });
			await putAway();

			await page.reload({ waitUntil: 'networkidle' });
			await play(page);
			await page.waitForTimeout(300);
			assert.equal(await card(page).count(), 0, 'dismissed on the account');

			// Settings still has it.
			await page.goto(app.url + '/settings?tab=appearance', { waitUntil: 'networkidle' });
			assert.equal(await page.locator('#install').getByRole('link', { name: 'Get the app' }).getAttribute('href'), RELEASES);
		} finally {
			await settings({ installCardDismissed: false });
			await page.close();
		}
		assert.deepEqual(problems, []);
	});

	const installedMark = (page) => page.evaluate(() => localStorage.getItem('heddohon:installed'));
	const dismissedOnAccount = async () => (await (await context.request.get(`${app.url}/api/settings`)).json()).installCardDismissed;
	/** Waits for the card to be put away on the account. Asked from here: `waitForFunction` takes the promise of an async predicate as true at once. */
	async function putAway() {
		for (let i = 0; i < 100; i++) {
			if (await dismissedOnAccount()) return;
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		assert.fail('the card was not put away on the account');
	}
	/** Puts back what a test of an installed app leaves: the mark in this browser, and the account's setting. */
	async function forget(page) {
		await page.evaluate(() => localStorage.removeItem('heddohon:installed')).catch(() => undefined);
		await settings({ installCardDismissed: false });
	}

	test('is not shown in the installed app, which marks this browser and puts the card away on the account', async () => {
		// Each of the display modes an installed app runs in.
		for (const mode of ['standalone', 'window-controls-overlay']) {
			const { page, problems } = await watchedPage();
			try {
				await page.addInitScript((mode) => {
					const real = window.matchMedia.bind(window);
					window.matchMedia = (query) =>
						query === `(display-mode: ${mode})` ? { ...real(query), matches: true, media: query } : real(query);
				}, mode);
				await page.goto(app.url + '/albums/al1', { waitUntil: 'networkidle' });
				await play(page);
				await page.waitForTimeout(300);
				assert.equal(await card(page).count(), 0, mode);
				assert.equal(await installedMark(page), '1', mode);
				assert.equal(await dismissedOnAccount(), true, mode);
			} finally {
				await forget(page);
				await page.close();
			}
			assert.deepEqual(problems, []);
		}
	});

	test('is not shown in a tab of a browser where the app is installed, and Settings still offers it', async () => {
		const marked = (page) => page.addInitScript(() => localStorage.setItem('heddohon:installed', '1'));
		const told = (page) => page.addInitScript(() => (navigator.getInstalledRelatedApps = async () => [{ platform: 'webapp' }]));
		for (const [name, setup] of [['marked by the app', marked], ['reported by the browser', told]]) {
			const { page, problems } = await watchedPage();
			try {
				await setup(page);
				await page.goto(app.url + '/albums/al1', { waitUntil: 'networkidle' });
				await play(page);
				await page.waitForTimeout(300);
				assert.equal(await card(page).count(), 0, name);
				assert.equal(await installedMark(page), '1', name);
				assert.equal(await dismissedOnAccount(), false, `${name}: a tab does not put the card away on the account`);

				await page.goto(app.url + '/settings?tab=appearance', { waitUntil: 'networkidle' });
				await page.locator('#install').getByRole('link', { name: 'Get the app' }).waitFor();
			} finally {
				await page.close();
				// A page of its own for the clean-up: the first one sets the mark again on every load.
				const tidy = await context.newPage();
				await tidy.goto(app.url + '/healthz');
				await forget(tidy);
				await tidy.close();
			}
			assert.deepEqual(problems, []);
		}
	});

	test('is not shown in the Android app: opened with its query or as the referrer, and on the pages the tab loads afterwards', async () => {
		const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36';
		const opens = {
			'with the query': (page) => page.goto(app.url + '/?app=android', { waitUntil: 'networkidle' }),
			// Chromium keeps an `android-app:` referrer on Android only, so the first page is told it here.
			'as the referrer': async (page) => {
				await page.addInitScript(() => {
					if (location.pathname === '/') Object.defineProperty(document, 'referrer', { get: () => 'android-app://app.heddohon.android/' });
				});
				await page.goto(app.url + '/', { waitUntil: 'networkidle' });
			}
		};
		for (const [name, open] of Object.entries(opens)) {
			const view = await signedIn(ANDROID);
			const page = await view.newPage();
			try {
				await open(page);
				await putAway();
				// A whole page load later, with neither the query nor the referrer.
				await page.goto(app.url + '/albums/al1', { waitUntil: 'networkidle' });
				await play(page);
				await page.waitForTimeout(300);
				assert.equal(await card(page).count(), 0, `${name}: the card`);
				await page.goto(app.url + '/settings?tab=appearance', { waitUntil: 'networkidle' });
				await page.locator('#install').getByText('You are using the app.').waitFor();
				assert.equal(await page.locator('#install').getByRole('link').count(), 0, `${name}: the link in Settings`);
			} finally {
				await view.close();
				await settings({ installCardDismissed: false });
			}
		}
	});

	test('each system is offered its own way: our app on Windows, Linux and Android, the browser\'s install on a Mac, an iPhone and an iPad', async () => {
		const CHROME = 'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
		const SAFARI = (version) => `AppleWebKit/605.1.15 (KHTML, like Gecko) Version/${version} Safari/605.1.15`;
		/** [user agent, the browser offers its own install, what the card should hold] */
		const cases = {
			'Chrome on Windows': [`Mozilla/5.0 (Windows NT 10.0; Win64; x64) ${CHROME}`, true, { text: /for Windows/, link: 'Get the app', install: false }],
			'Firefox on Windows': ['Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0', false, { text: /for Windows/, link: 'Get the app', install: false }],
			'Firefox on Linux': ['Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0', false, { text: /for Linux/, link: 'Get the app', install: false }],
			'Chrome on Android': [`Mozilla/5.0 (Linux; Android 14; Pixel 8) ${CHROME.replace('Safari', 'Mobile Safari')}`, false, { text: /for Android/, link: 'Get the APK', install: false }],
			'Chrome on Android, offering to install': [`Mozilla/5.0 (Linux; Android 14; Pixel 8) ${CHROME.replace('Safari', 'Mobile Safari')}`, true, { text: /for Android/, link: 'Get the APK', install: true }],
			'Chrome on a Mac, offering to install': [`Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ${CHROME}`, true, { text: /Install Heddohon/, link: null, install: true }],
			'Chrome on a Mac, not offering': [`Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ${CHROME}`, false, null],
			'Edge on a Mac, not offering': [`Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ${CHROME} Edg/140.0.0.0`, false, { text: /choose Apps, then Install this site as an app/, link: null, install: false }],
			'Safari 18 on a Mac': [`Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ${SAFARI('18.0')}`, false, { text: /File, then Add to Dock/, link: null, install: false }],
			'Safari 16 on a Mac': [`Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ${SAFARI('16.6')}`, false, null],
			'Firefox on a Mac': ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:140.0) Gecko/20100101 Firefox/140.0', false, null],
			'Safari on an iPhone': ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1', false, { text: /Share, then Add to Home Screen/, link: null, install: false }],
			'Chrome on an iPhone': ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/128.0.6613.98 Mobile/15E148 Safari/604.1', false, null],
			'ChromeOS, offering to install': [`Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) ${CHROME}`, true, { text: /Install Heddohon/, link: null, install: true }],
			// Inside our own desktop app, which names itself.
			'the desktop app': [`Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) heddohon-desktop/0.5.0 Chrome/140.0.0.0 Electron/44.5.1 Safari/537.36`, false, null]
		};
		for (const [name, [userAgent, offering, expected]] of Object.entries(cases)) {
			const view = await signedIn(userAgent);
			const page = await view.newPage();
			try {
				await page.goto(app.url + '/albums/al1', { waitUntil: 'networkidle' });
				if (offering) await offerInstall(page);
				await play(page);
				await page.waitForTimeout(300);
				if (expected === null) {
					assert.equal(await card(page).count(), 0, name);
					continue;
				}
				assert.match(await card(page).innerText(), expected.text, name);
				const links = card(page).getByRole('link');
				assert.deepEqual(await links.evaluateAll((all) => all.map((a) => [a.textContent.trim(), a.href])), expected.link ? [[expected.link, RELEASES]] : [], name);
				assert.equal(await card(page).getByRole('button', { name: 'Install', exact: true }).count(), expected.install ? 1 : 0, name);
			} finally {
				await view.close();
				// The desktop app marks the account as using the app; the next system starts as the first did.
				await settings({ installCardDismissed: false });
			}
		}
	});
});
