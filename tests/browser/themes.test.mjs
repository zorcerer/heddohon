/**
 * Terminal and Phosphor, and signing in on a slow device.
 *
 *   npm run build
 *   node --test tests/browser/themes.test.mjs
 *
 * Runs the built app against the mock servers of `tests/e2e`; see `suite.mjs`.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { silentWav } from '../e2e/mocks.mjs';
import { subsonic, app, browser, context, select, pick, autosaved, optionsOf, shown, watchedPage, setUpSuite } from './suite.mjs';

setUpSuite();

describe('Terminal, the default theme', () => {
	/*
	 * The harness starts accounts in Liquid, which the rest of this file
	 * measures, so each test here sets the theme and puts Liquid back.
	 */
	const settings = (patch) => context.request.patch(`${app.url}/api/settings`, { data: patch, headers: { origin: app.url } });
	const liquid = () => settings({ theme: 'dark', scheme: 'heddohon', accent: 'artwork', dots: 'faint', playerArt: 'dither' });
	/** A CSS colour as the browser computes it on an element, as `[r, g, b, a]`. */
	const computed = (page, colour) =>
		page.evaluate((colour) => {
			const canvas = document.createElement('canvas').getContext('2d');
			const probe = document.createElement('div');
			probe.style.color = colour;
			document.body.append(probe);
			canvas.fillStyle = getComputedStyle(probe).color;
			probe.remove();
			canvas.fillRect(0, 0, 1, 1);
			return [...canvas.getImageData(0, 0, 1, 1).data];
		}, colour);

	test('no page logs an error in it', async () => {
		await settings({ theme: 'terminal' });
		const { page, problems } = await watchedPage();
		try {
			for (const path of ['/', '/albums', '/albums/al1', '/artists', '/artists/ar1', '/favourites', '/genres', '/radio', '/library', '/playlists', '/playlists/import', '/folders', '/folders/d-al1', '/history', '/screen', '/stats', '/stats/recap', '/search?q=song', '/people', '/settings']) {
				const response = await page.goto(app.url + path, { waitUntil: 'networkidle' });
				assert.equal(response?.status(), 200, path);
				assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'terminal', path);
			}
		} finally {
			await liquid();
			await page.close();
		}
		assert.deepEqual(problems, []);
	});

	/*
	 * What makes it Terminal and not Liquid in other colours: a pane is opaque
	 * and blurs nothing, the tint layers Liquid cross-fades are not painted, and
	 * the canvas stays the ground while a red cover plays, where Liquid's takes
	 * the cover's colour (the test of `theme-color` above).
	 */
	test('is opaque panes in a mono face over the ground alone, whatever plays', async () => {
		await settings({ theme: 'terminal' });
		subsonic.state.audio = { type: 'audio/wav', body: silentWav(30) };
		subsonic.state.coverColors.set('al-37', [220, 60, 30]);
		const { page, problems } = await watchedPage();
		try {
			await page.goto(app.url + '/albums/al37', { waitUntil: 'networkidle' });
			await page.getByRole('button', { name: 'Play Song 37a', exact: true }).click();
			await page.waitForFunction(() => [...document.querySelectorAll('audio')].some((a) => !a.paused && a.currentTime > 0));
			// As long as Liquid's canvas takes to reach the cover's colour.
			await page.waitForTimeout(2200);
			const seen = await page.evaluate(() => {
				const rail = document.querySelector('nav.rail');
				const panel = document.querySelector('aside.panel');
				const style = getComputedStyle(rail);
				return {
					blur: [style.backdropFilter, getComputedStyle(panel).backdropFilter],
					ground: style.backgroundColor,
					tint: [getComputedStyle(rail, '::before').display, getComputedStyle(rail, '::after').display],
					radius: style.borderTopLeftRadius,
					shadow: style.boxShadow,
					canvas: getComputedStyle(document.documentElement).backgroundColor,
					bar: document.querySelector('meta[name="theme-color"]').getAttribute('content'),
					face: getComputedStyle(document.body).fontFamily.split(',')[0].replaceAll('"', '').trim()
				};
			});
			assert.deepEqual(seen.blur, ['none', 'none']);
			assert.match(seen.ground, /^rgb\(/, `the rail's ground is see-through: ${seen.ground}`);
			assert.deepEqual(seen.tint, ['none', 'none'], 'a tint layer is painted');
			assert.equal(seen.radius, '6px');
			assert.equal(seen.shadow, 'none');
			assert.equal(seen.canvas, 'rgb(8, 9, 10)', 'the canvas took the cover\'s colour');
			assert.equal(seen.bar, '#08090a');
			assert.equal(seen.face, 'Heddohon Terminal');
		} finally {
			await liquid();
			subsonic.state.audio = null;
			subsonic.state.coverColors.delete('al-37');
			await page.close();
		}
		assert.deepEqual(problems, []);
	});

	test('the accent is the colour chosen, and the dot grid is as strong as chosen or not drawn', async () => {
		await settings({ theme: 'terminal', accent: 'green', dots: 'faint' });
		const { page, problems } = await watchedPage();
		const dots = () =>
			page.evaluate(() => {
				const image = getComputedStyle(document.querySelector('.app > .hh-ambience')).backgroundImage;
				// The dot's colour is the text colour at the share chosen: its alpha, or null with no grid.
				return image.includes('radial-gradient') ? Number(/srgb [\d.]+ [\d.]+ [\d.]+ \/ ([\d.]+)\)|rgba\([^)]*, ([\d.]+)\)/.exec(image)?.slice(1).find(Boolean)) : null;
			});
		try {
			await page.goto(app.url + '/albums', { waitUntil: 'networkidle' });
			assert.deepEqual(await computed(page, 'var(--accent)'), [143, 240, 164, 255]);
			const faint = await dots();
			assert.ok(faint > 0.05 && faint < 0.09, `faint is 7 percent: ${faint}`);

			// Changed in Settings, it is on the page at once, without a load.
			await page.goto(app.url + '/settings', { waitUntil: 'networkidle' });
			await autosaved(page, async () => {
				await pick(select(page, 'dots'), 'strong');
				await pick(select(page, 'accent'), 'amber');
			});
			await page.waitForFunction(() => document.documentElement.dataset.accent === 'amber');
			await page.waitForFunction(() => document.documentElement.dataset.dots === 'strong');
			const strong = await dots();
			assert.ok(strong > 0.18 && strong < 0.22, `strong is 20 percent: ${strong}`);
			assert.deepEqual(await computed(page, 'var(--accent)'), [255, 180, 84, 255]);

			await settings({ dots: 'off' });
			await page.goto(app.url + '/albums', { waitUntil: 'networkidle' });
			assert.equal(await dots(), null, 'the grid is drawn with the dots off');
		} finally {
			await liquid();
			await page.close();
		}
		assert.deepEqual(problems, []);
	});

	test('the line along the top of the page says where it is, in Terminal alone and not on a phone', async () => {
		await settings({ theme: 'terminal' });
		const { page, problems } = await watchedPage();
		const strip = page.locator('main.content > nav.strip');
		try {
			await page.goto(app.url + '/albums/al1', { waitUntil: 'networkidle' });
			const name = await page.locator('main.content h1').first().textContent();
			const slug = name.trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '');
			assert.ok(await strip.isVisible());
			assert.equal((await strip.locator('.path').textContent()).replace(/\s+/g, ''), `~/albums/${slug}`);
			assert.match(await strip.locator('.whose').textContent(), /^testuser@/);
			// It stays at the top of the pane while the page scrolls under it.
			const top = async () => (await strip.boundingBox()).y;
			const before = await top();
			await page.locator('main.content').evaluate((el) => el.scrollTo({ top: 400, behavior: 'instant' }));
			assert.equal(await top(), before);
			// The section is a link to it.
			await strip.getByRole('link', { name: 'albums' }).click();
			await page.waitForURL(app.url + '/albums');
			// The page is put in after the address changes.
			await page.waitForFunction(() => document.querySelector('main.content > nav.strip .path').textContent.replace(/\s+/g, '') === '~/albums');
			// The page it is on is text: a link to it would load nothing.
			assert.equal(await strip.getByRole('link').count(), 1);

			await page.setViewportSize({ width: 393, height: 852 });
			assert.equal(await strip.isVisible(), false, 'the line is shown on a phone');
			await page.setViewportSize({ width: 1440, height: 900 });
			await settings({ theme: 'dark' });
			await page.goto(app.url + '/albums/al1', { waitUntil: 'networkidle' });
			assert.equal(await strip.isVisible(), false, 'the line is shown in Liquid');
		} finally {
			await liquid();
			await page.close();
		}
		assert.deepEqual(problems, []);
	});

	/** WCAG contrast of two `[r, g, b]` colours. */
	const contrast = (one, two) => {
		const luminance = ([r, g, b]) =>
			[r, g, b].reduce((sum, c, at) => {
				const v = c / 255;
				return sum + (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4) * [0.2126, 0.7152, 0.0722][at];
			}, 0);
		const [hi, lo] = [luminance(one), luminance(two)].sort((a, b) => b - a);
		return (hi + 0.05) / (lo + 0.05);
	};

	test('the playing track is a raised row with its title in the accent, read at 4.5:1, and the player\'s title ends as the title after a skip', async () => {
		await settings({ theme: 'terminal' });
		subsonic.state.audio = { type: 'audio/wav', body: silentWav(30) };
		const { page, problems } = await watchedPage();
		try {
			await page.goto(app.url + '/albums/al1', { waitUntil: 'networkidle' });
			await page.getByRole('button', { name: /^(Play|Pause) Song 1a$/ }).click();
			await page.waitForFunction(() => [...document.querySelectorAll('audio')].some((a) => !a.paused && a.currentTime > 0));
			await page.waitForTimeout(400);
			const row = await page.evaluate(() => {
				const rgb = (colour) => {
					const canvas = document.createElement('canvas').getContext('2d');
					canvas.fillStyle = colour;
					canvas.fillRect(0, 0, 1, 1);
					return [...canvas.getImageData(0, 0, 1, 1).data].slice(0, 3);
				};
				const current = document.querySelector('.track.current');
				const colour = (selector) => rgb(getComputedStyle(current.querySelector(selector)).color);
				return {
					ground: rgb(getComputedStyle(current).backgroundColor),
					title: colour('.title'),
					time: colour('.duration'),
					other: rgb(getComputedStyle(document.querySelector('.track:not(.current)')).backgroundColor)
				};
			});
			assert.deepEqual(row.ground, (await computed(page, 'var(--bg-raised)')).slice(0, 3), 'the playing row is not a step of the ground');
			assert.deepEqual(row.title, (await computed(page, 'var(--accent)')).slice(0, 3), 'the playing title is not the accent');
			for (const part of ['title', 'time']) {
				const ratio = contrast(row[part], row.ground);
				assert.ok(ratio >= 4.5, `the ${part} on the playing row: ${ratio.toFixed(1)} to 1`);
			}

			// The title resolves out of other glyphs, in place, and is the title when it is done.
			const title = page.locator('aside.panel h2.title');
			const frames = await page.evaluate(async () => {
				const heading = document.querySelector('aside.panel h2.title');
				const seen = [];
				document.querySelector('aside.panel button[aria-label="Next track"]').click();
				const until = performance.now() + 2500;
				let settled = 0;
				while (performance.now() < until && settled < 20) {
					await new Promise((done) => requestAnimationFrame(done));
					seen.push(heading.textContent);
					settled = heading.textContent === 'Song 1b' ? settled + 1 : 0;
				}
				return seen;
			});
			assert.equal(frames.at(-1), 'Song 1b');
			assert.ok(frames.some((text) => text !== 'Song 1a' && text !== 'Song 1b'), 'the title changed in one step');
			assert.ok(frames.every((text) => text === 'Song 1a' || text.length === 'Song 1b'.length), 'a frame of it was a different length');
			await page.waitForTimeout(500);
			assert.equal(await title.textContent(), 'Song 1b');
			assert.equal(await title.getAttribute('data-text'), 'Song 1b');
		} finally {
			await liquid();
			subsonic.state.audio = null;
			await page.close();
		}
		assert.deepEqual(problems, []);
	});

	/*
	 * The four ways the artwork meets the panel, each drawn by the layer over
	 * it. Chosen in Settings, the one on the page changes without a load.
	 */
	test('the player\'s artwork is dissolved into dots, faded plainly, crossed by scanlines or in two tones, as chosen', async () => {
		// A blue cover under a green accent, so the two can be told apart.
		await settings({ theme: 'terminal', playerArt: 'dither', accent: 'green' });
		// On an album no other test plays: the browser keeps a cover it has fetched.
		subsonic.state.coverColors.set('al-38', [40, 60, 210]);
		subsonic.state.audio = { type: 'audio/wav', body: silentWav(30) };
		const { page, problems } = await watchedPage();
		const drawn = () =>
			page.evaluate(() => {
				const art = document.querySelector('aside.panel .art');
				const layer = getComputedStyle(art, '::after');
				return {
					layer: /^(radial-gradient|repeating-linear-gradient)/.exec(layer.backgroundImage)?.[1] ?? layer.backgroundImage,
					fill: layer.backgroundColor,
					blend: layer.mixBlendMode,
					masked: layer.maskImage !== 'none',
					picture: getComputedStyle(art.querySelector('.cover')).filter
				};
			});
		try {
			await page.goto(app.url + '/albums/al38', { waitUntil: 'networkidle' });
			await page.getByRole('button', { name: /^(Play|Pause) Song 38a$/ }).click();
			await page.waitForFunction(() => [...document.querySelectorAll('audio')].some((a) => !a.paused && a.currentTime > 0));
			assert.deepEqual(await drawn(), { layer: 'radial-gradient', fill: 'rgba(0, 0, 0, 0)', blend: 'normal', masked: true, picture: 'none' });

			// By the rail, so the page is not loaded again and the track goes on.
			await page.locator('nav.rail a[href="/settings"]').click();
			await page.waitForURL(app.url + '/settings');
			const choose = async (value) => {
				await autosaved(page, () => pick(select(page, 'playerArt'), value));
				await page.waitForFunction((value) => document.documentElement.dataset.art === value, value);
				return drawn();
			};
			assert.deepEqual(await choose('plain'), { layer: 'none', fill: 'rgba(0, 0, 0, 0)', blend: 'normal', masked: true, picture: 'none' });
			assert.deepEqual(await choose('scanlines'), { layer: 'repeating-linear-gradient', fill: 'rgba(0, 0, 0, 0)', blend: 'normal', masked: false, picture: 'none' });
			await choose('duotone');
			// The second tone fades in over the grey picture, so it is read when it has.
			await page.waitForFunction(() => /^rgb\(/.test(getComputedStyle(document.querySelector('aside.panel .art'), '::after').backgroundColor));
			const duotone = await drawn();
			assert.equal(duotone.blend, 'multiply');
			assert.match(duotone.picture, /grayscale\(1\)/);
			// The cover's own colour, and not the accent: blue over green.
			const [red, green, blue] = duotone.fill.match(/\d+/g).map(Number);
			assert.ok(blue > red && blue > green, `the second tone is ${duotone.fill} for a blue cover`);
			assert.notDeepEqual([red, green, blue], (await computed(page, 'var(--accent)')).slice(0, 3));
			// The track went on playing through the three saves.
			assert.ok(await page.evaluate(() => [...document.querySelectorAll('audio')].some((a) => !a.paused)));
		} finally {
			await liquid();
			subsonic.state.audio = null;
			subsonic.state.coverColors.delete('al-38');
			await page.close();
		}
		assert.deepEqual(problems, []);
	});

	/*
	 * Terminal's own arrival: the list rises in, and the page under it stays
	 * still. Liquid's, under a page that rises, has its test under "motion".
	 */
	test('a list rises in after a navigation, and the page does not', async () => {
		await settings({ theme: 'terminal' });
		const { page, problems } = await watchedPage();
		try {
			await page.goto(app.url + '/playlists', { waitUntil: 'networkidle' });
			await page.evaluate(() => {
				window.__rise = null;
				const look = () => {
					const list = [...document.querySelectorAll('.content .hh-rise')].find((el) => el.style.transform !== '');
					if (list) {
						window.__rise = { names: document.getAnimations().map((a) => a.animationName).filter((name) => /rise/.test(name ?? '')) };
						return;
					}
					requestAnimationFrame(look);
				};
				requestAnimationFrame(look);
			});
			await page.locator('nav.rail').getByRole('link', { name: 'Albums', exact: true }).click();
			await page.waitForFunction(() => window.__rise !== null, null, { timeout: 5000 });
			const rise = await page.evaluate(() => window.__rise);
			assert.deepEqual(rise.names, [], 'the page rose with the list');
		} finally {
			await liquid();
			await page.close();
		}
		assert.deepEqual(problems, []);
	});


	test('Settings offers Terminal its scheme, its accent and its dots, and the other two the aurora', async () => {
		await settings({ theme: 'terminal' });
		const { page, problems } = await watchedPage();
		const rows = async () => ({
			scheme: await select(page, 'scheme').count(),
			accent: await select(page, 'accent').count(),
			dots: await select(page, 'dots').count(),
			art: await select(page, 'playerArt').count(),
			aurora: await select(page, 'aurora').count(),
			face: new Map(await optionsOf(select(page, 'font'))).get('manrope')
		});
		try {
			await page.goto(app.url + '/settings', { waitUntil: 'networkidle' });
			assert.equal(await page.locator('input[name=\"theme\"]').inputValue(), 'terminal');
			assert.equal(new Map(await optionsOf(select(page, 'theme'))).get('terminal'), 'Terminal');
			assert.deepEqual(await rows(), { scheme: 1, accent: 1, dots: 1, art: 1, aurora: 0, face: 'JetBrains Mono' });
			// The rows follow the theme picked, and it saves as it is picked.
			await autosaved(page, () => pick(select(page, 'theme'), 'dark'));
			assert.deepEqual(await rows(), { scheme: 0, accent: 0, dots: 0, art: 0, aurora: 1, face: 'Manrope' });
			// Saved without them on the form, the two keep their stored values:
			// set behind the page's back, they survive the next save.
			await settings({ accent: 'cyan', dots: 'medium' });
			await autosaved(page, () => pick(select(page, 'gridSize'), 'compact'));
			const saved = await (await context.request.get(`${app.url}/api/settings`)).json();
			assert.deepEqual([saved.theme, saved.accent, saved.dots], ['dark', 'cyan', 'medium']);
		} finally {
			await settings({ gridSize: 'comfortable' });
			await liquid();
			await page.close();
		}
		assert.deepEqual(problems, []);
	});

	/*
	 * The album page's actions as one row of words between brackets: the mix
	 * button and the heart are components of their own, and kept their own
	 * padding and their own look.
	 */
	test('the album page\'s actions line up, and the heart and share sit by the rating', async () => {
		await settings({ theme: 'terminal' });
		const { page, problems } = await watchedPage();
		const row = () =>
			page.evaluate(() => {
				const actions = document.querySelector('.hero .actions, header .actions');
				const edge = (el) => {
					// Where its first bracket is drawn: the box, less the padding before it.
					const box = el.getBoundingClientRect();
					return Math.round(box.left + Number.parseFloat(getComputedStyle(el).paddingLeft));
				};
				const fav = document.querySelector('.badge-row .fav');
				const share = document.querySelector('.badge-row .share');
				// The ones drawn: More is there on a phone only.
				const shown = [...actions.children].filter((el) => el.getClientRects().length > 0);
				return {
					brackets: [...shown, fav, share].filter((el) => !el.classList.contains('hh-button--primary')).map((el) => edge(el) - Math.round(el.getBoundingClientRect().left)),
					heart: [getComputedStyle(fav, '::before').content, getComputedStyle(fav, '::after').content].join(' '),
					word: fav.querySelector('.label') ? getComputedStyle(fav.querySelector('.label')).display : 'absent',
					// PulseHeart names itself by a visually hidden span.
					name: fav.querySelector('.sr-only')?.textContent,
					lefts: shown.map((el) => Math.round(el.getBoundingClientRect().left)),
					tops: shown.map((el) => Math.round(el.getBoundingClientRect().top + el.getBoundingClientRect().height / 2))
				};
			});
		try {
			await page.goto(app.url + '/albums/al1', { waitUntil: 'networkidle' });
			let drawn = await row();
			assert.deepEqual([...new Set(drawn.brackets)], [2], 'an action\'s bracket is not 2px inside its box');
			assert.match(drawn.heart, /^"\[".* "\]"/);
			assert.notEqual(drawn.word, 'none', 'the word is not drawn');
			assert.equal(drawn.name, 'Add to favourites', 'the brackets or the word are in its name');
			assert.equal(new Set(drawn.tops).size, 1, 'the actions do not fit on one line at 1440px');
			// Narrow enough to wrap: what starts the second line is under the play key.
			await page.setViewportSize({ width: 1000, height: 900 });
			drawn = await row();
			const second = drawn.tops.findIndex((top) => top > drawn.tops[0] + 12);
			assert.ok(second > 0, 'the row did not wrap at 1000px');
			assert.ok(Math.abs(drawn.lefts[second] - drawn.lefts[0]) <= 1, `the second line starts ${drawn.lefts[second] - drawn.lefts[0]}px from the first`);

			// In Liquid the heart is a glyph, as it was.
			await page.setViewportSize({ width: 1440, height: 900 });
			await settings({ theme: 'dark' });
			await page.reload({ waitUntil: 'networkidle' });
			drawn = await row();
			assert.equal(drawn.word, 'none');
			assert.match(drawn.heart, /^none none$/);
		} finally {
			await liquid();
			await page.close();
		}
		assert.deepEqual(problems, []);
	});

	/*
	 * Each scheme is measured as drawn: the four text tones on the pane, the
	 * two signals, and the dark label on each of the six accents and on the
	 * accent from the artwork.
	 */
	test('every colour scheme keeps its text at 4.5:1 on the pane and its label at 4.5:1 on each accent', async () => {
		await settings({ theme: 'terminal' });
		const { page, problems } = await watchedPage();
		try {
			await page.goto(app.url + '/settings', { waitUntil: 'networkidle' });
			const schemes = (await optionsOf(select(page, 'scheme'))).map(([value]) => value);
			assert.equal(schemes.length, 10);
			assert.equal(schemes[0], 'heddohon');
			const measured = await page.evaluate((schemes) => {
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
				const low = [];
				const grounds = {};
				for (const scheme of schemes) {
					root.dataset.scheme = scheme;
					root.dataset.accent = 'artwork';
					grounds[scheme] = rgb('var(--bg-base)').join(',');
					for (const tone of ['strong', 'default', 'muted', 'faint']) {
						const found = ratio(`var(--text-${tone})`, 'var(--bg-surface)');
						if (found < 4.5) low.push(`${scheme}: --text-${tone} at ${found.toFixed(2)}`);
					}
					for (const signal of ['danger', 'positive']) {
						const found = ratio(`var(--${signal})`, 'var(--bg-surface)');
						if (found < 4.5) low.push(`${scheme}: --${signal} at ${found.toFixed(2)}`);
					}
					for (const accent of ['artwork', 'green', 'amber', 'cyan', 'violet', 'rose', 'white']) {
						root.dataset.accent = accent;
						const found = ratio('var(--accent-contrast)', 'var(--accent)');
						if (found < 4.5) low.push(`${scheme}: the label on ${accent} at ${found.toFixed(2)}`);
					}
				}
				probe.remove();
				return { low, grounds };
			}, schemes);
			assert.deepEqual(measured.low, []);
			// Ten grounds, so a scheme whose rules did not apply shows as a repeat.
			assert.equal(new Set(Object.values(measured.grounds)).size, 10, JSON.stringify(measured.grounds));

			// Chosen and saved, it is on the root and the bar a phone draws is its ground.
			await page.reload({ waitUntil: 'networkidle' });
			await autosaved(page, () => pick(select(page, 'scheme'), 'nord'));
			await page.waitForFunction(() => document.documentElement.dataset.scheme === 'nord');
			assert.deepEqual((await computed(page, 'var(--bg-base)')).slice(0, 3), [0x2e, 0x34, 0x40]);
			await page.reload({ waitUntil: 'networkidle' });
			assert.equal(await page.locator('meta[name="theme-color"]').getAttribute('content'), '#2e3440');
			// Liquid does not take it.
			await settings({ theme: 'dark' });
			await page.reload({ waitUntil: 'networkidle' });
			assert.notDeepEqual((await computed(page, 'var(--bg-base)')).slice(0, 3), [0x2e, 0x34, 0x40]);
		} finally {
			await settings({ scheme: 'heddohon' });
			await liquid();
			await page.close();
		}
		assert.deepEqual(problems, []);
	});

	/*
	 * Two lists that kept Liquid's hover: a wash of the accent that opens from
	 * the left, with the cover lifting over a glow or the name stepping right.
	 */
	test('the tiles under Jump back in and the playlists in the picker hover as flat rows', async () => {
		await settings({ theme: 'terminal' });
		const { page, problems } = await watchedPage();
		const hover = (selector, moved) =>
			page.evaluate(
				([selector, moved]) => {
					const row = document.querySelector(selector);
					const wash = getComputedStyle(row, '::before');
					return { wash: wash.backgroundImage, moved: getComputedStyle(row.querySelector(moved)).translate };
				},
				[selector, moved]
			);
		try {
			await page.goto(app.url + '/', { waitUntil: 'networkidle' });
			const tile = page.locator('section.resume a.tile').first();
			await tile.hover();
			await page.waitForTimeout(400);
			assert.deepEqual(await hover('section.resume a.tile:hover', '.thumb'), { wash: 'none', moved: 'none' });
			assert.equal(await tile.locator('.thumb').evaluate((el) => getComputedStyle(el, '::before').display), 'none', 'the cover still casts a glow');

			await page.goto(app.url + '/albums/al1', { waitUntil: 'networkidle' });
			await page.locator('.track').first().getByRole('button', { name: 'Add Song 1a to a playlist' }).click();
			const row = page.locator('dialog.picker .row').first();
			await row.hover();
			await page.waitForTimeout(400);
			assert.deepEqual(await hover('dialog.picker .row:hover', '.name'), { wash: 'none', moved: 'none' });
		} finally {
			await liquid();
			await page.close();
		}
		assert.deepEqual(problems, []);
	});

	test('the command line opens on :, ; and Ctrl+K, suggests, runs, and says what went wrong', async () => {
		await settings({ theme: 'terminal' });
		const { page, problems } = await watchedPage();
		try {
			await page.goto(app.url + '/', { waitUntil: 'networkidle' });
			const field = page.getByRole('combobox', { name: 'Command' });

			// The button names its shortcut, and is drawn in the accent until the line has been opened once.
			const button = page.getByRole('button', { name: 'Command line' });
			assert.match(await button.textContent(), /command\s*Ctrl K/);
			assert.equal(await button.evaluate((node) => node.classList.contains('fresh')), true);

			// A command's name suggests the commands it begins.
			await page.keyboard.press(':');
			await field.waitFor();
			await field.pressSequentially('se');
			const names = await page.getByRole('option').allTextContents();
			assert.ok(names.some((name) => name.startsWith('seek')) && names.some((name) => name.startsWith('search')), names.join(' | '));

			// cd goes to a page; the line closes and the strip says where.
			await field.fill('');
			await field.pressSequentially('cd albums');
			await page.keyboard.press('Enter');
			await page.waitForURL(/\/albums$/);
			await field.waitFor({ state: 'detached', timeout: 2000 });
			await page.getByRole('status').filter({ hasText: '~/albums' }).waitFor();

			// play looks the words up and plays the best match.
			await page.keyboard.press('Control+k');
			await field.pressSequentially('play Artist 0003');
			await page.getByRole('option').first().waitFor();
			await page.keyboard.press('Enter');
			await page.getByRole('status').filter({ hasText: /^playing Song 3a/ }).waitFor();
			assert.equal(await page.evaluate(() => document.title.includes('Song 3a')), true);

			// `;`, the same key without Shift.
			await page.keyboard.press(';');
			await field.pressSequentially('vol 40');
			await page.keyboard.press('Enter');
			await page.getByRole('status').filter({ hasText: 'volume 40' }).waitFor();

			// A line that is not a command keeps the line open with why.
			await page.keyboard.press(':');
			await field.pressSequentially('frobnicate');
			await page.keyboard.press('Enter');
			await page.getByRole('alert').filter({ hasText: 'frobnicate: no such command' }).waitFor();
			await page.keyboard.press('Escape');
			assert.equal(await field.count(), 0);
			assert.equal(await button.evaluate((node) => node.classList.contains('fresh')), false, 'the button still asks to be found');

			// Typing in a field does not open it.
			await page.goto(app.url + '/search', { waitUntil: 'networkidle' });
			await page.getByRole('searchbox').first().pressSequentially('a:b');
			assert.equal(await field.count(), 0, 'a colon typed into the search field opened the command line');
		} finally {
			await liquid();
			await page.close();
		}
		assert.deepEqual(problems, []);
	});

	test('cd goes to a section of Settings, and eq sets the equaliser', async () => {
		await settings({ theme: 'terminal' });
		const { page, problems } = await watchedPage();
		const command = async (line, said) => {
			await page.keyboard.press('Control+k');
			const field = page.getByRole('combobox', { name: 'Command' });
			await field.pressSequentially(line);
			await page.keyboard.press('Enter');
			await page.getByRole('status').filter({ hasText: said }).waitFor();
		};
		try {
			await page.goto(app.url + '/', { waitUntil: 'networkidle' });
			const field = page.getByRole('combobox', { name: 'Command' });

			// A slash after settings lists its sections; before it, the places.
			await page.keyboard.press('Control+k');
			await field.pressSequentially('cd settings/s');
			const options = await page.getByRole('option').allTextContents();
			assert.deepEqual(options.map((option) => option.trim()), ['settings/security', 'settings/sharing', 'settings/storage']);
			await page.keyboard.press('Escape');

			await command('cd settings/security', '~/settings/security');
			assert.match(page.url(), /\/settings\?tab=security$/);
			await page.getByRole('heading', { name: 'Two-step sign-in' }).waitFor();

			// From Settings itself: the open section follows the address.
			await command('cd settings/playback', '~/settings/playback');
			await page.getByRole('heading', { name: 'Transcoding' }).waitFor();
			assert.equal(await page.getByRole('heading', { name: 'Two-step sign-in' }).isVisible(), false);

			await page.keyboard.press('Control+k');
			await field.pressSequentially('cd settings/nowhere');
			await page.keyboard.press('Enter');
			await page.getByRole('alert').filter({ hasText: 'Settings has appearance' }).waitFor();
			await page.keyboard.press('Escape');

			await command('eq bass', 'equaliser bass');
			const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('heddohon:audio-processing')));
			assert.equal(saved.enabled, true);
			assert.deepEqual(saved.gains, [6, 5, 4, 2, 0, 0, 0, 0, 0, 0]);
			await command('eq off', /^processing off/);
			assert.equal((await page.evaluate(() => JSON.parse(localStorage.getItem('heddohon:audio-processing')))).enabled, false);
		} finally {
			await page.evaluate(() => localStorage.removeItem('heddohon:audio-processing')).catch(() => undefined);
			await liquid();
			await page.close();
		}
		assert.deepEqual(problems, []);
	});

	test('the command line is Terminal\'s alone', async () => {
		const { page } = await watchedPage();
		try {
			await page.goto(app.url + '/', { waitUntil: 'networkidle' });
			await page.keyboard.press(':');
			// In the DOM at all: the strip is hidden outside Terminal, and a line open
			// in it would hold the focus out of sight.
			assert.equal(await page.locator('input[aria-label="Command"]').count(), 0);
			assert.equal(await page.getByRole('button', { name: 'Command line' }).isVisible(), false);
		} finally {
			await page.close();
		}
	});
});

