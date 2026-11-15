/**
 * Folders, ratings, smart playlists, the sliders, the volume limit, motion and moving between pages.
 *
 *   npm run build
 *   node --test tests/browser/library.test.mjs
 *
 * Runs the built app against the mock servers of `tests/e2e`; see `suite.mjs`.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { startApp } from '../e2e/harness.mjs';
import { silentWav } from '../e2e/mocks.mjs';
import { subsonic, jellyfin, app, browser, pick, shown, watchedPage, playable, setUpSuite } from './suite.mjs';

setUpSuite();

describe('folders', () => {
	test('are opened from the rail down to an album\'s folder, played, and left by the trail', async (t) => {
		playable(t);
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
	test('the album and the playing song are rated with a press, and the player\'s stars follow the song', async (t) => {
		playable(t);
		const { page, problems } = await watchedPage();
		const rated = () => page.waitForResponse((r) => r.url().endsWith('/api/rating'));
		const hero = page.locator('header.hero .stars');
		const panel = page.locator('aside.panel .facts .stars');
		try {
			await page.goto(app.url + '/albums/al5', { waitUntil: 'networkidle' });
			assert.equal(await hero.getAttribute('aria-label'), 'Not rated');
			let saved = rated();
			await hero.getByRole('radio', { name: '3 of 5' }).click();
			await saved;
			assert.equal(await hero.getAttribute('aria-label'), 'Rated 3 of 5');
			assert.equal(subsonic.state.ratings.get('al5'), 3);

			await page.getByRole('button', { name: 'Play Song 5a', exact: true }).click();
			await page.waitForFunction(() => document.querySelector('aside.panel h2.title')?.textContent === 'Song 5a');
			await page.getByRole('button', { name: 'Track details' }).click();
			saved = rated();
			await panel.getByRole('radio', { name: '5 of 5' }).click();
			await saved;
			assert.equal(subsonic.state.ratings.get('s5a'), 5);

			await page.locator('aside.panel button.step').nth(1).click();
			await page.waitForFunction(() => document.querySelector('aside.panel h2.title')?.textContent === 'Song 5b');
			assert.equal(await panel.getAttribute('aria-label'), 'Not rated', 'the next song showed the last song\'s stars');
			await page.locator('aside.panel button.step').nth(0).click();
			await page.waitForFunction(() => document.querySelector('aside.panel h2.title')?.textContent === 'Song 5a');
			assert.equal(await panel.getAttribute('aria-label'), 'Rated 5 of 5');

			// A press on the star that is the rating clears it.
			saved = rated();
			await hero.getByRole('radio', { name: '3 of 5', checked: true }).click();
			await saved;
			assert.equal(await hero.getAttribute('aria-label'), 'Not rated');
			assert.equal(subsonic.state.ratings.has('al5'), false);
		} finally {
			subsonic.state.ratings.clear();
			await page.close();
		}
		assert.deepEqual(problems, []);
	});

	test('a song is rated from the menu on its row, by a press or from the keyboard, and the lit star clears it', async () => {
		const { page, problems } = await watchedPage();
		const rated = () => page.waitForResponse((r) => r.url().endsWith('/api/rating'));
		const focusedLabel = () => page.evaluate(() => document.activeElement?.getAttribute('aria-label'));
		try {
			await page.goto(app.url + '/albums/al34', { waitUntil: 'networkidle' });
			const row = page.locator('main .track', { hasText: 'Song 34b' });
			const stars = page.getByRole('menu').getByRole('group', { name: 'Rating' });
			await row.locator('.title').click({ button: 'right' });
			let saved = rated();
			await stars.getByRole('menuitemradio', { name: 'Rate 4 of 5' }).click();
			await saved;
			assert.equal(subsonic.state.ratings.get('s34b'), 4);
			assert.equal(await page.getByRole('menu').count(), 0, 'the menu stayed after a rating');

			// From the keyboard the stars are one stop, in the head above the first item, entered at the rating.
			await row.focus();
			await page.keyboard.press('ContextMenu');
			await page.getByRole('menu').waitFor();
			assert.equal(await focusedLabel(), null, 'the first item has the focus, not a star');
			assert.equal(await page.evaluate(() => document.activeElement?.textContent?.trim()), 'Play');
			await page.keyboard.press('ArrowUp');
			assert.equal(await focusedLabel(), '4 of 5, press to clear');
			assert.equal(await page.getByRole('menu').getByText('Rate', { exact: true }).count(), 0, 'no "Rate" label');
			await page.keyboard.press('ArrowLeft');
			assert.equal(await focusedLabel(), 'Rate 3 of 5');
			saved = rated();
			await page.keyboard.press('Enter');
			await saved;
			assert.equal(subsonic.state.ratings.get('s34b'), 3);
			assert.ok(await row.evaluate((el) => el === document.activeElement), 'the focus did not go back to the row');

			await row.locator('.title').click({ button: 'right' });
			saved = rated();
			await stars.getByRole('menuitemradio', { name: '3 of 5, press to clear' }).click();
			await saved;
			assert.equal(subsonic.state.ratings.has('s34b'), false);
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
	test('a page loaded after a press shows what Jellyfin has, and the player keeps the press', async (t) => {
		jellyfin.state.audio = { type: 'audio/wav', body: silentWav(60) };
		t.after(() => {
			jellyfin.state.audio = null;
		});
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

	test('throws the skip glyph the way the queue went, and turns shuffle and repeat', async (t) => {
		playable(t);
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
	test('the song text slides in from the right on next and from the left on previous', async (t) => {
		playable(t);
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

describe('smart playlists', () => {
	const field = (page, n) => page.getByLabel(`Field of rule ${n}`, { exact: true });
	const operator = (page, n) => page.getByLabel(`Operator of rule ${n}`, { exact: true });
	const rulesLine = (page) => page.locator('main p.rules').evaluate((el) => el.textContent.replace(/\s+/g, ' ').trim());

	test('one is made in the editor, opens with its songs, and takes none added', async () => {
		const { page, problems } = await watchedPage();
		try {
			await page.goto(app.url + '/playlists', { waitUntil: 'networkidle' });
			await page.getByRole('button', { name: 'New smart playlist' }).click();
			const create = page.getByRole('button', { name: 'Create', exact: true });
			// A name first: the rules it starts with are whole.
			assert.equal(await create.isDisabled(), true);
			await page.getByLabel('Name', { exact: true }).fill('Rock of the nineties');

			await pick(field(page, 1), 'genre');
			assert.equal(await shown(operator(page, 1)), 'contains', 'a text field kept a date operator');
			await page.getByLabel('Value of rule 1', { exact: true }).fill('rock');

			await page.getByRole('button', { name: 'Add a rule' }).click();
			// The new rule has no value yet, and Create waits for one.
			await page.getByText('Rule 2: genre contains needs a valid value.').waitFor();
			assert.equal(await create.isDisabled(), true);
			await pick(field(page, 2), 'year');
			await pick(operator(page, 2), 'inTheRange');
			assert.equal(await page.getByLabel('Lowest of rule 2', { exact: true }).inputValue(), '1990');
			await page.getByLabel('Highest of rule 2', { exact: true }).fill('1985');
			await page.getByText('Rule 2: year is between needs a valid value.').waitFor();
			await page.getByLabel('Highest of rule 2', { exact: true }).fill('1999');

			await page.getByRole('button', { name: 'Add a rule' }).click();
			await pick(field(page, 3), 'loved');
			await page.getByRole('button', { name: 'Remove rule 3' }).click();
			assert.equal(await page.getByLabel('Field of rule 3', { exact: true }).count(), 0);

			await pick(page.getByLabel('Sorted by'), 'random');
			assert.equal(await page.getByLabel('Order', { exact: true }).count(), 0, 'random offered an order');
			await page.getByLabel('At most').fill('');

			await create.click();
			await page.waitForURL(/\/playlists\/sm\d+$/);
			const id = page.url().split('/').at(-1);
			assert.deepEqual(subsonic.state.smart.get(id).rules, {
				all: [{ contains: { genre: 'rock' } }, { inTheRange: { year: [1990, 1999] } }],
				sort: 'random',
				order: 'desc'
			});
			assert.equal(await rulesLine(page), 'Genre contains “rock”, and year is between 1990 and 1999; in random order.');
			await page.locator('main .track').first().waitFor();
			assert.equal(await page.locator('main .grip').count(), 0, 'the songs can be dragged');

			// The picker leaves it out: songs cannot be added to it.
			await page.goto(app.url + '/albums/al1', { waitUntil: 'networkidle' });
			await page.locator('.page').getByRole('button', { name: 'Add to playlist', exact: true }).first().click();
			await page.locator('dialog.picker .row').first().waitFor();
			const offered = await page.locator('dialog.picker .row').allTextContents();
			assert.ok(offered.some((text) => text.includes('Mock Playlist')), offered.join());
			assert.ok(!offered.some((text) => text.includes('Rock of the nineties')), offered.join());
		} finally {
			subsonic.state.smart.clear();
			await page.close();
		}
		assert.deepEqual(problems, []);
	});

	test('its rules are changed on its page, and a cancel changes nothing', async () => {
		subsonic.state.smart.set('sm-edit', {
			name: 'Most played',
			owner: null,
			public: false,
			path: '',
			rules: { all: [{ gt: { playcount: 10 } }], sort: 'playcount', order: 'desc', limit: 50 }
		});
		const { page, problems } = await watchedPage();
		try {
			await page.goto(app.url + '/playlists/sm-edit', { waitUntil: 'networkidle' });
			assert.equal(await rulesLine(page), 'Play count is more than 10; by play count, descending, 50 songs at most.');

			await page.getByRole('button', { name: 'Edit rules' }).click();
			await page.getByLabel('Value of rule 1', { exact: true }).fill('20');
			await page.getByRole('button', { name: 'Cancel', exact: true }).click();
			await page.getByRole('button', { name: 'Edit rules' }).click();
			assert.equal(await page.getByLabel('Value of rule 1', { exact: true }).inputValue(), '10', 'a cancelled change was kept');

			await page.getByLabel('Value of rule 1', { exact: true }).fill('25');
			await pick(page.getByLabel('Match all or any of the rules'), 'any');
			await page.getByRole('button', { name: 'Add a rule' }).click();
			await pick(field(page, 2), 'lastplayed');
			await pick(operator(page, 2), 'notInTheLast');
			await page.getByLabel('Days of rule 2', { exact: true }).fill('60');
			await page.getByRole('button', { name: 'Save rules' }).click();
			await page.locator('main form.editor').waitFor({ state: 'detached' });
			assert.equal(await rulesLine(page), 'Play count is more than 25, or last played not in the last 60 days; by play count, descending, 50 songs at most.');
			assert.deepEqual(subsonic.state.smart.get('sm-edit').rules, {
				any: [{ gt: { playcount: 25 } }, { notInTheLast: { lastplayed: 60 } }],
				sort: 'playcount',
				order: 'desc',
				limit: 50
			});
		} finally {
			subsonic.state.smart.clear();
			await page.close();
		}
		assert.deepEqual(problems, []);
	});
});

describe('sliders and the playlist picker', () => {
	const fillWidth = (page) =>
		page.locator('[role="slider"][aria-label="Volume"] .slider-range').evaluate((el) => parseFloat(el.style.width));
	/** The scale ElasticSlider gives the whole control under the pointer, from its transform. */
	const swell = (page) =>
		page
			.locator('[role="slider"][aria-label="Volume"]')
			.evaluate((el) => new DOMMatrix(getComputedStyle(el.closest('.slider-wrapper')).transform).a);

	test('the volume does not swell under the pointer, stretches past its end, empties on mute and sets a level where it is pressed', async () => {
		const { page, problems } = await watchedPage();
		const track = () =>
			page.locator('[role="slider"][aria-label="Volume"] .slider-track-wrapper').evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).a);
		try {
			await page.goto(app.url + '/albums', { waitUntil: 'networkidle' });
			const before = await fillWidth(page);
			assert.ok(before > 50);

			await page.getByRole('button', { name: 'Mute', exact: true }).click();
			await page.waitForFunction(() => parseFloat(document.querySelector('[role="slider"][aria-label="Volume"] .slider-range').style.width) === 0);
			await page.getByRole('button', { name: 'Unmute', exact: true }).click();
			await page.waitForFunction((want) => Math.round(parseFloat(document.querySelector('[role="slider"][aria-label="Volume"] .slider-range').style.width)) === want, Math.round(before));

			const bar = page.locator('[role="slider"][aria-label="Volume"]');
			const box = await bar.boundingBox();
			await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
			await page.waitForTimeout(400);
			assert.equal(await swell(page), 1, 'the slider swelled under the pointer');

			// Held and pulled past the end, the track stretches like a band.
			await page.mouse.down();
			await page.mouse.move(box.x + box.width + 60, box.y + box.height / 2, { steps: 6 });
			await page.waitForFunction(() => new DOMMatrix(getComputedStyle(document.querySelector('[role="slider"][aria-label="Volume"] .slider-track-wrapper')).transform).a > 1.02);
			assert.ok((await track()) > 1.02, 'the track did not stretch past its end');
			await page.mouse.up();

			await page.mouse.click(box.x + box.width * 0.25, box.y + box.height / 2);
			await page.waitForFunction(() => Math.abs(parseFloat(document.querySelector('[role="slider"][aria-label="Volume"] .slider-range').style.width) - 25) < 8);
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
			// AnimatedContent (GSAP) moves the list as it opens, by an inline transform.
			const rising = await row.evaluate((el) => el.closest('.hh-rise').style.transform !== '');
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
				.locator('[role="slider"][aria-label="Volume"] .slider-range')
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

describe('a volume limit on the server', () => {
	/*
	 * `HEDDOHON_VOLUME_LIMIT=50`: the slider still runs from 0 to 100, and what
	 * the elements play at is half of it, through a crossfade as well, whose
	 * ramps are computed apart from the steady level. The two pages that play
	 * without the player, a share link and a listen-together guest, are held
	 * to the same limit.
	 */
	test('halves what a full slider plays at, in the app, on a share link and for a guest', async () => {
		const limited = await startApp({ subsonicUrl: subsonic.url, jellyfinUrl: jellyfin.url, env: { HEDDOHON_VOLUME_LIMIT: '50' } });
		const view = await browser.newContext({ viewport: { width: 1440, height: 900 } });
		const visitor = await browser.newContext({ viewport: { width: 1280, height: 900 } });
		subsonic.state.audio = { type: 'audio/wav', body: silentWav(6) };
		try {
			const signIn = await view.request.post(`${limited.url}/login`, {
				form: { username: 'testuser', password: 'testpass', backend: 'subsonic', next: '/' },
				headers: { origin: limited.url, accept: 'text/html' },
				maxRedirects: 0
			});
			assert.equal(signIn.status(), 303);
			const saved = await view.request.patch(`${limited.url}/api/settings`, {
				data: { volume: 1, transition: 'crossfade', crossfadeSeconds: 3, crossfadeWithinAlbum: true, installCardDismissed: true, aurora: 'off' },
				headers: { origin: limited.url }
			});
			assert.equal(saved.status(), 200);

			// The remote control's event stream stays open, so the page never
			// reaches `networkidle`: the play button is waited for instead.
			const page = await view.newPage();
			const problems = [];
			page.on('pageerror', (err) => problems.push(err.message));
			await page.goto(limited.url + '/albums/al1');
			const play = page.getByRole('button', { name: 'Play Song 1a', exact: true });
			await play.waitFor();
			await page.evaluate(() => {
				window.__together = 0;
				window.__loudest = 0;
				setInterval(() => {
					const playing = [...document.querySelectorAll('audio')].filter(
						(a) => !a.paused && a.currentTime > 0 && a.currentSrc.includes('/api/stream/')
					);
					window.__together = Math.max(window.__together, playing.length);
					window.__loudest = Math.max(window.__loudest, ...playing.map((a) => a.volume));
				}, 50);
			});
			await play.click();
			await page.waitForFunction(() => document.querySelector('aside.panel h2.title')?.textContent === 'Song 1b', null, {
				timeout: 12_000
			});
			// The fade has ended once one track plays, at the level it holds.
			const settled = () => {
				const playing = [...document.querySelectorAll('audio')].filter(
					(a) => !a.paused && a.currentTime > 0 && a.currentSrc.includes('/api/stream/')
				);
				return playing.length === 1 && playing[0].volume === 0.5;
			};
			await page.waitForFunction(settled, null, { timeout: 8000 });
			const heard = await page.evaluate(() => ({ together: window.__together, loudest: window.__loudest }));
			assert.equal(heard.together, 2, 'no crossfade happened, so its ramps were not measured');
			assert.ok(heard.loudest <= 0.5, `a track played at ${heard.loudest} under a limit of 0.5`);
			assert.equal(await page.locator('[role="slider"][aria-label="Volume"]').getAttribute('aria-valuetext'), '100 percent');
			assert.deepEqual(problems, []);
			await page.close();

			const made = await (
				await view.request.post(`${limited.url}/api/shares`, { data: { kind: 'album', id: 'al19', days: 1 }, headers: { origin: limited.url } })
			).json();
			const shared = await visitor.newPage();
			await shared.goto(limited.url + made.path, { waitUntil: 'networkidle' });
			// The layout's two elements are on the page as well, unused: the page's own is the one with an address.
			await shared.waitForFunction(() => document.querySelector('audio[src*="/stream/"]')?.volume === 0.5, null, { timeout: 5000 });
			await shared.close();

			const started = await view.request.post(`${limited.url}/api/together`, { data: {}, headers: { origin: limited.url } });
			assert.equal(started.status(), 200);
			const guest = await visitor.newPage();
			await guest.goto(limited.url + (await started.json()).party.url);
			await guest.waitForFunction(() => document.querySelector('audio.together-audio')?.volume === 0.5, null, { timeout: 5000 });
			await guest.close();
		} finally {
			subsonic.state.audio = null;
			await visitor.close();
			await view.close();
			await limited.stop();
		}
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
			// not wait for the page it is pointing at. The mock's delay only holds an
			// upstream call, and the listing may be served from the app's own cache,
			// so the page's request is held here instead: this is the one that decides
			// when the page arrives.
			subsonic.state.delays.set('getPlaylists', 3000);
			await page.route(/__data\.json/, async (route) => {
				if (!route.request().url().includes('/playlists')) return route.continue();
				await new Promise((done) => setTimeout(done, 3000));
				await route.continue();
			});
			// Sampled every frame for 1.5s from the click, three times the 480ms
			// move: it has to pass through the space between the two, not appear at
			// the other end. By time and not a count of frames: with the browser
			// files running side by side, 60 frames took longer than the 5s wait.
			await page.evaluate(() => {
				const el = document.querySelector('nav.rail .marker');
				const seen = (window.__marker = []);
				window.__markerDone = false;
				let first = 0;
				const sample = (now) => {
					first ||= now;
					const r = el.getBoundingClientRect();
					seen.push(r.top + r.height / 2);
					if (now - first < 1500) requestAnimationFrame(sample);
					else window.__markerDone = true;
				};
				requestAnimationFrame(sample);
			});
			await page.locator('nav.rail').getByRole('link', { name: 'Playlists', exact: true }).click();
			await page.waitForFunction(() => window.__markerDone, null, { timeout: 2900 });
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

	test('a page opened from the rail rises in, and its list with it', async () => {
		const { page, problems } = await watchedPage();
		try {
			await page.goto(app.url + '/playlists', { waitUntil: 'networkidle' });
			const onFirstPaint = await page.evaluate(() => ({
				names: document.getAnimations().map((a) => a.animationName).filter((name) => /rise/.test(name ?? '')),
				moved: [...document.querySelectorAll('.hh-rise')].filter((el) => el.style.transform !== '').length
			}));
			assert.deepEqual(onFirstPaint, { names: [], moved: 0 }, 'a server-rendered page must not animate in');

			await page.evaluate(() => {
				window.__rise = null;
				const look = () => {
					// AnimatedContent (GSAP) moves the list by an inline transform.
					const list = [...document.querySelectorAll('.content .hh-rise')].find((el) => el.style.transform !== '');
					if (list) {
						window.__rise = {
							// Svelte scopes keyframes in a component: `svelte-…-page-rise`.
							page: document.getAnimations().some((a) => (a.animationName ?? '').endsWith('page-rise')),
							list: list.style.transform
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
			assert.match(rise.list, /translate/, 'the list did not rise');
			// Nothing is left on it once it has landed, so the glass in it blurs.
			await page.waitForFunction(() => [...document.querySelectorAll('.content .hh-rise')].every((el) => el.style.transform === '' && el.style.opacity === ''));
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
