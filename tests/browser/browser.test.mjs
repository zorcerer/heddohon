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
import { HD650_PARAMETRIC, startAutoEq, startJellyfin, startStationHost, startSubsonic } from '../e2e/mocks.mjs';

let subsonic;
let jellyfin;
let app;
let browser;
let context;

before(async () => {
	subsonic = await startSubsonic({ artistCount: 40 });
	jellyfin = await startJellyfin();
	// An open event stream keeps a page from ever reaching `networkidle`, which
	// most tests here wait for; the remote control has its own app below.
	app = await startApp({ subsonicUrl: subsonic.url, jellyfinUrl: jellyfin.url, env: { HEDDOHON_REMOTE_CONTROL: 'false' } });
	// Fake capture devices, so the output control's microphone request (Chrome
	// names outputs only once it is granted) resolves without a real one.
	browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
	context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
	const signIn = await context.request.post(`${app.url}/login`, {
		form: { username: 'testuser', password: 'testpass', backend: 'subsonic', next: '/' },
		headers: { origin: app.url, accept: 'text/html' },
		maxRedirects: 0
	});
	assert.equal(signIn.status(), 303);
	// The install card sits over the foot of the content once something plays,
	// in a browser that offers to install; its own tests turn it back on.
	await context.request.patch(`${app.url}/api/settings`, { data: { installCardDismissed: true }, headers: { origin: app.url } });
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
			'/folders',
			'/folders/d-al1',
			'/history',
			'/screen',
			'/stats',
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
		// Album 3, which no test before this one opens: an album read in the last
		// minute is held (`details.ts`), and its play would be answered at once.
		const card = page.locator('a.card[href="/albums/al3"]:has(button.play)').first();
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

		// Not hovered, since hovering preloads the album page. The wait stays: the
		// timings below are measured from a settled page, and on a CI runner a
		// page just loaded let 60ms stretch past the 150ms.
		await page.waitForTimeout(600);
		subsonic.state.delays.set('getAlbum', 1500);
		subsonic.calls.reset();
		try {
			// From the keyboard: the button takes no pointer clicks unless it is
			// focused or busy, since the cover's hover no longer shows it.
			await button.focus();
			await page.keyboard.press('Enter');
			await page.waitForTimeout(60);
			// The button fades in on the press, so its own opacity is checked at the
			// next step, once the fade is over.
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
		// Hovering preloads the album page. A click while that was loading put the
		// tracks request behind it, past 150ms on a CI runner once, and the spinner
		// showed.
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

describe('the equaliser', () => {
	test('is off until switched on, then kept in this browser with its bands', async () => {
		const { page, problems } = await watchedPage();
		try {
			await page.goto(app.url + '/settings?tab=playback', { waitUntil: 'networkidle' });
			const toggle = page.getByRole('checkbox', { name: /Process audio in this browser/ });
			assert.equal(await toggle.isChecked(), false);
			assert.equal(await page.getByRole('group', { name: 'Equaliser bands' }).count(), 0);

			await toggle.check();
			await page.getByRole('combobox', { name: 'Preset' }).selectOption('bass');
			const band = page.getByRole('slider', { name: '31Hz, in dB' });
			assert.equal(await band.inputValue(), '6');
			await band.fill('-4');
			assert.equal(await page.getByRole('combobox', { name: 'Preset' }).inputValue(), '', 'bands set by hand read as Custom');
			const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('heddohon:audio-processing')));
			assert.deepEqual(saved, { enabled: true, gains: [-4, 5, 4, 2, 0, 0, 0, 0, 0, 0] });

			await page.reload({ waitUntil: 'networkidle' });
			assert.equal(await page.getByRole('slider', { name: '31Hz, in dB' }).inputValue(), '-4');

			await page.getByRole('checkbox', { name: /Process audio in this browser/ }).uncheck();
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
			assert.match(await card(page).innerText(), /Heddohon for Linux: an AppImage, with the latest release\./);
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
			'Chrome on Windows': [`Mozilla/5.0 (Windows NT 10.0; Win64; x64) ${CHROME}`, true, { text: /for Windows: an installer or a portable \.exe/, link: 'Get the app', install: false }],
			'Firefox on Windows': ['Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0', false, { text: /for Windows/, link: 'Get the app', install: false }],
			'Firefox on Linux': ['Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0', false, { text: /for Linux: an AppImage/, link: 'Get the app', install: false }],
			'Chrome on Android': [`Mozilla/5.0 (Linux; Android 14; Pixel 8) ${CHROME.replace('Safari', 'Mobile Safari')}`, false, { text: /for Android: an APK to install/, link: 'Get the APK', install: false }],
			'Chrome on Android, offering to install': [`Mozilla/5.0 (Linux; Android 14; Pixel 8) ${CHROME.replace('Safari', 'Mobile Safari')}`, true, { text: /for Android/, link: 'Get the APK', install: true }],
			'Chrome on a Mac, offering to install': [`Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ${CHROME}`, true, { text: /Install Heddohon as an app/, link: null, install: true }],
			'Chrome on a Mac, not offering': [`Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ${CHROME}`, false, null],
			'Edge on a Mac, not offering': [`Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ${CHROME} Edg/140.0.0.0`, false, { text: /choose Apps, then Install this site as an app/, link: null, install: false }],
			'Safari 18 on a Mac': [`Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ${SAFARI('18.0')}`, false, { text: /File, then Add to Dock/, link: null, install: false }],
			'Safari 16 on a Mac': [`Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ${SAFARI('16.6')}`, false, null],
			'Firefox on a Mac': ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:140.0) Gecko/20100101 Firefox/140.0', false, null],
			'Safari on an iPhone': ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1', false, { text: /Share, then Add to Home Screen/, link: null, install: false }],
			'Chrome on an iPhone': ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/128.0.6613.98 Mobile/15E148 Safari/604.1', false, null],
			'ChromeOS, offering to install': [`Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) ${CHROME}`, true, { text: /Install Heddohon as an app/, link: null, install: true }],
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
			await page.getByRole('checkbox', { name: /Process audio in this browser/ }).check();
			assert.equal(await page.getByRole('searchbox', { name: 'Search headphones' }).count(), 0, 'no search where the database is off');
			assert.equal(await page.evaluate(() => window.__biquads), 10);

			// The bands, set before the correction: 31 Hz is the first biquad made.
			const band = page.getByRole('slider', { name: '31Hz, in dB' });
			const preset = page.getByRole('combobox', { name: 'Preset' });
			const inGraph = (db) => page.waitForFunction((want) => Math.abs(window.__filters[0].gain.value - want) < 0.05, db);
			await preset.selectOption('bass');
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
			assert.equal(await band.inputValue(), '6');
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
			await page.getByRole('checkbox', { name: /Process audio in this browser/ }).check();

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
			const before = await page.evaluate(() => [...document.querySelectorAll('audio')].find((a) => !a.paused).currentTime);
			await panel.getByRole('slider', { name: 'Seek within track' }).press('End');
			await page.waitForTimeout(300);
			const after = await page.evaluate(() => [...document.querySelectorAll('audio')].find((a) => !a.paused).currentTime);
			assert.ok(after >= before && after < before + 2, `${before} to ${after}`);

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
	test('on the home page, the account button and Shuffle something do not overlap', async () => {
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
					return { account: box('.masthead .account'), shuffle: box('.masthead .shuffle'), title: box('.masthead h1'), width: innerWidth };
				});
				const apart = (a, b) => a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top;
				const at = `${viewport.width}px`;
				assert.ok(apart(boxes.account, boxes.shuffle), `${at}: ${JSON.stringify(boxes)}`);
				assert.ok(apart(boxes.account, boxes.title), `${at}: the title runs under the account button`);
				assert.ok(boxes.shuffle.right <= boxes.width, `${at}: Shuffle something runs off the screen`);
			} finally {
				await phone.close();
			}
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
		try {
			await page.goto(app.url + '/albums/al33', { waitUntil: 'networkidle' });
			await page.getByRole('button', { name: 'Play Song 33a', exact: true }).click();
			await page.waitForFunction(() => [...document.querySelectorAll('audio')].some((a) => !a.paused && a.currentTime > 0));
			// The colour eases for 900ms, and the bar is written again once it has landed.
			await page.waitForTimeout(2200);
			const dark = await seen();
			assert.deepEqual(dark.meta, dark.canvas, 'the bar is the canvas colour');
			assert.notEqual(dark.hex, '#0b0c0f', 'and no longer the bare ground');
			assert.ok(dark.meta[0] > dark.meta[2] + 8, `lit by a red cover: ${dark.hex}`);

			await settings({ theme: 'light' });
			await page.goto(app.url + '/albums/al33', { waitUntil: 'networkidle' });
			await page.waitForTimeout(1500);
			const light = await seen();
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
				() => [...document.querySelectorAll('audio')].some((a) => !a.paused && a.currentTime > 0),
				null,
				{ timeout: 15_000 }
			);
			const at = await page.evaluate(() =>
				Math.max(...[...document.querySelectorAll('audio')].filter((a) => !a.paused).map((a) => a.currentTime))
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
	test('says when there is nothing similar, and otherwise plays the mix', async () => {
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
			await page.getByText('Share an album').waitFor();
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
	test('a queue played in order turns it off, and the saved state says so', async () => {
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
			await page.waitForTimeout(250);
			// It jumped straight to 1.2: the arrival animation, filled forwards,
			// held `scale` and the transition never ran.
			const midway = await read();
			assert.ok(midway.scale > 1.14 && midway.scale < 1.195, `the zoom snapped to ${midway.scale}`);
			assert.ok(midway.shade > 0.8 && midway.shade < 1, `the shade did not fade (${midway.shade})`);
			await page.waitForTimeout(1500);
			assert.deepEqual(await read(), { scale: 1.2, shade: 0.8 });
		} finally {
			await page.close();
		}
		assert.deepEqual(problems, []);
	});
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

describe('the heart in the player', () => {
	/*
	 * The player keeps one heart and hands it each new song. When it kept the
	 * state from the last press, a song starred in the player showed as starred
	 * on every song after it.
	 */
	test('follows the song on a skip, and agrees with the track row', async () => {
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

	before(async () => {
		remoteApp = await startApp({ subsonicUrl: subsonic.url, jellyfinUrl: jellyfin.url });
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

	test('a visitor with no account joins, follows a skip and a pause, and a reaction reaches the host', async () => {
		const { page: hostPage, problems } = await signedInPage();
		const guestContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
		browsers.push(guestContext);
		const guest = await guestContext.newPage();
		const guestAudio = () =>
			guest.evaluate(() => {
				const a = document.querySelector('audio.together-audio');
				return { src: a?.getAttribute('src') ?? '', paused: a?.paused ?? true, time: a?.currentTime ?? 0 };
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
			const hostTime = await hostPage.evaluate(() => [...document.querySelectorAll('audio')].find((a) => !a.paused)?.currentTime ?? 0);
			assert.ok(Math.abs(joined.time - hostTime) < 1.5, `the guest is at ${joined.time}, the host at ${hostTime}`);
			await hostPage.locator('aside.panel .live', { hasText: '1 listening' }).waitFor({ timeout: 5000 });

			await hostPage.locator('aside.panel button.step').nth(1).click();
			await guest.locator('h1', { hasText: 'Song 17b' }).waitFor({ timeout: 5000 });
			await guest.waitForFunction(() => /\?song=s17b$/.test(document.querySelector('audio.together-audio')?.getAttribute('src') ?? ''), null, { timeout: 5000 });

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

describe('folders', () => {
	test('are opened from the rail down to an album\'s folder, played, and left by the trail', async () => {
		const { page, problems } = await watchedPage();
		try {
			await page.goto(app.url + '/', { waitUntil: 'networkidle' });
			await page.locator('nav.rail a[href="/folders"]').click();
			await page.waitForURL(/\/folders$/);
			await page.locator('ul.folders').getByRole('link', { name: 'Artist 0006' }).click();
			await page.waitForURL(/\/folders\/d-ar6$/);
			await page.locator('ul.folders').getByRole('link', { name: 'Album 6' }).click();
			await page.waitForURL(/\/folders\/d-al6$/);
			await page.waitForFunction(() => document.querySelector('main h1')?.textContent === 'Album 6');

			await page.getByRole('button', { name: 'Play the tracks in this folder' }).click();
			await page.waitForFunction(() => document.querySelector('aside.panel h2.title')?.textContent === 'Song 6a');

			await page.locator('nav.trail').getByRole('link', { name: 'Artist 0006' }).click();
			await page.waitForURL(/\/folders\/d-ar6$/);
			// The page changed in place: the music is still on the same track.
			assert.equal(await page.locator('aside.panel h2.title').textContent(), 'Song 6a');
		} finally {
			await page.close();
		}
		assert.deepEqual(problems, []);
	});
});

describe('star ratings', () => {
	test('the album and the playing song are rated with a press, and the player\'s stars follow the song', async () => {
		const { page, problems } = await watchedPage();
		const rated = () => page.waitForResponse((r) => r.url().endsWith('/api/rating'));
		const hero = page.locator('header.hero .stars');
		const panel = page.locator('aside.panel .facts .stars');
		try {
			await page.goto(app.url + '/albums/al5', { waitUntil: 'networkidle' });
			assert.equal(await hero.getAttribute('aria-label'), 'Not rated');
			let saved = rated();
			await hero.getByRole('button', { name: 'Rate 3 of 5' }).click();
			await saved;
			assert.equal(await hero.getAttribute('aria-label'), 'Rated 3 of 5');
			assert.equal(subsonic.state.ratings.get('al5'), 3);

			await page.getByRole('button', { name: 'Play Song 5a', exact: true }).click();
			await page.waitForFunction(() => document.querySelector('aside.panel h2.title')?.textContent === 'Song 5a');
			await page.getByRole('button', { name: 'Track details' }).click();
			saved = rated();
			await panel.getByRole('button', { name: 'Rate 5 of 5' }).click();
			await saved;
			assert.equal(subsonic.state.ratings.get('s5a'), 5);

			await page.locator('aside.panel button.step').nth(1).click();
			await page.waitForFunction(() => document.querySelector('aside.panel h2.title')?.textContent === 'Song 5b');
			assert.equal(await panel.getAttribute('aria-label'), 'Not rated', 'the next song showed the last song\'s stars');
			await page.locator('aside.panel button.step').nth(0).click();
			await page.waitForFunction(() => document.querySelector('aside.panel h2.title')?.textContent === 'Song 5a');
			assert.equal(await panel.getAttribute('aria-label'), 'Rated 5 of 5');

			// A press on the lit star clears the rating.
			saved = rated();
			await hero.getByRole('button', { name: 'Clear the rating' }).click();
			await saved;
			assert.equal(await hero.getAttribute('aria-label'), 'Not rated');
			assert.equal(subsonic.state.ratings.has('al5'), false);
		} finally {
			subsonic.state.ratings.clear();
			await page.close();
		}
		assert.deepEqual(problems, []);
	});
});

describe('Jellyfin favourites changed elsewhere', () => {
	/*
	 * A heart pressed in a tab was shown as pressed until the tab was reloaded,
	 * and a tab is kept open for days: taken off in Jellyfin's own app, it
	 * stayed on here.
	 */
	test('a page loaded after a press shows what Jellyfin has, and the player keeps the press', async () => {
		const jf = await browser.newContext({ viewport: { width: 1440, height: 900 } });
		const signIn = await jf.request.post(`${app.url}/login`, {
			form: { username: 'jfuser', password: 'jfpass', backend: 'jellyfin', next: '/' },
			headers: { origin: app.url, accept: 'text/html' },
			maxRedirects: 0
		});
		assert.equal(signIn.status(), 303);
		const page = await jf.newPage();
		const rowHeart = (n) => page.locator('main .track').nth(n).locator('.fav');
		const playerHeart = page.locator('aside.panel .rounds .fav');
		// In place, as the rail and the cards do: a full load would forget
		// every press anyway.
		const openAlbumInPlace = async () => {
			await page.locator('nav.rail a[href="/albums"]').click();
			await page.waitForURL(/\/albums$/);
			await page.locator('main a[href="/albums/b2"]').first().click();
			await page.waitForURL(/\/albums\/b2$/);
			await page.waitForFunction(() => document.querySelector('main h1')?.textContent?.includes('Second'));
		};
		try {
			await page.goto(app.url + '/albums/b2', { waitUntil: 'networkidle' });
			await page.getByRole('button', { name: 'Play Track 1', exact: true }).click();
			await page.waitForFunction(() => document.querySelector('aside.panel h2.title')?.textContent === 'Track 1');

			const starred = page.waitForResponse((r) => r.url().endsWith('/api/star'));
			await rowHeart(0).click();
			await starred;
			assert.ok(jellyfin.state.favourites.has('t1'), 'Jellyfin was not told');

			await openAlbumInPlace();
			assert.equal(await rowHeart(0).getAttribute('aria-pressed'), 'true', 'the press did not survive a page change');
			assert.equal(await playerHeart.getAttribute('aria-pressed'), 'true', 'the player lost the press');

			// Taken off in Jellyfin's app, and put on another track there. A star
			// made here drops the server's held copies, as waiting out the minute
			// they are held for would.
			jellyfin.state.favourites.delete('t1');
			jellyfin.state.favourites.add('t3');
			await page.evaluate(() =>
				fetch('/api/star', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'b3', kind: 'album', starred: true }) })
			);

			await openAlbumInPlace();
			assert.equal(await rowHeart(0).getAttribute('aria-pressed'), 'false', 'the old press hid the change made in Jellyfin');
			assert.equal(await rowHeart(2).getAttribute('aria-pressed'), 'true', 'the star made in Jellyfin is not shown');
		} finally {
			jellyfin.state.favourites.clear();
			await jf.close();
		}
	});
});

describe('a press on the transport', () => {
	/** The keyframes running on a control's glyph, by the property they move. */
	const moving = (page, selector) =>
		page.evaluate((selector) => {
			const glyph = document.querySelector(selector)?.querySelector('svg');
			return (glyph?.getAnimations() ?? []).flatMap((a) => Object.keys(a.effect.getKeyframes()[0] ?? {}));
		}, selector);

	test('throws the skip glyph the way the queue went, and turns shuffle and repeat', async () => {
		const { page, problems } = await watchedPage();
		try {
			await page.goto(app.url + '/albums/al11', { waitUntil: 'networkidle' });
			const panel = page.locator('aside.panel');
			await page.getByRole('button', { name: 'Play Song 11a', exact: true }).click();
			await page.waitForFunction(() => document.querySelector('aside.panel h2.title')?.textContent === 'Song 11a');

			await panel.getByRole('button', { name: 'Next track' }).click();
			const next = await page.evaluate(() => {
				const animation = document.querySelector('aside.panel button[aria-label="Next track"] svg')?.getAnimations()[0];
				return animation ? String(animation.effect.getKeyframes()[1].translate) : null;
			});
			assert.match(next ?? '', /^0\.7rem/, 'next did not throw its glyph forward');

			await page.waitForTimeout(600);
			await panel.getByRole('button', { name: 'Previous track' }).click();
			const previous = await page.evaluate(() => {
				const animation = document.querySelector('aside.panel button[aria-label="Previous track"] svg')?.getAnimations()[0];
				return animation ? String(animation.effect.getKeyframes()[1].translate) : null;
			});
			assert.match(previous ?? '', /^-0\.7rem/, 'previous did not throw its glyph back');

			await panel.getByRole('button', { name: 'Shuffle' }).click();
			assert.ok((await moving(page, 'aside.panel button[aria-label="Shuffle"]')).includes('transform'), 'shuffle did not turn over');
			await panel.getByRole('button', { name: /^Repeat/ }).click();
			assert.ok((await moving(page, 'aside.panel button[title^="Repeat"]')).includes('rotate'), 'repeat did not go round');
			// Back as it was for the tests after this.
			await panel.getByRole('button', { name: 'Shuffle' }).click();
			for (let i = 0; i < 2; i++) await panel.getByRole('button', { name: /^Repeat/ }).click();
		} finally {
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
			// Until the fade has finished. A fixed 500ms read 0.99 on a slow CI runner.
			await page.waitForFunction(
				() => getComputedStyle(document.querySelector('dialog.picker .row.added .check')).opacity === '1',
				null,
				{ timeout: 3000 }
			);
			const check = await page
				.locator('dialog.picker .row.added .check')
				.evaluate((el) => ({ width: el.getBoundingClientRect().width }));
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
	 * slider is the same component with values from 0 to 1. With the one-second
	 * floor applied to it, every level below full drew as 0.
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
	 * change while the veil faded behind them. The glass cannot be watched from
	 * here, so this checks that the veil is never behind it.
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

describe('appears on', () => {
	test('an artist page shows the albums of others the artist is on, after its own', async () => {
		const { page, problems } = await watchedPage();
		try {
			await page.goto(app.url + '/artists/ar1', { waitUntil: 'networkidle' });
			await page.waitForFunction(() => [...document.querySelectorAll('h2')].some((h) => h.textContent === 'Appears on'));
			const shelf = await page.evaluate(() => {
				const headings = [...document.querySelectorAll('h2')].map((h) => h.textContent);
				const heading = [...document.querySelectorAll('h2')].find((h) => h.textContent === 'Appears on');
				const cards = [...(heading?.closest('section')?.querySelectorAll('a.card') ?? [])];
				return { headings, links: [...new Set(cards.map((card) => card.getAttribute('href')))], text: cards.map((card) => card.textContent) };
			});
			assert.deepEqual(shelf.links, ['/albums/al2']);
			assert.match(shelf.text.join(' '), /Artist 0002/, 'the album\'s own artist is named on the card');
			// The mock's albums are two tracks and six minutes, with no type from the server: singles.
			assert.ok(shelf.headings.includes('Singles') && shelf.headings.indexOf('Singles') < shelf.headings.indexOf('Appears on'), `sections: ${shelf.headings}`);
		} finally {
			await page.close();
		}
		assert.deepEqual(problems, []);
	});
});

describe('a capped section of albums', () => {
	/*
	 * "You might like" asks for eight. Rows of three on a phone left two cards
	 * and an empty third of a row; rows of seven at 1440 left one on a row of
	 * its own. The section shows whole rows only.
	 */
	const suggestions = (page) =>
		page.evaluate(() => {
			const heading = [...document.querySelectorAll('h2')].find((h) => h.textContent === 'You might like');
			const grid = heading?.closest('section')?.querySelector('.grid');
			if (!grid) return null;
			const shown = [...grid.children].filter((card) => getComputedStyle(card).display !== 'none').length;
			const columns = getComputedStyle(grid).gridTemplateColumns.split(' ').length;
			return { total: grid.children.length, shown, columns };
		});

	before(() => {
		subsonic.state.similarAlbums = 8;
	});

	after(() => {
		subsonic.state.similarAlbums = 0;
	});

	for (const [label, viewport, mobile] of [
		['on a phone', { width: 393, height: 852 }, true],
		['at 1440px', { width: 1440, height: 900 }, false]
	]) {
		test(`shows whole rows only, ${label}`, async () => {
			const view = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile });
			const signIn = await view.request.post(`${app.url}/login`, {
				form: { username: 'testuser', password: 'testpass', backend: 'subsonic', next: '/' },
				headers: { origin: app.url, accept: 'text/html' },
				maxRedirects: 0
			});
			assert.equal(signIn.status(), 303);
			const page = await view.newPage();
			try {
				await page.goto(app.url + '/albums/al26', { waitUntil: 'networkidle' });
				await page.waitForFunction(() => [...document.querySelectorAll('h2')].some((h) => h.textContent === 'You might like'));
				const seen = await suggestions(page);
				assert.equal(seen.total, 8, `the section has ${seen.total} albums`);
				assert.equal(seen.shown % seen.columns, 0, `${seen.shown} shown in rows of ${seen.columns}`);
				assert.equal(seen.shown, seen.total - (seen.total % seen.columns));
				if (mobile) assert.equal(seen.shown, 6);
			} finally {
				await view.close();
			}
		});
	}
});

describe('the phone dock on a wide screen', () => {
	test('is not shown, and the rail is', async () => {
		const { page, problems } = await watchedPage();
		try {
			await page.goto(app.url + '/albums', { waitUntil: 'networkidle' });
			assert.equal(await page.locator('.phone-dock').isVisible(), false, 'the dock is shown at 1440px');
			assert.equal(await page.locator('nav.rail').isVisible(), true, 'the rail is not shown at 1440px');
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

				await tap(page, page.locator('#player-hide'));
				await page.waitForFunction(() => !document.querySelector('.app').classList.contains('player-open'), null, {
					timeout: 5000
				});
				await page.waitForTimeout(300);
				assert.equal(await page.evaluate(() => document.activeElement?.id), 'dock-open', 'focus is not back on the dock');
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

		test('the sheet closes into the dock, and leaves nothing behind', async () => {
			const { page, problems } = await phonePage('/');
			try {
				await playAlbum(page, 17);
				await tap(page, page.locator('#dock-open'));
				await page.waitForTimeout(700);

				await tap(page, page.locator('#player-hide'));
				await page.waitForTimeout(120);
				const midway = await page.evaluate(() => {
					const wrapper = document.querySelector('.app > .player');
					const dock = document.querySelector('.phone-dock').getBoundingClientRect();
					const sheet = wrapper.getBoundingClientRect();
					return {
						ghost: document.querySelectorAll('.hh-cover-ghost').length,
						translate: getComputedStyle(wrapper).translate,
						// Shrinking toward the dock, not sliding down past it.
						shrinking: sheet.height < innerHeight - 24 && sheet.top > 12 && sheet.bottom <= dock.bottom + 1
					};
				});
				assert.equal(midway.ghost, 1, 'no cover flying to the dock');
				assert.equal(midway.translate, 'none', 'the sheet is sliding, not morphing');
				assert.ok(midway.shrinking, 'the sheet is not shrinking into the dock');

				await page.waitForTimeout(700);
				const after = await page.evaluate(() => {
					const wrapper = document.querySelector('.app > .player');
					return {
						ghost: document.querySelectorAll('.hh-cover-ghost').length,
						visibility: getComputedStyle(wrapper).visibility,
						transform: getComputedStyle(wrapper).transform,
						held: wrapper.classList.contains('morphing') || wrapper.classList.contains('parking')
					};
				});
				assert.deepEqual(after, { ghost: 0, visibility: 'hidden', transform: 'none', held: false });
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
			await page.getByRole('navigation', { name: 'Settings' }).getByRole('link', { name: 'Account' }).click();
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

	/*
	 * A play pressed while the saved queue's current track was being looked up
	 * was replaced by the saved queue when the lookup answered: the dock showed
	 * the new track, then the old one, and the next save wrote the old queue
	 * back. It surfaced in CI as phone tests that came back to the previous
	 * test's album after a page load.
	 */
	test('a track played while the saved queue is being looked up stays, and is what is saved', async () => {
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
	test('turning shuffle off puts the queue back in its order, around the track playing', async () => {
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

describe('the settings tabs', () => {
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
			assert.equal(await tabs.getByRole('link', { name: 'Appearance' }).getAttribute('aria-current'), 'page');
			assert.ok(await heading('Appearance').isVisible());
			for (const name of ['Playback', 'Transcoding', 'Session & security', 'Cover cache']) {
				assert.equal(await heading(name).isVisible(), false, `${name} shows on the Appearance tab`);
			}

			// A switch reads nothing from the server.
			let fetched = 0;
			page.on('request', (request) => {
				if (request.url().includes('/settings') && request.resourceType() !== 'image') {
					fetched++;
				}
			});
			await tabs.getByRole('link', { name: 'Cover cache' }).click();
			await heading('Cover cache').waitFor();
			assert.equal(await heading('Appearance').isVisible(), false);
			assert.match(page.url(), /\/settings\?tab=storage$/);
			assert.equal(fetched, 0, 'the tab switch asked the server for the page');

			// Saving from Appearance keeps what the Playback tab holds.
			await tabs.getByRole('link', { name: 'Appearance' }).click();
			await page.locator('select[name="theme"]').selectOption('light');
			await page.getByRole('button', { name: 'Save settings' }).click();
			await page.getByText('Settings saved.').waitFor();
			const saved = await (await context.request.get(`${app.url}/api/settings`)).json();
			assert.equal(saved.theme, 'light');
			assert.equal(saved.transcode, true);
			assert.equal(saved.transcodeBitrateKbps, 256);

			// A link to a tab opens on it.
			await page.goto(app.url + '/settings?tab=account', { waitUntil: 'networkidle' });
			assert.ok(await heading('Session & security').isVisible());
			assert.equal(await page.getByRole('button', { name: 'Save settings' }).isVisible(), false);
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
			assert.equal(await page.locator('select[name="theme"] option[value="light"]').textContent(), 'Paper');
		} finally {
			await paper.request.patch(`${app.url}/api/settings`, { data: { theme: 'dark' }, headers: { origin: app.url } });
			await paper.close();
		}
	});
});