describe('Phosphor', () => {
	/* As for Terminal: each test sets the theme and puts Liquid back. */
	const settings = (patch) => context.request.patch(`${app.url}/api/settings`, { data: patch, headers: { origin: app.url } });
	const liquid = () => settings({ theme: 'dark', accent: 'artwork' });

	test('no page logs an error in it', async () => {
		await settings({ theme: 'phosphor' });
		const { page, problems } = await watchedPage();
		try {
			for (const path of ['/', '/albums', '/albums/al1', '/artists', '/artists/ar1', '/favourites', '/genres', '/radio', '/library', '/playlists', '/playlists/import', '/folders', '/history', '/stats', '/stats/recap', '/search?q=song', '/people', '/settings']) {
				const response = await page.goto(app.url + path, { waitUntil: 'networkidle' });
				assert.equal(response?.status(), 200, path);
				assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'phosphor', path);
			}
		} finally {
			await liquid();
			await page.close();
		}
		assert.deepEqual(problems, []);
	});

	/*
	 * Opaque panes over the ground alone while a red cover plays, as in
	 * Terminal, and the player's title drawn as a display: in the dot-matrix
	 * face, in the accent, glowing, with the lamp under the pause glyph lit.
	 */
	test('is opaque metal panes over the ground alone, with the player\'s title lit as a display', async () => {
		await settings({ theme: 'phosphor' });
		subsonic.state.audio = { type: 'audio/wav', body: silentWav(30) };
		subsonic.state.coverColors.set('al-37', [220, 60, 30]);
		const { page, problems } = await watchedPage();
		try {
			await page.goto(app.url + '/albums/al37', { waitUntil: 'networkidle' });
			await page.getByRole('button', { name: 'Play Song 37a', exact: true }).click();
			await page.waitForFunction(() => [...document.querySelectorAll('audio')].some((a) => !a.paused && a.currentTime > 0));
			await page.waitForTimeout(2200);
			const seen = await page.evaluate(() => {
				const rail = document.querySelector('nav.rail');
				const panel = document.querySelector('aside.panel');
				const title = panel.querySelector('.title');
				const accent = document.createElement('div');
				accent.style.color = 'var(--accent)';
				document.body.append(accent);
				const drawn = {
					blur: [getComputedStyle(rail).backdropFilter, getComputedStyle(panel).backdropFilter],
					tint: [getComputedStyle(rail, '::before').display, getComputedStyle(rail, '::after').display],
					radius: getComputedStyle(rail).borderTopLeftRadius,
					canvas: getComputedStyle(document.documentElement).backgroundColor,
					bar: document.querySelector('meta[name="theme-color"]').getAttribute('content'),
					face: getComputedStyle(document.body).fontFamily.split(',')[0].replaceAll('"', '').trim(),
					titleFace: getComputedStyle(title).fontFamily.split(',')[0].replaceAll('"', '').trim(),
					titleColour: getComputedStyle(title).color === getComputedStyle(accent).color,
					titleGlow: getComputedStyle(title).textShadow,
					grid: getComputedStyle(panel.querySelector('.text'), '::after').backgroundImage,
					lamp: getComputedStyle(panel.querySelector('.play'), '::after').boxShadow
				};
				accent.remove();
				return drawn;
			});
			assert.deepEqual(seen.blur, ['none', 'none']);
			assert.deepEqual(seen.tint, ['none', 'none'], 'a tint layer is painted');
			assert.equal(seen.radius, '6px');
			assert.equal(seen.canvas, 'rgb(10, 11, 12)', 'the canvas took the cover\'s colour');
			assert.equal(seen.bar, '#0a0b0c');
			assert.equal(seen.face, 'Barlow');
			assert.equal(seen.titleFace, 'DotGothic16');
			assert.ok(seen.titleColour, 'the title is not in the accent');
			assert.notEqual(seen.titleGlow, 'none');
			assert.match(seen.grid, /repeating-linear-gradient/, 'the display has no control grid');
			assert.notEqual(seen.lamp, 'none', 'the lamp under the pause glyph is not lit while it plays');

			await page.getByRole('button', { name: 'Pause', exact: true }).first().click();
			await page.waitForFunction(() => getComputedStyle(document.querySelector('aside.panel .play'), '::after').boxShadow === 'none');
		} finally {
			await liquid();
			subsonic.state.audio = null;
			subsonic.state.coverColors.delete('al-37');
			await page.close();
		}
		assert.deepEqual(problems, []);
	});

	/*
	 * The accent from the artwork is swept round the hue circle at the lowest
	 * saturation `artwork.ts` writes and at a high one; each fixed accent is
	 * measured as set. The accent as text on a pane, the dark label on the
	 * accent and the lamps' colour on a pane each hold 4.5:1, as do the text
	 * tones.
	 */
	test('every accent, from the artwork or fixed, and its lamps hold 4.5:1', async () => {
		await settings({ theme: 'phosphor' });
		const { page, problems } = await watchedPage();
		try {
			await page.goto(app.url + '/settings', { waitUntil: 'networkidle' });
			const measured = await page.evaluate(() => {
				const root = document.documentElement;
				root.style.transition = 'none';
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
				const low = [];
				const check = (name) => {
					for (const [label, one, two] of [
						['the accent on the pane', 'var(--accent)', 'var(--bg-surface)'],
						['the label on the accent', 'var(--accent-contrast)', 'var(--accent)'],
						['the lamps on the pane', 'var(--led)', 'var(--bg-surface)']
					]) {
						const found = ratio(one, two);
						if (found < 4.5) low.push(`${name}: ${label} at ${found.toFixed(2)}`);
					}
				};
				for (const tone of ['strong', 'default', 'muted', 'faint']) {
					const found = ratio(`var(--text-${tone})`, 'var(--bg-surface)');
					if (found < 4.5) low.push(`--text-${tone} at ${found.toFixed(2)}`);
				}
				root.dataset.accent = 'artwork';
				for (let hue = 0; hue < 360; hue += 15) {
					for (const saturation of ['22%', '70%']) {
						root.style.setProperty('--art-h', String(hue));
						root.style.setProperty('--art-s', saturation);
						check(`hue ${hue} at ${saturation}`);
					}
				}
				const fixed = {};
				for (const accent of ['green', 'amber', 'cyan', 'violet', 'rose', 'white']) {
					root.dataset.accent = accent;
					check(accent);
					fixed[accent] = [rgb('var(--accent)').join(','), rgb('var(--led)').join(',')];
				}
				probe.remove();
				return { low, fixed };
			});
			assert.deepEqual(measured.low, []);
			const accents = Object.values(measured.fixed).map(([accent]) => accent);
			assert.equal(new Set(accents).size, 6, 'two fixed accents are the same colour');
			// The lamps set the accent off: amber beside cyan, cyan beside amber.
			assert.notEqual(measured.fixed.cyan[1], measured.fixed.amber[1]);
			assert.equal(measured.fixed.amber[1], measured.fixed.cyan[0]);
		} finally {
			await liquid();
			await page.close();
		}
		assert.deepEqual(problems, []);
	});

	test('Settings offers it the accent and not Terminal\'s scheme, dots or player artwork', async () => {
		await settings({ theme: 'phosphor' });
		const { page, problems } = await watchedPage();
		try {
			await page.goto(app.url + '/settings', { waitUntil: 'networkidle' });
			assert.equal(await page.locator('input[name=\"theme\"]').inputValue(), 'phosphor');
			assert.equal(new Map(await optionsOf(select(page, 'theme'))).get('phosphor'), 'Phosphor');
			const rows = {
				scheme: await select(page, 'scheme').count(),
				accent: await select(page, 'accent').count(),
				dots: await select(page, 'dots').count(),
				art: await select(page, 'playerArt').count(),
				aurora: await select(page, 'aurora').count(),
				face: new Map(await optionsOf(select(page, 'font'))).get('manrope')
			};
			assert.deepEqual(rows, { scheme: 0, accent: 1, dots: 0, art: 0, aurora: 0, face: 'Barlow' });
			await autosaved(page, () => pick(select(page, 'accent'), 'amber'));
			await page.waitForFunction(() => document.documentElement.dataset.accent === 'amber');
		} finally {
			await liquid();
			await page.close();
		}
		assert.deepEqual(problems, []);
	});
});

describe('signing in on a slow device', () => {
	/*
	 * Svelte sets an input's `value` attribute as it hydrates, over what was
	 * typed before. On a slow phone the name typed while the page's code ran
	 * was gone, and the press on Sign in found the field empty. The page's
	 * name field takes the server's answer as its default value instead.
	 */
	test('a name and password typed before the page has hydrated still sign in', async () => {
		const slow = await browser.newContext({ viewport: { width: 1440, height: 900 } });
		try {
			const page = await slow.newPage();
			const cdp = await slow.newCDPSession(page);
			await cdp.send('Emulation.setCPUThrottlingRate', { rate: 6 });
			await page.goto(`${app.url}/login`);
			await page.getByLabel('Username').fill('testuser');
			await page.getByLabel('Password').fill('testpass');
			await page.getByRole('button', { name: 'Sign in', exact: true }).click();
			await page.waitForURL((url) => url.pathname === '/', { timeout: 15_000 });
		} finally {
			await slow.close();
		}
	});
});
