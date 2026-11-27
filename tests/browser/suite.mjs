/**
 * What the browser test files share: the mock servers, the built app run
 * against them, one Chromium and a signed-in context, and the helpers the
 * tests drive the page with. Each file calls `setUpSuite()` and gets its own
 * of each, so the files run in parallel (`node --test` runs a file a process).
 *
 * The bindings are live: `app`, `context` and the rest are set by the
 * `before` hook `setUpSuite` adds, and read by the tests after it.
 */
import assert from 'node:assert/strict';
import { after, before } from 'node:test';
import { chromium } from 'playwright';
import { startApp } from '../e2e/harness.mjs';
import { silentWav, startJellyfin, startSubsonic } from '../e2e/mocks.mjs';

export let subsonic;
export let jellyfin;
export let app;
export let browser;
export let context;

/**
 * Starts the mock servers, the app and a signed-in browser for the file that
 * calls it, and stops them after. Call it once, at the top of a test file.
 */
export function setUpSuite() {
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
		// The aurora moves unless an account says otherwise, and headless Chromium
		// blurs the glass over it in software: about a third of a core, under tests
		// that time what the page does and read its colours. It has its own test.
		await context.request.patch(`${app.url}/api/settings`, { data: { aurora: 'off' }, headers: { origin: app.url } });
		// The notice of features that are off, which an administrator is shown once
		// on the home page; its own test turns it back on.
		await context.request.patch(`${app.url}/api/settings`, {
			data: { featuresSeen: ['newReleases', 'lrclib', 'autoeq', 'discord', 'discordCovers', 'listenbrainz', 'mcp', 'profiles'] },
			headers: { origin: app.url }
		});
	});

	after(async () => {
		await browser?.close();
		await app?.stop();
		await subsonic?.close();
		await jellyfin?.close();
	});
}

/**
 * The selects are Svelte Bits' GlideSelect (`lib/components/Select.svelte`): a
 * combobox whose options are drawn only while its menu is open, and chosen on
 * a press. One with a form field is `[data-select="<name>"]`.
 */
export const select = (page, name) => page.locator(`[data-select="${name}"] [role="combobox"]`);
export const menuOf = (combobox) => combobox.locator('xpath=..');
export async function pick(combobox, value) {
	await combobox.click();
	const option = menuOf(combobox).locator(`[role="option"][data-value="${value}"]`);
	await option.click();
	await option.waitFor({ state: 'detached' });
}
export async function pickLabel(combobox, label) {
	await combobox.click();
	const option = menuOf(combobox).getByRole('option', { name: label, exact: true });
	await option.click();
	await option.waitFor({ state: 'detached' });
}
/**
 * Appearance and Playback save as they change (since 2026-11-10): runs
 * `change`, waits for the save it sets off, then for any save a change made
 * meanwhile sets off after it.
 */
export async function autosaved(page, change) {
	const saved = page.waitForResponse((response) => response.url().includes('?/save') && response.request().method() === 'POST');
	await change();
	await saved;
	await page.waitForTimeout(500);
	await page.locator('form[action="?/save"]:not([aria-busy="true"])').waitFor({ state: 'attached' });
}
/** The options as `[value, label]`, read with the menu open and closed again. */
export async function optionsOf(combobox) {
	await combobox.click();
	const options = menuOf(combobox).getByRole('option');
	await options.first().waitFor();
	const read = await options.evaluateAll((all) => all.map((option) => [option.dataset.value, option.textContent.trim()]));
	await combobox.press('Escape');
	return read;
}
/** The label of the choice the closed control shows. */
export const shown = async (combobox) => (await combobox.textContent()).trim();

/**
 * Sets an ElasticSlider (`role="slider"`) by its keys: Home, then the right
 * arrow a step at a time. Its value is `aria-valuenow`.
 */
export async function setSlider(slider, value, { min, step = 1 }) {
	await slider.focus();
	await slider.press('Home');
	for (let at = min; at < value; at += step) await slider.press('ArrowRight');
}
export const sliderValue = (slider) => slider.getAttribute('aria-valuenow');

/** A page that records every console error and uncaught exception. */
export async function watchedPage() {
	const page = await context.newPage();
	const problems = [];
	page.on('console', (message) => {
		if (message.type() === 'error') problems.push(`${page.url()}: ${message.text()}`);
	});
	page.on('pageerror', (err) => problems.push(`${page.url()}: ${err.message}`));
	return { page, problems };
}

/*
 * Audio the browser can decode, for a check that stays on the track it pressed.
 * The mock's default stream is not audio, and the player passes over a file it
 * cannot play.
 */
export function playable(t) {
	subsonic.state.audio = { type: 'audio/wav', body: silentWav(60) };
	t.after(() => {
		subsonic.state.audio = null;
	});
}
