/**
 * End-to-end checks against the built app and mock music servers.
 *
 *   npm run build && npm run test:e2e
 *
 * Tests in this file run in order and share one app process, so a later test
 * may rely on the sign-in an earlier one made. Everything that changes shared
 * state (settings, credentials) says so and puts it back.
 */
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { Client, startApp } from './harness.mjs';
import { startAutoEq, startJellyfin, startStationHost, startSubsonic } from './mocks.mjs';

let subsonic;
let jellyfin;
let app;
/** Signed in to the Subsonic mock by the first sign-in test. */
let user;

before(async () => {
	subsonic = await startSubsonic({ artistCount: 250 });
	jellyfin = await startJellyfin();
	app = await startApp({ subsonicUrl: subsonic.url, jellyfinUrl: jellyfin.url });
	user = new Client(app.url);
});

after(async () => {
	await app?.stop();
	await subsonic?.close();
	await jellyfin?.close();
});

/** Fails with the app's log attached, which is where the reason usually is. */
function explain(message) {
	return `${message}\n--- app output ---\n${app.output()}`;
}

/**
 * Signs in a new client as `username`, an account nothing is remembered for
 * yet, and runs `run` with it and the call counts reset. The mock serves one
 * user at a time, so it is switched for the length of `run` and put back.
 */
async function asFreshAccount(username, run) {
	subsonic.state.username = username;
	subsonic.state.password = `${username}pass`;
	try {
		const client = new Client(app.url);
		await client.signIn({ username, password: `${username}pass`, backend: 'subsonic' });
		subsonic.calls.reset();
		await run(client);
	} finally {
		subsonic.state.username = 'testuser';
		subsonic.state.password = 'testpass';
	}
}

describe('how long a sign-in lasts', () => {
	/** The session cookie's `Max-Age` from a sign-in, in seconds. */
	async function lifetime(url) {
		const response = await fetch(`${url}/login`, {
			method: 'POST',
			redirect: 'manual',
			headers: { origin: url, accept: 'text/html', 'content-type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({ username: 'testuser', password: 'testpass', backend: 'subsonic', next: '/' })
		});
		assert.equal(response.status, 303);
		const cookie = response.headers.getSetCookie().find((c) => /heddohon_session=/.test(c) && !/max-age=0/i.test(c));
		return Number(/max-age=(\d+)/i.exec(cookie ?? '')?.[1]);
	}

	test('30 days unless set', async () => {
		assert.equal(await lifetime(app.url), 30 * 24 * 60 * 60);
	});

	test('whatever HEDDOHON_SESSION_HOURS says, above 30 days as well as below', async () => {
		for (const hours of [2000, 12]) {
			const set = await startApp({ subsonicUrl: subsonic.url, jellyfinUrl: jellyfin.url, env: { HEDDOHON_SESSION_HOURS: String(hours) } });
			try {
				assert.equal(await lifetime(set.url), hours * 60 * 60);
			} finally {
				await set.stop();
			}
		}
	});
});

describe('the gate', () => {
	test('/healthz answers without a session and names no upstream URL', async () => {
		const response = await fetch(`${app.url}/healthz`);
		assert.equal(response.status, 200);
		const body = await response.text();
		assert.match(body, /"status":"ok"/);
		assert.ok(!body.includes(subsonic.url), 'the upstream URL must not appear');
	});

	test('the manifest answers without a session and names itself as its related app', async () => {
		const response = await fetch(`${app.url}/manifest.webmanifest`);
		assert.equal(response.status, 200);
		const manifest = await response.json();
		assert.equal(manifest.display, 'standalone');
		// What `getInstalledRelatedApps` matches an installed app against.
		assert.deepEqual(manifest.related_applications, [{ platform: 'webapp', url: `${app.url}/manifest.webmanifest` }]);
	});

	test('the bars a phone paints are the theme\'s ground: in the page and in the manifest it asks for', async () => {
		const client = new Client(app.url);
		await client.signIn({ username: 'testuser', password: 'testpass', backend: 'subsonic' });
		const head = async () => (await client.page('/albums')).html.split('</head>')[0];
		try {
			const dark = await head();
			assert.match(dark, /name="theme-color" content="#0b0c0f"/);
			assert.match(dark, /rel="manifest" href="\/manifest\.webmanifest"/);
			// An installed app on iOS draws the page under its status bar and the Dynamic Island.
			assert.match(dark, /apple-mobile-web-app-status-bar-style" content="black-translucent"/);

			await client.json('/api/settings', 'PATCH', { theme: 'light' });
			const light = await head();
			assert.match(light, /name="theme-color" content="#f0e7d5"/);
			assert.match(light, /rel="manifest" href="\/manifest\.webmanifest\?theme=light"/);
		} finally {
			await client.json('/api/settings', 'PATCH', { theme: 'dark' });
		}

		const colours = async (query) => {
			const manifest = await (await fetch(`${app.url}/manifest.webmanifest${query}`)).json();
			return [manifest.theme_color, manifest.background_color];
		};
		assert.deepEqual(await colours(''), ['#0b0c0f', '#0b0c0f']);
		assert.deepEqual(await colours('?theme=light'), ['#f0e7d5', '#f0e7d5']);
		assert.deepEqual(await colours('?theme=%22%3E'), ['#0b0c0f', '#0b0c0f'], 'anything else is the dark one');
	});

	test('the server vouches for the Android app without a session: its package and the release key, and any key added', async () => {
		const RELEASE = '3C:D0:5B:A1:45:77:D7:1F:68:4E:61:51:AF:7C:0F:3F:BE:10:15:A8:BB:52:B2:28:FA:54:B4:11:AC:14:DE:52';
		const response = await fetch(`${app.url}/.well-known/assetlinks.json`);
		assert.equal(response.status, 200);
		assert.match(response.headers.get('content-type'), /^application\/json/);
		assert.deepEqual(await response.json(), [
			{
				relation: ['delegate_permission/common.handle_all_urls'],
				target: { namespace: 'android_app', package_name: 'app.heddohon.android', sha256_cert_fingerprints: [RELEASE] }
			}
		]);

		// A key of someone's own, written in lower case, is listed beside it in upper case.
		const own = Array.from({ length: 32 }, (_, i) => (i + 160).toString(16)).join(':');
		const added = await startApp({ subsonicUrl: subsonic.url, jellyfinUrl: jellyfin.url, env: { HEDDOHON_ANDROID_FINGERPRINTS: ` ${own} ` } });
		try {
			const [statement] = await (await fetch(`${added.url}/.well-known/assetlinks.json`)).json();
			assert.deepEqual(statement.target.sha256_cert_fingerprints, [RELEASE, own.toUpperCase()]);
		} finally {
			await added.stop();
		}
	});

	test('a page without a session redirects to sign-in, with the path kept', async () => {
		const response = await new Client(app.url).request('/artists?page=2', { headers: { accept: 'text/html' } });
		assert.equal(response.status, 303);
		assert.equal(response.headers.get('location'), '/login?next=%2Fartists%3Fpage%3D2');
	});

	test('an API call without a session is a JSON 401, not a redirect', async () => {
		const response = await new Client(app.url).request('/api/settings');
		assert.equal(response.status, 401);
		assert.deepEqual(await response.json(), { error: 'not_authenticated' });
	});

	test('responses carry the hardening headers, early exits included', async () => {
		for (const path of ['/login', '/api/settings']) {
			const response = await new Client(app.url).request(path);
			assert.equal(response.headers.get('x-content-type-options'), 'nosniff', path);
			assert.match(response.headers.get('cache-control') ?? '', /no-store/, path);
			assert.match(response.headers.get('vary') ?? '', /Cookie/, path);
		}
		const page = await new Client(app.url).request('/login');
		assert.match(page.headers.get('content-security-policy') ?? '', /default-src 'none'/);
		// The microphone for this origin alone (the output control's names), the camera for nobody.
		const policy = page.headers.get('permissions-policy') ?? '';
		assert.match(policy, /microphone=\(self\)/);
		assert.match(policy, /camera=\(\)/);
	});
});

describe('signing in', () => {
	test('a wrong password is refused with 401 and no session', async () => {
		const client = new Client(app.url);
		const response = await client.signIn({ username: 'testuser', password: 'wrong', backend: 'subsonic' });
		assert.equal(response.status, 401);
		assert.ok(!client.cookies.has('heddohon_session'));
	});

	test('a `next` pointing off-site lands on the home page', async () => {
		const client = new Client(app.url);
		const response = await client.signIn({
			username: 'testuser',
			password: 'testpass',
			backend: 'subsonic',
			next: '/.//evil.example'
		});
		assert.equal(response.status, 303);
		assert.equal(response.headers.get('location'), '/');
	});

	test('the right password signs in and follows `next`', async () => {
		const response = await user.signIn({
			username: 'testuser',
			password: 'testpass',
			backend: 'subsonic',
			next: '/artists'
		});
		assert.equal(response.status, 303, explain('sign-in did not redirect'));
		assert.equal(response.headers.get('location'), '/artists');
		assert.ok(user.cookies.has('heddohon_session'));
	});
});

describe('cross-origin writes', () => {
	test('a write from another origin is refused', async () => {
		const response = await user.json('/api/settings', 'PATCH', { theme: 'light' }, { origin: 'https://evil.example' });
		assert.equal(response.status, 403);
		assert.deepEqual(await response.json(), { error: 'cross_origin_forbidden' });
	});

	test('a write with no Origin is refused', async () => {
		const response = await user.json('/api/settings', 'PATCH', { theme: 'light' }, { origin: null });
		assert.equal(response.status, 403);
	});

	test('a percent-encoded path does not get around the check', async () => {
		const response = await user.json(
			'/%61pi/star',
			'POST',
			{ id: 's9a', kind: 'song', starred: true },
			{ origin: 'https://evil.example' }
		);
		assert.equal(response.status, 403);
		assert.ok(!subsonic.state.starred.has('s9a'));
	});
});

describe('settings', () => {
	test('a theme that is not on the list never reaches the HTML', async () => {
		const response = await user.json('/api/settings', 'PATCH', { theme: '"><script>alert(1)</script>' });
		assert.equal(response.status, 200);
		const { html } = await user.page('/albums');
		assert.match(html, /data-theme="dark"/);
		assert.ok(!html.includes('<script>alert(1)'));
	});

	test('crossfading within an album is off until it is asked for, and takes only a boolean', async () => {
		const before = await (await user.json('/api/settings', 'PATCH', {})).json();
		assert.equal(before.crossfadeWithinAlbum, false);
		const on = await (await user.json('/api/settings', 'PATCH', { crossfadeWithinAlbum: true })).json();
		assert.equal(on.crossfadeWithinAlbum, true);
		const bogus = await (await user.json('/api/settings', 'PATCH', { crossfadeWithinAlbum: 'yes' })).json();
		assert.equal(bogus.crossfadeWithinAlbum, true, 'a value that is not a boolean keeps the one stored');
		await user.json('/api/settings', 'PATCH', { crossfadeWithinAlbum: false });
	});

	test('the install card is not dismissed until it is, and takes only a boolean', async () => {
		const before = await (await user.json('/api/settings', 'PATCH', {})).json();
		assert.equal(before.installCardDismissed, false);
		const on = await (await user.json('/api/settings', 'PATCH', { installCardDismissed: true })).json();
		assert.equal(on.installCardDismissed, true);
		const bogus = await (await user.json('/api/settings', 'PATCH', { installCardDismissed: 'no' })).json();
		assert.equal(bogus.installCardDismissed, true, 'a value that is not a boolean keeps the one stored');
		await user.json('/api/settings', 'PATCH', { installCardDismissed: false });
	});

	test('a saved theme is in the first byte of HTML', async () => {
		await user.json('/api/settings', 'PATCH', { theme: 'light' });
		const { html } = await user.page('/albums');
		assert.match(html, /data-theme="light"/);
		await user.json('/api/settings', 'PATCH', { theme: 'dark' });
	});

	test('the font is one of the six offered, and is in the first byte of the page', async () => {
		const geist = await (await user.json('/api/settings', 'PATCH', { font: 'geist' })).json();
		assert.equal(geist.font, 'geist');
		assert.match((await user.page('/search')).html, /<html[^>]* data-font="geist"/);
		const bogus = await (await user.json('/api/settings', 'PATCH', { font: '"><script>' })).json();
		assert.equal(bogus.font, 'geist', 'an unknown value keeps the one stored');
		const manrope = await (await user.json('/api/settings', 'PATCH', { font: 'manrope' })).json();
		assert.equal(manrope.font, 'manrope');
		assert.match((await user.page('/search')).html, /<html[^>]* data-font="manrope"/);
	});

	test('the aurora setting takes one of its three values and nothing else', async () => {
		const moving = await (await user.json('/api/settings', 'PATCH', { aurora: 'moving' })).json();
		assert.equal(moving.aurora, 'moving');
		const bogus = await (await user.json('/api/settings', 'PATCH', { aurora: '"><b>' })).json();
		assert.equal(bogus.aurora, 'moving', 'an unknown value keeps the one stored');
		const off = await (await user.json('/api/settings', 'PATCH', { aurora: 'off' })).json();
		assert.equal(off.aurora, 'off');
	});

	test('the settings page renders, and reads the admin flag once', async () => {
		subsonic.calls.reset();
		const { response, html } = await user.page('/settings');
		assert.equal(response.status, 200, explain('settings page failed'));
		assert.match(html, /Settings/);
		assert.equal(subsonic.calls.get('getUser'), 1);
	});

	test('a settings tab is chosen by the address, with the other groups hidden but still in the form', async () => {
		const section = (html, heading) => html.match(new RegExp(`<section[^>]*>\\s*<div class="group-head[^>]*>\\s*<h2[^>]*>${heading}<`))?.[0] ?? '';
		const storage = (await user.page('/settings?tab=storage')).html;
		assert.doesNotMatch(section(storage, 'Cover cache'), /hidden/);
		assert.match(section(storage, 'Appearance'), /hidden/);
		// Saving reads every field, so the hidden groups' fields are still sent.
		assert.match(storage, /name="transcodeBitrateKbps"/);

		const history = (await user.page('/settings?tab=history')).html;
		assert.doesNotMatch(section(history, 'Listening history'), /hidden/);
		assert.match(section(history, 'Cover cache'), /hidden/);

		const back = (await user.page('/settings?lastfm=linked')).html;
		assert.doesNotMatch(section(back, 'Session &amp; security'), /hidden/, 'the way back from last.fm opens on Account');
		assert.match(section(back, 'Appearance'), /hidden/);
	});
});

describe('artists', () => {
	test('pages are sliced at 100 on the server', async () => {
		const first = await user.page('/artists');
		assert.equal(first.response.status, 200, explain('artists page failed'));
		assert.match(first.html, /Artist 0000/);
		assert.match(first.html, /Artist 0099/);
		assert.ok(!first.html.includes('Artist 0100'));
		assert.match(first.html, /Filter 250 artists/);

		const last = await user.page('/artists?page=3');
		assert.match(last.html, /Artist 0249/);
		assert.ok(!last.html.includes('Artist 0199'));
	});

	test('the filter searches the whole library, not the page', async () => {
		const { html } = await user.page('/artists?q=0249');
		assert.match(html, /Artist 0249/);
		assert.ok(!html.includes('Artist 0001'));
	});

	test('page turns and filter queries inside 30s make one upstream call', async () => {
		// A fresh account, so nothing is remembered for it yet.
		subsonic.state.username = 'second';
		subsonic.state.password = 'secondpass';
		const client = new Client(app.url);
		await client.signIn({ username: 'second', password: 'secondpass', backend: 'subsonic' });
		subsonic.calls.reset();
		for (const path of ['/artists', '/artists?page=2', '/artists?page=3', '/artists?q=00', '/artists?q=01']) {
			assert.equal((await client.page(path)).response.status, 200);
		}
		assert.equal(subsonic.calls.get('getArtists'), 1);
		subsonic.state.username = 'testuser';
		subsonic.state.password = 'testpass';
	});

	test('concurrent requests share the one upstream call', async () => {
		subsonic.state.username = 'third';
		subsonic.state.password = 'thirdpass';
		const client = new Client(app.url);
		await client.signIn({ username: 'third', password: 'thirdpass', backend: 'subsonic' });
		subsonic.calls.reset();
		const pages = await Promise.all(['a', 'b', 'c', 'd', 'e', 'f'].map((q) => client.page(`/artists?q=${q}`)));
		for (const { response } of pages) assert.equal(response.status, 200);
		assert.equal(subsonic.calls.get('getArtists'), 1);
		subsonic.state.username = 'testuser';
		subsonic.state.password = 'testpass';
	});
});

describe('the home page', () => {
	// As an account of its own: the home page reads the starred set, which the
	// favourites tests count the reads of for the shared one.
	test('the latest addition names the album without its year', async () => {
		await asFreshAccount('home', async (client) => {
			const { html } = await client.page('/');
			const featured = /<section class="featured[^"]*">[\s\S]*?<\/section>/.exec(html)?.[0] ?? '';
			assert.match(featured, /Album 0/, explain('the latest addition is missing'));
			// Album 0 is from 2000 in the mock.
			assert.doesNotMatch(featured, /2000/);
		});
	});
});

describe('favourites', () => {
	test('home, every tab and "play favourites" read the starred set once', async () => {
		subsonic.calls.reset();
		assert.match((await user.page('/')).html, /Song 0a/, 'the home page shows a favourite');
		for (const tab of ['songs', 'albums', 'artists']) {
			assert.equal((await user.page(`/favourites?tab=${tab}`)).response.status, 200);
		}
		const tracks = await user.json('/api/tracks', 'POST', { source: 'starred' });
		assert.equal((await tracks.json()).songs.length, 2);
		assert.equal(subsonic.calls.get('getStarred2'), 1);
	});

	test('a star made here shows on the next load, inside the 30s', async () => {
		const response = await user.json('/api/star', 'POST', { id: 's5b', kind: 'song', starred: true });
		assert.equal(response.status, 200);
		assert.match((await user.page('/favourites?tab=songs')).html, /Song 5b/);

		await user.json('/api/star', 'POST', { id: 's5b', kind: 'song', starred: false });
		assert.ok(!(await user.page('/favourites?tab=songs')).html.includes('Song 5b'));
	});

	test('tracks sort by when they were starred and by name', async () => {
		// Starred through the app so the listing is dropped, then dated by hand so
		// the order does not rest on two stars landing in different milliseconds.
		await user.json('/api/star', 'POST', { id: 's5b', kind: 'song', starred: true });
		await user.json('/api/star', 'POST', { id: 's10a', kind: 'song', starred: true });
		subsonic.state.starred.set('s5b', '2026-03-01T00:00:00Z');
		subsonic.state.starred.set('s10a', '2026-02-01T00:00:00Z');
		const order = (html) =>
			['Song 0a', 'Song 1a', 'Song 5b', 'Song 10a']
				.map((title) => [title, html.indexOf(`>${title}<`)])
				.sort((a, b) => a[1] - b[1])
				.map(([title]) => title);

		try {
			const newest = await user.page('/favourites?tab=songs');
			assert.match(newest.html, /Recently starred/);
			assert.deepEqual(order(newest.html), ['Song 5b', 'Song 10a', 'Song 1a', 'Song 0a']);

			// Numeric collation: 10 after 5, not between 1 and 5.
			const named = await user.page('/favourites?tab=songs&sort=alphabetical');
			assert.deepEqual(order(named.html), ['Song 0a', 'Song 1a', 'Song 5b', 'Song 10a']);

			// An order another tab offers, or none at all, falls back to the default.
			const unknown = await user.page('/favourites?tab=songs&sort=mostAlbums');
			assert.deepEqual(order(unknown.html), ['Song 5b', 'Song 10a', 'Song 1a', 'Song 0a']);
		} finally {
			await user.json('/api/star', 'POST', { id: 's5b', kind: 'song', starred: false });
			await user.json('/api/star', 'POST', { id: 's10a', kind: 'song', starred: false });
		}
	});

	test('a shuffle holds its order for its seed, and the chip deals a new seed', async () => {
		const ids = ['s2a', 's3a', 's4a', 's5b', 's10a'];
		for (const id of ids) await user.json('/api/star', 'POST', { id, kind: 'song', starred: true });
		const titles = ['Song 0a', 'Song 1a', 'Song 2a', 'Song 3a', 'Song 4a', 'Song 5b', 'Song 10a'];
		const order = (html) =>
			titles
				.map((title) => [title, html.indexOf(`>${title}<`)])
				.sort((a, b) => a[1] - b[1])
				.map(([title]) => title);

		try {
			const first = await user.page('/favourites?tab=songs&sort=random&seed=1');
			assert.equal(first.response.status, 200, explain('shuffled favourites failed'));
			assert.match(first.html, />Random</);
			const again = await user.page('/favourites?tab=songs&sort=random&seed=1');
			assert.deepEqual(order(again.html), order(first.html), 'one seed, one order');
			assert.deepEqual([...order(first.html)].sort(), [...titles].sort(), 'every favourite is in the shuffle');

			// The hash is fixed, so which seeds differ is too; one of the next
			// twenty dealing the same seven in the same order would be a broken hash.
			const others = [];
			for (let seed = 2; seed <= 21; seed++) {
				others.push(order((await user.page(`/favourites?tab=songs&sort=random&seed=${seed}`)).html).join());
			}
			assert.ok(others.some((other) => other !== order(first.html).join()), 'every seed dealt the same order');

			// Without a seed one is drawn; a malformed one is replaced, not an error.
			assert.equal((await user.page('/favourites?tab=songs&sort=random')).response.status, 200);
			assert.equal((await user.page('/favourites?tab=songs&sort=random&seed=-4')).response.status, 200);
			assert.match(first.html, /href="\/favourites\?tab=songs&amp;sort=random&amp;seed=\d+"/);
		} finally {
			for (const id of ids) await user.json('/api/star', 'POST', { id, kind: 'song', starred: false });
		}
	});

	test('Jellyfin, which does not date a favourite, is not offered "recently starred"', async () => {
		const client = new Client(app.url);
		await client.signIn({ username: 'jfuser', password: 'jfpass', backend: 'jellyfin' });
		jellyfin.state.favourites.add('a1');
		jellyfin.state.favourites.add('a2');
		try {
			const { response, html } = await client.page('/favourites?tab=artists&sort=recentlyStarred');
			assert.equal(response.status, 200, explain('Jellyfin favourites page failed'));
			assert.ok(!html.includes('Recently starred'));
			assert.match(html, /Most albums/);
		} finally {
			jellyfin.state.favourites.clear();
		}
	});
});

describe('Jellyfin albums by play', () => {
	/** The albums a page links to, in order, each once. */
	const albumOrder = (html) => [...new Set([...html.matchAll(/href="\/albums\/(b\d)"/g)].map((m) => m[1]))];

	test('are ranked from their songs\' plays, which is where Jellyfin keeps them', async () => {
		// Jellyfin leaves an album's own play count and date unset however often
		// its songs are played. Sorted by those, every album tied and came back
		// in name order: First, Second, Third, Compilation.
		jellyfin.state.played = [
			{ Id: 't1', AlbumId: 'b2', PlayCount: 4, LastPlayedDate: '2026-09-20T10:00:00.0000000Z' },
			{ Id: 't2', AlbumId: 'b2', PlayCount: 3, LastPlayedDate: '2026-09-21T10:00:00.0000000Z' },
			{ Id: 'x1', AlbumId: 'b3', PlayCount: 1, LastPlayedDate: '2026-09-27T10:00:00.0000000Z' },
			{ Id: 'x2', AlbumId: 'b1', PlayCount: 5, LastPlayedDate: '2026-09-10T10:00:00.0000000Z' }
		];
		try {
			const client = new Client(app.url);
			await client.signIn({ username: 'jfuser', password: 'jfpass', backend: 'jellyfin' });
			const recent = await client.page('/albums?sort=recentlyPlayed');
			assert.equal(recent.response.status, 200, explain('recently played failed'));
			assert.deepEqual(albumOrder(recent.html), ['b3', 'b2', 'b1'], 'latest play first, unplayed left out');
			const most = await client.page('/albums?sort=mostPlayed');
			assert.deepEqual(albumOrder(most.html), ['b2', 'b1', 'b3'], 'plays of all its songs added up');
		} finally {
			jellyfin.state.played = [];
		}
	});

	test('nothing played leaves both lists empty', async () => {
		const client = new Client(app.url);
		await client.signIn({ username: 'jfuser', password: 'jfpass', backend: 'jellyfin' });
		const { response, html } = await client.page('/albums?sort=mostPlayed');
		assert.equal(response.status, 200, explain('most played failed'));
		assert.deepEqual(albumOrder(html), []);
	});
});

describe('the saved queue', () => {
	test('keeps the order from before shuffling while shuffle is on, and only then', async () => {
		const save = (body) => user.json('/api/play-state', 'PUT', body);
		try {
			await save({ songIds: ['s3a', 's1a', 's2a'], index: 0, shuffle: true, orderIds: ['s1a', 's2a', 's3a', 7] });
			const shuffled = await (await user.request('/api/play-state')).json();
			assert.deepEqual(shuffled.orderIds, ['s1a', 's2a', 's3a'], 'a non-string id was kept');

			await save({ songIds: ['s1a', 's2a', 's3a'], index: 0, shuffle: false, orderIds: ['s3a'] });
			assert.deepEqual((await (await user.request('/api/play-state')).json()).orderIds, []);
		} finally {
			await save({ songIds: [], index: 0, shuffle: false });
		}
	});
});

describe('held album details and suggestions', () => {
	test('an album page, a return to it and "Play" read the album once', async () => {
		await asFreshAccount('fifth', async (client) => {
			assert.equal((await client.page('/albums/al3')).response.status, 200, explain('album page failed'));
			assert.equal((await client.page('/albums/al3')).response.status, 200);
			const tracks = await client.json('/api/tracks', 'POST', { source: 'album', id: 'al3' });
			assert.deepEqual((await tracks.json()).songs.map((song) => song.id), ['s3a', 's3b']);
			assert.equal(subsonic.calls.get('getAlbum'), 1);

			// Reset first: the album page's "More from" reads `getArtist` as well.
			subsonic.calls.reset();
			await client.page('/artists/ar3');
			await client.page('/artists/ar3');
			assert.equal(subsonic.calls.get('getArtist'), 1);
		});
	});

	test('a star drops the held details, so the heart is right on the next load', async () => {
		await asFreshAccount('sixth', async (client) => {
			await client.page('/albums/al3');
			await client.json('/api/star', 'POST', { id: 's3a', kind: 'song', starred: true });
			try {
				await client.page('/albums/al3');
				assert.equal(subsonic.calls.get('getAlbum'), 2);
			} finally {
				await client.json('/api/star', 'POST', { id: 's3a', kind: 'song', starred: false });
			}
		});
	});

	test('a "You might like" shelf is read once, and a star leaves it', async () => {
		subsonic.state.similarAlbums = 3;
		try {
			await asFreshAccount('seventh', async (client) => {
				const { html } = await client.page('/albums/al4');
				// Streamed, so the shelf's albums arrive as data rather than markup.
				assert.match(html, /Album 5\b/, explain('the shelf is missing'));
				await client.json('/api/star', 'POST', { id: 's4a', kind: 'song', starred: true });
				await client.json('/api/star', 'POST', { id: 's4a', kind: 'song', starred: false });
				await client.page('/albums/al4');
				assert.equal(subsonic.calls.get('getSimilarSongs2'), 1);
				assert.equal(subsonic.calls.get('getAlbum'), 2, 'the star dropped the album itself');
			});
		} finally {
			subsonic.state.similarAlbums = 0;
		}
	});
});

describe('appears on', () => {
	test('an artist page lists the albums of others the artist sings on, and nothing matched by title alone', async () => {
		await asFreshAccount('guestlist', async (client) => {
			const { html } = await client.page('/artists/ar1');
			// Streamed, so the albums arrive as data rather than markup.
			assert.match(html, /Album 2\b/, explain('the album Artist 0001 is a guest on is missing'));
			assert.doesNotMatch(html, /Album 3\b/, 'an album found by a title match was listed');
		});
	});

	test('on Jellyfin, from the tracks the artist is on', async () => {
		const client = new Client(app.url);
		await client.signIn({ username: 'jfuser', password: 'jfpass', backend: 'jellyfin' });
		const { html } = await client.page('/artists/g1');
		assert.match(html, /"Second"/, explain('Artist B\'s album with the guest track is missing'));
	});
});

describe('star ratings', () => {
	test('a rating reaches the music server and shows on the next load of the album', async () => {
		await asFreshAccount('rater', async (client) => {
			const before = await client.page('/albums/al4');
			assert.match(before.html, /aria-label="Not rated"/, explain('the album page offers no stars'));

			const response = await client.json('/api/rating', 'POST', { id: 'al4', rating: 4 });
			assert.equal(response.status, 200, explain('the rating was refused'));
			assert.equal(subsonic.state.ratings.get('al4'), 4);

			// Held details carry the rating, so the write has to drop them.
			const after = await client.page('/albums/al4');
			assert.match(after.html, /aria-label="Rated 4 of 5"/);
			assert.equal(subsonic.calls.get('getAlbum'), 2);

			await client.json('/api/rating', 'POST', { id: 's4a', rating: 2 });
			assert.equal(subsonic.state.ratings.get('s4a'), 2);
			const songs = await client.json('/api/songs', 'POST', { ids: ['s4a', 's4b'] });
			assert.deepEqual((await songs.json()).songs.map((song) => song.rating), [2, 0]);

			// 0 clears it, as a press on the lit star does.
			await client.json('/api/rating', 'POST', { id: 'al4', rating: 0 });
			assert.equal(subsonic.state.ratings.has('al4'), false);
		});
		subsonic.state.ratings.clear();
	});

	test('a rating is a whole number from 0 to 5, and the id is bounded', async () => {
		for (const body of [
			{ id: 'al4', rating: 6 },
			{ id: 'al4', rating: -1 },
			{ id: 'al4', rating: 2.5 },
			{ id: 'al4', rating: '3' },
			{ id: 'al4' },
			{ id: '', rating: 3 },
			{ id: 'x'.repeat(256), rating: 3 }
		]) {
			const response = await user.json('/api/rating', 'POST', body);
			assert.equal(response.status, 400, `${JSON.stringify(body).slice(0, 40)} was not refused`);
		}
		assert.equal(subsonic.state.ratings.size, 0);
	});

	test('Jellyfin, which keeps no ratings, draws no stars and refuses a rating', async () => {
		const client = new Client(app.url);
		await client.signIn({ username: 'jfuser', password: 'jfpass', backend: 'jellyfin' });
		const { html } = await client.page('/albums/b2');
		assert.doesNotMatch(html, /Not rated|Rated \d of 5/);
		const response = await client.json('/api/rating', 'POST', { id: 'b2', rating: 3 });
		assert.equal(response.status, 404);
	});
});

describe('folders', () => {
	test('the top of the only library lists its folders, with no level for the library', async () => {
		await asFreshAccount('browser1', async (client) => {
			const { response, html } = await client.page('/folders');
			assert.equal(response.status, 200, explain('the folders page failed'));
			assert.match(html, /href="\/folders\/d-ar0"/);
			assert.match(html, /href="\/folders\/d-empty"/);
			assert.doesNotMatch(html, /library%3A1/);
			assert.equal(subsonic.calls.get('getIndexes'), 1);
		});
	});

	test('a folder lists its tracks without the video, under the folders above it', async () => {
		await asFreshAccount('browser2', async (client) => {
			const { response, html } = await client.page('/folders/d-al3');
			assert.equal(response.status, 200, explain('the folder page failed'));
			const trail = /<nav class="trail[^>]*>([\s\S]*?)<\/nav>/.exec(html)?.[1] ?? '';
			const links = [...trail.matchAll(/href="([^"]+)"/g)].map((match) => match[1]);
			assert.deepEqual(links, ['/folders', '/folders/d-lib', '/folders/d-ar3']);
			assert.match(html, /Song 3a/);
			assert.match(html, /Song 3b/);
			assert.doesNotMatch(html, /A video/);
			// Its own directory, then one for each level above it.
			assert.equal(subsonic.calls.get('getMusicDirectory'), 3);

			// "Play" on the page just loaded is answered from the held folder.
			const tracks = await client.json('/api/tracks', 'POST', { source: 'folder', id: 'd-al3' });
			assert.deepEqual((await tracks.json()).songs.map((song) => song.id), ['s3a', 's3b']);
			assert.equal(subsonic.calls.get('getMusicDirectory'), 3);
		});
	});

	test('an empty folder says so, and a folder the server does not have is a 404', async () => {
		const empty = await user.page('/folders/d-empty');
		assert.equal(empty.response.status, 200);
		assert.match(empty.html, /This folder is empty/);
		assert.equal((await user.page('/folders/d-nothing')).response.status, 404);
		assert.equal((await user.page(`/folders/${'x'.repeat(256)}`)).response.status, 404);
	});

	test('with two libraries, the top lists them and each lists its own folders', async () => {
		subsonic.state.musicFolders = [
			{ id: 1, name: 'Music' },
			{ id: 2, name: 'Audiobooks' }
		];
		try {
			await asFreshAccount('browser3', async (client) => {
				const top = await client.page('/folders');
				assert.match(top.html, /href="\/folders\/library%3A1"/);
				assert.match(top.html, /Audiobooks/);
				const second = await client.page('/folders/library%3A2');
				assert.equal(second.response.status, 200, explain('the second library failed'));
				assert.match(second.html, /href="\/folders\/d-ar2"/);
				assert.doesNotMatch(second.html, /href="\/folders\/d-ar1"/);
				assert.equal((await client.page('/folders/library%3A9')).response.status, 404);
			});
		} finally {
			subsonic.state.musicFolders = [{ id: 1, name: 'Music' }];
		}
	});

	test('Jellyfin lists its music library as it is on disk, and a track is not a folder', async () => {
		const client = new Client(app.url);
		await client.signIn({ username: 'jfuser', password: 'jfpass', backend: 'jellyfin' });
		const top = await client.page('/folders');
		assert.equal(top.response.status, 200, explain('the Jellyfin folders page failed'));
		assert.match(top.html, /href="\/folders\/fb"/);
		assert.doesNotMatch(top.html, /Films/);

		const album = await client.page('/folders/b2');
		const trail = /<nav class="trail[^>]*>([\s\S]*?)<\/nav>/.exec(album.html)?.[1] ?? '';
		assert.deepEqual([...trail.matchAll(/href="([^"]+)"/g)].map((match) => match[1]), ['/folders', '/folders/lib1', '/folders/fb']);
		assert.match(album.html, /Track 1/);
		assert.equal((await client.page('/folders/t1')).response.status, 404);
	});
});

describe('playback on another browser', () => {
	/**
	 * A browser's event stream, read as it arrives. `next(type)` resolves with
	 * the next event of that type, and `closed` when the server ends it.
	 */
	async function listen(client, path = '/api/remote/events') {
		const response = await client.request(path, { headers: { accept: 'text/event-stream' } });
		assert.equal(response.status, 200, explain('the event stream was refused'));
		assert.match(response.headers.get('content-type') ?? '', /^text\/event-stream/);
		const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
		const events = [];
		const waiting = [];
		let buffer = '';
		const closed = (async () => {
			for (;;) {
				const { value, done } = await reader.read().catch(() => ({ done: true }));
				if (done) return;
				buffer += value;
				let end;
				while ((end = buffer.indexOf('\n\n')) >= 0) {
					const block = buffer.slice(0, end);
					buffer = buffer.slice(end + 2);
					const type = /^event: (.*)$/m.exec(block)?.[1];
					const data = /^data: (.*)$/m.exec(block)?.[1];
					if (!type) continue;
					events.push({ type, data: JSON.parse(data) });
					for (const wait of [...waiting]) wait();
				}
			}
		})();
		let read = 0;
		const next = (type, timeout = 3000) =>
			new Promise((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error(`no ${type} event within ${timeout}ms`)), timeout);
				const check = () => {
					const at = events.findIndex((event, i) => i >= read && event.type === type);
					if (at < 0) return;
					read = at + 1;
					clearTimeout(timer);
					waiting.splice(waiting.indexOf(check), 1);
					resolve(events[at].data);
				};
				waiting.push(check);
				check();
			});
		const { id } = await next('hello');
		return { id, next, closed, cancel: () => reader.cancel().catch(() => undefined) };
	}

	const signedIn = async (username = 'testuser', password = 'testpass') => {
		const client = new Client(app.url);
		await client.signIn({ username, password, backend: 'subsonic' });
		return client;
	};

	test('two browsers of one account see each other, and one plays and pauses the other', async () => {
		const desktop = await signedIn();
		const phone = await signedIn();
		const a = await listen(desktop);
		const b = await listen(phone);
		try {
			const { peers } = await b.next('peers');
			assert.deepEqual(new Set(peers.map((peer) => peer.id)), new Set([a.id, b.id]));

			const state = { songId: 's3a', title: 'Song 3a', artist: 'Artist 0003', coverArt: 'al-3', position: 12, duration: 180, playing: true, volume: 0.5 };
			assert.equal((await desktop.json('/api/remote/state', 'POST', { peer: a.id, state })).status, 200);
			const seen = await b.next('peers');
			const reported = seen.peers.find((peer) => peer.id === a.id);
			assert.equal(reported.state.title, 'Song 3a');
			assert.equal(reported.state.playing, true);
			assert.equal(typeof seen.now, 'number');

			assert.equal((await phone.json('/api/remote', 'POST', { to: a.id, command: { type: 'toggle' } })).status, 200);
			assert.deepEqual(await a.next('command'), { type: 'toggle' });
			await phone.json('/api/remote', 'POST', { to: a.id, command: { type: 'seek', position: 42 } });
			assert.deepEqual(await a.next('command'), { type: 'seek', position: 42 });

			// "Play here": the phone asks, and the desktop answers with its queue.
			await phone.json('/api/remote', 'POST', { to: a.id, command: { type: 'handoff', to: b.id } });
			assert.deepEqual(await a.next('command'), { type: 'handoff', to: b.id });
			const transfer = { type: 'transfer', ids: ['s3a', 's3b'], index: 1, position: 30, playing: true };
			assert.equal((await desktop.json('/api/remote', 'POST', { to: b.id, command: transfer })).status, 200);
			assert.deepEqual(await b.next('command'), transfer);
		} finally {
			a.cancel();
			b.cancel();
		}
	});

	test('another account reaches neither browser, nor reports for them', async () => {
		const desktop = await signedIn();
		const a = await listen(desktop);
		try {
			await asFreshAccount('stranger', async (stranger) => {
				const sent = await stranger.json('/api/remote', 'POST', { to: a.id, command: { type: 'pause' } });
				assert.equal(sent.status, 404);
				const reported = await stranger.json('/api/remote/state', 'POST', { peer: a.id, state: null });
				assert.equal(reported.status, 404);
			});
			// A second browser of the same account may send to it, but not report as it.
			const other = await signedIn();
			const reported = await other.json('/api/remote/state', 'POST', { peer: a.id, state: null });
			assert.equal(reported.status, 404);
			await assert.rejects(a.next('command', 300), /no command event/);
		} finally {
			a.cancel();
		}
	});

	test('a command is one of the few it can be, with every field in bounds', async () => {
		const desktop = await signedIn();
		const a = await listen(desktop);
		try {
			const ids = (n) => Array.from({ length: n }, (_, i) => `s${i}a`);
			for (const command of [
				{ type: 'eject' },
				{ type: 'seek', position: -1 },
				{ type: 'seek', position: 'end' },
				{ type: 'volume', volume: 1.5 },
				{ type: 'transfer', ids: [], index: 0, position: 0, playing: true },
				{ type: 'transfer', ids: ids(1001), index: 0, position: 0, playing: true },
				{ type: 'transfer', ids: ids(2), index: 2, position: 0, playing: true },
				{ type: 'transfer', ids: ['x'.repeat(256)], index: 0, position: 0, playing: true },
				{ type: 'handoff', to: a.id },
				null
			]) {
				const response = await desktop.json('/api/remote', 'POST', { to: a.id, command });
				assert.equal(response.status, 400, `${JSON.stringify(command)?.slice(0, 60)} was not refused`);
			}
			assert.equal((await desktop.json('/api/remote', 'POST', { to: 'nobody', command: { type: 'pause' } })).status, 404);
		} finally {
			a.cancel();
		}
	});

	test('signing out ends the stream, and the other browsers are told', async () => {
		const desktop = await signedIn();
		const phone = await signedIn();
		const a = await listen(desktop);
		const b = await listen(phone);
		try {
			await b.next('peers');
			await desktop.request('/logout', { method: 'POST' });
			await Promise.race([a.closed, new Promise((_, reject) => setTimeout(() => reject(new Error('the stream stayed open')), 3000))]);
			for (;;) {
				const { peers } = await b.next('peers');
				if (!peers.some((peer) => peer.id === a.id)) break;
			}
			assert.equal((await phone.json('/api/remote', 'POST', { to: a.id, command: { type: 'pause' } })).status, 404);
		} finally {
			a.cancel();
			b.cancel();
		}
	});

	describe('listening together', () => {
		const host = async () => {
			const client = await signedIn();
			const started = await client.json('/api/together', 'POST', {});
			assert.equal(started.status, 200, explain('listening together would not start'));
			return { client, party: (await started.json()).party };
		};
		const report = (client, state) => client.json('/api/together/state', 'POST', { state });
		const song = (id, extra = {}) => ({ songId: id, title: `Song ${id.slice(1)}`, artist: 'Artist', album: 'Album', coverArt: 'al-3', duration: 180, position: 10, playing: true, ...extra });

		test('a visitor with no account follows what the host plays, and may play only that', async () => {
			const { client, party } = await host();
			assert.equal((await (await client.request('/api/together')).json()).party.url, party.url);
			const visitor = new Client(app.url);
			const page = await visitor.page(party.url);
			assert.equal(page.response.status, 200, explain('the listen-together page was refused'));
			assert.match(page.html, /Waiting for the host/);

			const guest = await listen(visitor, `${party.url}/events`);
			assert.equal((await guest.next('state')).state, null, 'something played before the host reported');
			await report(client, song('s3a'));
			for (;;) {
				const { state } = await guest.next('state');
				if (state?.songId === 's3a') break;
			}
			try {
				assert.equal((await visitor.request(`${party.url}/stream?song=s3a`, { headers: { range: 'bytes=0-9' } })).status, 206);
				assert.equal((await visitor.request(`${party.url}/stream?song=s3b`)).status, 404, 'another track of the host plays');
				assert.equal((await visitor.request(`${party.url}/stream`)).status, 404);
				assert.equal((await visitor.request(`${party.url}/cover?song=s3a`)).status, 200);
				assert.match((await visitor.page(party.url)).html, /Song 3a/);
			} finally {
				guest.cancel();
				await client.json('/api/together', 'DELETE', {});
			}
		});

		test('reactions come from a listener, from the set, and one a second', async () => {
			const { client, party } = await host();
			const one = await listen(new Client(app.url), `${party.url}/events`);
			const two = await listen(new Client(app.url), `${party.url}/events`);
			const visitor = new Client(app.url);
			try {
				const react = (listener, emoji) => visitor.json(`${party.url}/react`, 'POST', { listener, emoji });
				assert.equal((await react(one.id, '💩')).status, 400);
				assert.equal((await react('nobody', '🔥')).status, 404);
				assert.equal((await react(one.id, '🔥')).status, 200);
				assert.equal((await two.next('reaction')).emoji, '🔥');
				assert.equal((await react(one.id, '🎉')).status, 429);
			} finally {
				one.cancel();
				two.cancel();
				await client.json('/api/together', 'DELETE', {});
			}
		});

		test('ending it tells the listeners and closes the link, and so does the host signing out', async () => {
			const first = await host();
			const guest = await listen(new Client(app.url), `${first.party.url}/events`);
			await first.client.json('/api/together', 'DELETE', {});
			await guest.next('ended');
			assert.equal((await new Client(app.url).page(first.party.url)).response.status, 404);

			const second = await host();
			await report(second.client, song('s4a'));
			await second.client.request('/logout', { method: 'POST' });
			assert.equal((await new Client(app.url).page(second.party.url)).response.status, 404);
			assert.equal((await new Client(app.url).request(`${second.party.url}/stream?song=s4a`)).status, 404);
			assert.equal((await new Client(app.url).json('/api/together', 'POST', {})).status, 401);
		});
	});
});

describe('cast addresses', () => {
	const signedIn = async () => {
		const client = new Client(app.url);
		await client.signIn({ username: 'testuser', password: 'testpass', backend: 'subsonic' });
		return client;
	};
	const addresses = async (client, ids) => {
		const response = await client.json('/api/cast', 'POST', { ids });
		assert.equal(response.status, 200, explain('cast addresses were refused'));
		return (await response.json()).urls;
	};

	test('an address plays its track with no cookie, in ranges, to a page on another origin', async () => {
		const urls = await addresses(await signedIn(), ['s2a', 's2b']);
		assert.deepEqual(Object.keys(urls), ['s2a', 's2b']);
		assert.match(urls.s2a, /^\/cast\/[\w.-]+$/);
		assert.notEqual(urls.s2a, urls.s2b);

		const response = await fetch(app.url + urls.s2a, { headers: { range: 'bytes=0-9' } });
		assert.equal(response.status, 206, explain('a cast address did not play'));
		assert.equal(response.headers.get('content-type'), 'audio/flac');
		assert.equal((await response.arrayBuffer()).byteLength, 10);
		// A receiver's page is on another origin: Chromecast's, or Apple's.
		assert.equal(response.headers.get('cross-origin-resource-policy'), 'cross-origin');
		assert.equal(response.headers.get('access-control-allow-origin'), '*');
		assert.equal(response.headers.get('cache-control'), 'private, no-store');
		assert.equal((await fetch(app.url + urls.s2a, { method: 'HEAD' })).status, 200);

		// Every other response keeps its policy.
		const page = await fetch(`${app.url}/login`);
		assert.equal(page.headers.get('cross-origin-resource-policy'), 'same-origin');
	});

	test('a token changed to name another track, cut short or made up is refused', async () => {
		const url = (await addresses(await signedIn(), ['s2a'])).s2a;
		const [account, handle, , expiry, signature] = url.slice('/cast/'.length).split('.');
		const other = Buffer.from('s3a').toString('base64url');
		const later = (Number.parseInt(expiry, 36) + 86_400_000).toString(36);
		for (const path of [
			`/cast/${[account, handle, other, expiry, signature].join('.')}`,
			`/cast/${[account, handle, Buffer.from('s2a').toString('base64url'), later, signature].join('.')}`,
			url.slice(0, -4),
			'/cast/not-a-token',
			`/cast/${'a.'.repeat(4)}a`
		]) {
			const response = await fetch(app.url + path);
			assert.equal(response.status, 404, `${path.slice(0, 40)} was not refused`);
		}
	});

	test('signing out ends the addresses the session was given', async () => {
		const client = await signedIn();
		const url = (await addresses(client, ['s2a'])).s2a;
		assert.equal((await fetch(app.url + url)).status, 200);
		await client.request('/logout', { method: 'POST' });
		assert.equal((await fetch(app.url + url)).status, 404);
	});

	test('addresses are asked for by a signed-in browser, for 1 to 1000 ids', async () => {
		const client = await signedIn();
		for (const ids of [[], Array.from({ length: 1001 }, (_, i) => `s${i}a`), ['x'.repeat(256)], [3], 's2a']) {
			const response = await client.json('/api/cast', 'POST', { ids });
			assert.equal(response.status, 400, `${JSON.stringify(ids).slice(0, 40)} was not refused`);
		}
		assert.equal((await new Client(app.url).json('/api/cast', 'POST', { ids: ['s2a'] })).status, 401);
	});

	test('a token stays out of the log', async () => {
		// Every request line is written at `debug`.
		const logged = await startApp({ subsonicUrl: subsonic.url, jellyfinUrl: jellyfin.url, env: { HEDDOHON_LOG_LEVEL: 'debug' } });
		try {
			const client = new Client(logged.url);
			await client.signIn({ username: 'testuser', password: 'testpass', backend: 'subsonic' });
			const url = (await (await client.json('/api/cast', 'POST', { ids: ['s2a'] })).json()).urls.s2a;
			const token = url.slice('/cast/'.length);
			assert.equal((await fetch(logged.url + url)).status, 200);
			await fetch(`${logged.url}/cast/${token.slice(0, -2)}xx`);
			assert.match(logged.output(), /\/cast\//, 'no request line was written');
			assert.ok(!logged.output().includes(token.slice(0, 40)), 'the token reached the log');
		} finally {
			await logged.stop();
		}
	});
});

describe('listening history', () => {
	const play = (client, songId, event = 'stop', completed = true) =>
		client.json('/api/playback', 'POST', { songId, event, position: 100, completed });
	/** The track titles on a history page, in order. */
	const titles = (html) => [...html.matchAll(/class="title hh-truncate[^"]*">([^<]+)</g)].map((m) => m[1]);

	test('a play past the threshold is listed newest first, and nothing short of one is', async () => {
		await asFreshAccount('listener', async (client) => {
			await play(client, 's3a');
			await play(client, 's4a', 'start', false);
			await play(client, 's4a', 'progress', false);
			await play(client, 's4b', 'stop', false);
			await new Promise((done) => setTimeout(done, 5));
			await play(client, 's5b');
			const { response, html } = await client.page('/history');
			assert.equal(response.status, 200, explain('the history page failed'));
			assert.deepEqual(titles(html), ['Song 5b', 'Song 3a']);
			assert.match(html, /2 plays/);
			assert.match(html, /Today/);
		});
	});

	test('plays are noted with reporting to the music server turned off', async () => {
		await asFreshAccount('quiet', async (client) => {
			const saved = await client.json('/api/settings', 'PATCH', { reportPlayback: false });
			assert.equal(saved.status, 200);
			await play(client, 's6a');
			assert.equal(subsonic.calls.get('scrobble'), 0, 'reported upstream while turned off');
			assert.deepEqual(titles((await client.page('/history')).html), ['Song 6a']);
		});
	});

	test('one account reads only its own, a deleted track is left out, and clearing empties it', async () => {
		await asFreshAccount('owner', async (client) => {
			await play(client, 's7a');
			await play(client, 's7b');
			await asFreshAccount('neighbour', async (other) => {
				assert.deepEqual(titles((await other.page('/history')).html), []);
			});
			subsonic.state.username = 'owner';
			subsonic.state.password = 'ownerpass';

			subsonic.state.missing.add('s7b');
			try {
				assert.deepEqual(titles((await client.page('/history')).html), ['Song 7a']);
			} finally {
				subsonic.state.missing.delete('s7b');
			}

			const cleared = await client.request('/settings?/clearHistory', {
				method: 'POST',
				headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', 'x-sveltekit-action': 'true' },
				body: ''
			});
			assert.equal(cleared.status, 200);
			const after = (await client.page('/history')).html;
			assert.deepEqual(titles(after), []);
			assert.match(after, /Nothing yet/);
		});
	});

	test('with 90 days chosen, an account keeps at most 5000 plays, the oldest dropped', async () => {
		await asFreshAccount('heavy', async (client) => {
			// Kept for good by default, which has no limit.
			await client.json('/api/settings', 'PATCH', { reportPlayback: false, historyDays: 90 });
			// s0a first, then 5000 more: s0a is the one past the limit.
			await play(client, 's0a');
			for (let batch = 0; batch < 100; batch++) {
				await Promise.all(Array.from({ length: 50 }, (_, i) => play(client, `s${1 + ((batch * 50 + i) % 30)}b`)));
			}
			const last = await client.page('/history?page=50');
			assert.match(last.html, /5,000 plays/, explain('the history was not held to 5000'));
			assert.ok(!titles(last.html).includes('Song 0a'), 'the oldest play was kept');
		});
	});

	test('kept for good, the default, an account keeps plays past 5000', async () => {
		await asFreshAccount('hoarder', async (client) => {
			await client.json('/api/settings', 'PATCH', { reportPlayback: false });
			await play(client, 's0a');
			for (let batch = 0; batch < 101; batch++) {
				await Promise.all(Array.from({ length: 50 }, (_, i) => play(client, `s${1 + ((batch * 50 + i) % 30)}b`)));
			}
			const last = await client.page('/history?page=51');
			assert.match(last.html, /5,051 plays/, explain('plays past 5000 were dropped'));
			assert.ok(titles(last.html).includes('Song 0a'), 'the oldest play was dropped');
		});
	});

	test('Recently played and Your listening are tabs of each other, under History on the rail', async () => {
		const current = (html) => /<nav class="tabs[^"]*" aria-label="Listening history">[\s\S]*?aria-current="page"[^>]*>([^<]+)</.exec(html)?.[1];
		const rail = (html) => /title="([^"]+)" aria-current="page"/.exec(html)?.[1];
		for (const [path, tab] of [['/history', 'Recently played'], ['/stats', 'Your listening']]) {
			const { html } = await user.page(path);
			assert.equal(current(html), tab, `${path} does not mark its tab`);
			assert.equal(rail(html), 'History', `${path} does not light History on the rail`);
		}
	});

	test('Jellyfin plays are noted too', async () => {
		const client = new Client(app.url);
		await client.signIn({ username: 'jfuser', password: 'jfpass', backend: 'jellyfin' });
		await play(client, 't2');
		assert.deepEqual(titles((await client.page('/history')).html), ['Track 2']);
	});

	/** Runs the import as the enhanced form does, and returns what the action answered. */
	async function importHistory(client) {
		const response = await client.request('/settings?/importHistory', {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', 'x-sveltekit-action': 'true' },
			body: ''
		});
		const result = await response.json();
		// Serialised with devalue: the first entry maps each key to its value's index.
		const data = JSON.parse(result.data);
		const imported = data[data[0].historyImported];
		return { type: result.type, found: data[imported.found], imported: data[imported.imported] };
	}
	const daysAgo = (days) => new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

	test('the last play of each song comes in from Navidrome once, beside the plays already here', async () => {
		await asFreshAccount('importer', async (client) => {
			await client.json('/api/settings', 'PATCH', { reportPlayback: false });
			await play(client, 's3a');
			// s3a's date is the play above, as Navidrome records the scrobble.
			subsonic.state.played.set('s3a', new Date().toISOString());
			subsonic.state.played.set('s4b', daysAgo(30));
			subsonic.state.played.set('s5a', daysAgo(400));
			try {
				const first = await importHistory(client);
				assert.equal(first.type, 'success', explain('the import failed'));
				assert.deepEqual([first.found, first.imported], [3, 2]);
				assert.equal(subsonic.calls.get('search3'), 2, 'the library was not read to its end, 500 songs a page');
				assert.deepEqual(titles((await client.page('/history')).html), ['Song 3a', 'Song 4b', 'Song 5a']);
				assert.match((await client.page('/stats?period=all')).html, /Artist 0005/, 'the stats did not count an imported play');

				const again = await importHistory(client);
				assert.deepEqual([again.found, again.imported], [3, 0], 'a second import added plays again');

				// Kept for 90 days, a play older than that is not brought in.
				await client.json('/api/settings', 'PATCH', { historyDays: 90 });
				await client.request('/settings?/clearHistory', {
					method: 'POST',
					headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', 'x-sveltekit-action': 'true' },
					body: ''
				});
				assert.equal((await importHistory(client)).imported, 2);
				assert.deepEqual(titles((await client.page('/history')).html), ['Song 3a', 'Song 4b']);
			} finally {
				subsonic.state.played.clear();
			}
		});
	});

	test('the last play of each song comes in from Jellyfin', async () => {
		jellyfin.state.played = [{ Id: 't3', AlbumId: 'b2', PlayCount: 2, LastPlayedDate: daysAgo(3).replace('Z', '0000Z') }];
		try {
			const client = new Client(app.url);
			await client.signIn({ username: 'jfuser', password: 'jfpass', backend: 'jellyfin' });
			const result = await importHistory(client);
			assert.deepEqual([result.found, result.imported], [1, 1]);
			assert.equal(titles((await client.page('/history')).html).at(-1), 'Track 3');
		} finally {
			jellyfin.state.played = [];
		}
	});

	/** The album links on the home page's shelf titled `title`, in order. */
	const shelfAlbums = (html, title) => {
		const section = html.split(`>${title}<`)[1]?.split('</section>')[0] ?? '';
		return [...section.matchAll(/href="\/albums\/([^"]+)"/g)].map((m) => m[1]);
	};

	test('Rediscover offers an album played three times or more, and not in the last six months', async () => {
		await asFreshAccount('rediscover', async (client) => {
			await client.json('/api/settings', 'PATCH', { reportPlayback: false });
			subsonic.state.played.set('s1a', daysAgo(200));
			subsonic.state.played.set('s1b', daysAgo(200));
			subsonic.state.played.set('s2a', daysAgo(200));
			try {
				await importHistory(client);
				assert.doesNotMatch((await client.page('/')).html, />Rediscover</, 'two plays of an album count as often');

				// A second, older play of s1a makes three for Album 1.
				subsonic.state.played.set('s1a', daysAgo(250));
				assert.equal((await importHistory(client)).imported, 1);
				const { response, html } = await client.page('/');
				assert.equal(response.status, 200, explain('the home page failed'));
				assert.deepEqual(shelfAlbums(html, 'Rediscover'), ['al1']);

				await play(client, 's1b');
				assert.doesNotMatch((await client.page('/')).html, />Rediscover</, 'an album played today is still offered');
			} finally {
				subsonic.state.played.clear();
			}
		});
	});

	test('On this day names the albums played on the asked date in earlier years, in the asked time zone', async () => {
		await asFreshAccount('anniversary', async (client) => {
			const now = new Date();
			const utc = (years, days, hours = 12) =>
				new Date(Date.UTC(now.getUTCFullYear() - years, now.getUTCMonth(), now.getUTCDate() + days, hours));
			const onThisDay = async (date, offset) => {
				const response = await client.request(`/api/on-this-day?date=${date.toISOString().slice(0, 10)}&offset=${offset}`);
				return response.ok ? (await response.json()).albums : response.status;
			};
			subsonic.state.played.set('s3a', utc(1, 0).toISOString());
			subsonic.state.played.set('s4a', utc(2, 0).toISOString());
			subsonic.state.played.set('s4b', utc(2, 0, 13).toISOString());
			subsonic.state.played.set('s5a', utc(1, -5).toISOString());
			subsonic.state.played.set('s6a', utc(0, -2).toISOString());
			try {
				assert.equal((await importHistory(client)).imported, 5);
				const today = await onThisDay(utc(0, 0), 0);
				assert.deepEqual(
					today.map((album) => [album.id, album.year, album.plays]),
					[
						['al3', now.getUTCFullYear() - 1, 1],
						['al4', now.getUTCFullYear() - 2, 2]
					]
				);
				assert.equal(today[0].name, 'Album 3');
				// Noon in UTC is two in the morning of the next day at UTC+14.
				assert.deepEqual(await onThisDay(utc(0, 0), 840), []);
				assert.deepEqual((await onThisDay(utc(0, 1), 840)).map((album) => album.id), ['al3', 'al4']);

				assert.doesNotMatch((await client.page('/')).html, />On this day</, 'the server drew the shelf in its own time zone');
				for (const query of ['date=2026-02-30&offset=0', 'date=2026-9-29&offset=0', 'date=9999-01-01&offset=0', `date=${utc(0, 0).toISOString().slice(0, 10)}&offset=900`, 'offset=0']) {
					assert.equal((await client.request(`/api/on-this-day?${query}`)).status, 400, query);
				}
			} finally {
				subsonic.state.played.clear();
			}
		});
	});
});

describe('Jellyfin favourites', () => {
	test('a heart reaches Jellyfin and shows on the album and favourites pages, and comes off again', async () => {
		const client = new Client(app.url);
		await client.signIn({ username: 'jfuser', password: 'jfpass', backend: 'jellyfin' });
		const pressed = (html, title) =>
			new RegExp(`${title}[\\s\\S]*?aria-pressed="(true|false)"[^>]*aria-label="(?:Add to|Remove from) favourites`).exec(html)?.[1];
		try {
			assert.equal(pressed((await client.page('/albums/b2')).html, 'Track 1'), 'false');
			const starred = await client.json('/api/star', 'POST', { id: 't1', kind: 'song', starred: true });
			assert.equal(starred.status, 200, explain('the star was refused'));
			assert.ok(jellyfin.state.favourites.has('t1'), 'Jellyfin was not told');
			assert.equal(pressed((await client.page('/albums/b2')).html, 'Track 1'), 'true');
			assert.match((await client.page('/favourites')).html, /Track 1/);

			await client.json('/api/star', 'POST', { id: 'b2', kind: 'album', starred: true });
			assert.ok(jellyfin.state.favourites.has('b2'));

			await client.json('/api/star', 'POST', { id: 't1', kind: 'song', starred: false });
			assert.ok(!jellyfin.state.favourites.has('t1'));
			assert.doesNotMatch((await client.page('/favourites?tab=songs')).html, /Track 1/);
		} finally {
			jellyfin.state.favourites.clear();
		}
	});
});

describe('your listening', () => {
	const play = (client, songId) => client.json('/api/playback', 'POST', { songId, event: 'stop', position: 100, completed: true });
	/** The figure under a label in the row of figures. */
	const figure = (html, label) => new RegExp(`class="label[^"]*">${label}</span>\\s*<span class="number[^"]*">([^<]+)<`).exec(html)?.[1];
	/** The names of a ranked list, in order. */
	const ranked = (html, title) => {
		const section = html.split(`>${title}<`)[1]?.split('</ol>')[0] ?? '';
		return [...section.matchAll(/class="name[^"]*">(?:\s|<!--[^>]*-->)*(?:<a [^>]*>)?([^<]+)</g)].map((m) => m[1].trim());
	};

	test('sums up the plays of the period from the tracks as they were played', async () => {
		await asFreshAccount('summary', async (client) => {
			await client.json('/api/settings', 'PATCH', { reportPlayback: false });
			for (const id of ['s1a', 's1a', 's1a', 's1b', 's2a', 's2a']) await play(client, id);
			const { response, html } = await client.page('/stats');
			assert.equal(response.status, 200, explain('the stats page failed'));
			assert.equal(figure(html, 'Plays'), '6');
			// Six plays of 180 seconds.
			assert.equal(figure(html, 'Hours listened'), '0.3');
			assert.equal(figure(html, 'Artists'), '2');
			assert.equal(figure(html, 'Tracks'), '3');
			assert.deepEqual(ranked(html, 'Top artists'), ['Artist 0001', 'Artist 0002']);
			assert.deepEqual(ranked(html, 'Top tracks').slice(0, 2), ['Song 1a', 'Song 2a']);
			assert.match(html, /4 plays/);
			assert.match(html, /href="\/albums\/al1"/);
			// Both artists were first played in the period.
			assert.match(html.split('New to you')[1] ?? '', /Artist 0001[\s\S]*Artist 0002/);
		});
	});

	test('another account sees none of it, and an unknown period is the last 30 days', async () => {
		await asFreshAccount('elsewhere', async (client) => {
			const { html } = await client.page('/stats?period=decade');
			assert.match(html, /Nothing played since/);
			assert.match(html, /aria-current="page"[^>]*href="\/stats\?period=month"/);
		});
	});

	test('the history is kept for good unless 90 days or a year is chosen, and nothing else', async () => {
		await asFreshAccount('keeper', async (client) => {
			assert.equal((await (await client.json('/api/settings', 'PATCH', {})).json()).historyDays, 0, 'kept for good by default');
			assert.doesNotMatch((await client.page('/history')).html, /in the last/);
			assert.equal((await (await client.json('/api/settings', 'PATCH', { historyDays: 365 })).json()).historyDays, 365);
			assert.equal((await (await client.json('/api/settings', 'PATCH', { historyDays: 100 })).json()).historyDays, 365);
			assert.equal((await (await client.json('/api/settings', 'PATCH', { historyDays: '90' })).json()).historyDays, 365);
			assert.match((await client.page('/history')).html, /in the last year/);
			assert.equal((await (await client.json('/api/settings', 'PATCH', { historyDays: 0 })).json()).historyDays, 0);
		});
	});

	test('Jellyfin plays are summed up too', async () => {
		const client = new Client(app.url);
		await client.signIn({ username: 'jfuser', password: 'jfpass', backend: 'jellyfin' });
		await client.request('/settings?/clearHistory', {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', 'x-sveltekit-action': 'true' },
			body: ''
		});
		await play(client, 't3');
		const { html } = await client.page('/stats?period=all');
		assert.equal(figure(html, 'Plays'), '1');
		assert.deepEqual(ranked(html, 'Top tracks'), ['Track 3']);
	});
});

describe('the offline page', () => {
	test('the worker, the page and its script are served without a session', async () => {
		const anonymous = new Client(app.url);
		const worker = await anonymous.request('/service-worker.js');
		assert.equal(worker.status, 200);
		assert.match(worker.headers.get('content-type') ?? '', /javascript/);
		const body = await worker.text();
		assert.match(body, /offline\.html/);
		assert.ok(!/\/api\//.test(body.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')), 'the worker names an API path');

		const page = await anonymous.request('/offline.html');
		assert.equal(page.status, 200);
		assert.match(await page.text(), /cannot reach its server/);
		assert.equal((await anonymous.request('/offline.js')).status, 200);
	});

	test('the page policy admits a worker from this origin', async () => {
		const page = await new Client(app.url).request('/login');
		assert.match(page.headers.get('content-security-policy') ?? '', /worker-src 'self'/);
	});
});

describe('release years', () => {
	test('an album shows the year it first came out, not its edition\'s', async () => {
		const { response, html } = await user.page('/albums/al29');
		assert.equal(response.status, 200, explain('album page failed'));
		assert.match(html, /1979/);
		assert.ok(!html.includes('2009'), 'the edition year is still shown');
	});

	test('an original date without a year leaves the edition\'s year', async () => {
		const { html } = await user.page('/albums/al28');
		assert.match(html, /2008/);
	});
});

describe('the phone\'s library and search tabs', () => {
	test('the library page links to each part of the library and to settings', async () => {
		const { response, html } = await user.page('/library');
		assert.equal(response.status, 200, explain('library page failed'));
		for (const href of ['/albums', '/artists', '/playlists', '/genres', '/folders', '/settings']) {
			assert.match(html, new RegExp(`href="${href}"`), href);
		}
		assert.match(html, /Recently added/);
	});

	test('search before a query offers the largest genres, from the held listing', async () => {
		subsonic.calls.reset();
		const first = await user.page('/search');
		assert.equal(first.response.status, 200, explain('search page failed'));
		// Streamed into the page after the field, as the favourites on home are.
		assert.match(first.html, /Rock/);
		assert.match(first.html, /Electronic/);
		await user.page('/search');
		// At most once: an earlier test may already have filled the listing.
		assert.ok(subsonic.calls.get('getGenres') <= 1, 'the genres were fetched twice inside 30s');
	});
});

describe('playing things', () => {
	test('playing an artist asks only for its albums', async () => {
		subsonic.calls.reset();
		const response = await user.json('/api/tracks', 'POST', { source: 'artist', id: 'ar0' });
		assert.equal(response.status, 200);
		const { songs } = await response.json();
		assert.deepEqual(
			songs.map((song) => song.id),
			['s0a', 's0b', 's0a', 's0b']
		);
		assert.equal(subsonic.calls.get('getArtist'), 1);
		assert.equal(subsonic.calls.get('getAlbum'), 2);
		assert.equal(subsonic.calls.get('getArtistInfo2'), 0);
		assert.equal(subsonic.calls.get('getTopSongs'), 0);
	});

	test('playing an artist in two parts: the first album, then the rest', async () => {
		// A fresh account: the test above read these albums, and they are held
		// for a minute (`details.ts`).
		await asFreshAccount('fourth', async (client) => {
			const first = await client.json('/api/tracks', 'POST', { source: 'artist', id: 'ar0', part: 'first' });
			assert.equal(first.status, 200);
			const head = await first.json();
			assert.deepEqual(head.songs.map((song) => song.id), ['s0a', 's0b']);
			assert.equal(head.more, true);
			assert.equal(subsonic.calls.get('getAlbum'), 1, 'one album looked up before playing');

			const rest = await (await client.json('/api/tracks', 'POST', { source: 'artist', id: 'ar0', part: 'rest' })).json();
			assert.deepEqual(rest.songs.map((song) => song.id), ['s0a', 's0b']);
			assert.equal(rest.more, undefined);
			assert.equal(subsonic.calls.get('getAlbum'), 2);

			const single = await (await client.json('/api/tracks', 'POST', { source: 'artist', id: 'ar1', part: 'first' })).json();
			assert.equal(single.more, false, 'an artist with one album has no rest');
		});
	});

	test('a saved queue restores when one of its tracks was deleted', async () => {
		subsonic.state.missing.add('s2a');
		const response = await user.json('/api/songs', 'POST', { ids: ['s1a', 's2a', 's3a'] });
		assert.equal(response.status, 200, 'one missing track must not fail the lookup');
		const { songs } = await response.json();
		assert.deepEqual(
			songs.map((song) => song.id),
			['s1a', 's3a']
		);
		subsonic.state.missing.clear();
	});

	test('a ranged stream request is answered 206 with the range', async () => {
		const response = await user.request('/api/stream/s1a?mode=raw', { headers: { range: 'bytes=0-99' } });
		assert.equal(response.status, 206);
		assert.equal(response.headers.get('content-range'), 'bytes 0-99/1000');
		assert.equal(response.headers.get('content-type'), 'audio/flac');
		assert.equal((await response.arrayBuffer()).byteLength, 100);
	});

	/*
	 * Navidrome ignores `Range` while a transcode is still running and sends
	 * the song from byte 0. Relayed as it came, with range support claimed on
	 * its behalf, iOS Safari played the start of the song as the continuation;
	 * and a stream that dropped could not be picked up where it stopped.
	 */
	describe('a transcode', () => {
		const body = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 251));

		before(async () => {
			await user.json('/api/settings', 'PATCH', { transcode: true });
			subsonic.state.audio = { type: 'audio/mpeg', body };
			subsonic.state.ignoreRange = true;
		});

		after(async () => {
			subsonic.state.ignoreRange = false;
			subsonic.state.audio = null;
			await user.json('/api/settings', 'PATCH', { transcode: false });
		});

		test('is streamed as it arrives on the first request: no length, no ranges, not kept', async () => {
			subsonic.calls.reset();
			const response = await user.request('/api/stream/s2a?mode=mp3-192', { headers: { range: 'bytes=0-1' } });
			assert.equal(response.status, 200);
			assert.equal(response.headers.get('accept-ranges'), null);
			assert.equal(response.headers.get('content-length'), null);
			assert.equal(response.headers.get('cache-control'), 'private, no-store');
			assert.deepEqual(Buffer.from(await response.arrayBuffer()), body);
		});

		test('is answered in exact ranges once whole, from one read of the music server', async () => {
			const range = await user.request('/api/stream/s2a?mode=mp3-192', { headers: { range: 'bytes=500-599' } });
			assert.equal(range.status, 206);
			assert.equal(range.headers.get('content-range'), 'bytes 500-599/1000');
			assert.equal(range.headers.get('accept-ranges'), 'bytes');
			assert.deepEqual(Buffer.from(await range.arrayBuffer()), body.subarray(500, 600));

			const open = await user.request('/api/stream/s2a?mode=mp3-192', { headers: { range: 'bytes=900-' } });
			assert.equal(open.headers.get('content-range'), 'bytes 900-999/1000');
			assert.deepEqual(Buffer.from(await open.arrayBuffer()), body.subarray(900));

			const whole = await user.request('/api/stream/s2a?mode=mp3-192');
			assert.equal(whole.status, 200);
			assert.equal(whole.headers.get('content-length'), '1000');
			assert.equal(whole.headers.get('accept-ranges'), 'bytes');
			await whole.arrayBuffer();

			assert.equal(subsonic.calls.get('stream'), 1, 'every request after the first was answered from the one read');
		});

		/*
		 * A read goes on after its request, so a loop of HEAD requests started a
		 * transcode on the music server and a copy here for every one, without
		 * limit (review of 2026-09-25). Past 2 reads in progress for an account,
		 * a request is relayed as it comes, tied to its own connection.
		 */
		test('an account has at most 2 reads in progress; past that it is relayed', async () => {
			subsonic.state.streamSlowMs = 1500;
			try {
				await user.request('/api/stream/s6a?mode=mp3-192', { method: 'HEAD' });
				await user.request('/api/stream/s7a?mode=mp3-192', { method: 'HEAD' });
				const third = await user.request('/api/stream/s8a?mode=mp3-192');
				assert.equal(third.headers.get('cache-control'), 'private, max-age=3600', 'the third read was held, not relayed');
				await third.arrayBuffer();
			} finally {
				subsonic.state.streamSlowMs = 0;
			}
			await new Promise((resolve) => setTimeout(resolve, 1700));
			const later = await user.request('/api/stream/s8a?mode=mp3-192', { method: 'HEAD' });
			assert.equal(later.headers.get('cache-control'), 'private, no-store', 'once the reads finished, a new one is held');
		});

		test('what is held for an account goes with its sessions', async () => {
			// s2a is held whole from the tests above.
			const held = await user.request('/api/stream/s2a?mode=mp3-192', { headers: { range: 'bytes=0-1' } });
			assert.equal(held.status, 206);
			await held.arrayBuffer();

			// The music server stops accepting the credential: every session ends.
			subsonic.state.password = 'changed-upstream';
			try {
				assert.equal((await user.page('/albums')).response.status, 401);
			} finally {
				subsonic.state.password = 'testpass';
			}
			const signIn = await user.signIn({ username: 'testuser', password: 'testpass', backend: 'subsonic' });
			assert.equal(signIn.status, 303);

			const after = await user.request('/api/stream/s2a?mode=mp3-192', { headers: { range: 'bytes=0-1' } });
			assert.equal(after.status, 200, 'the transcode held before the sessions ended was served after');
			await after.arrayBuffer();
		});

		test('a HEAD starts the read, so the next track has ranges from its first request', async () => {
			const head = await user.request('/api/stream/s4a?mode=mp3-192', { method: 'HEAD' });
			assert.equal(head.status, 200);
			await new Promise((resolve) => setTimeout(resolve, 150));
			const first = await user.request('/api/stream/s4a?mode=mp3-192', { headers: { range: 'bytes=0-1' } });
			assert.equal(first.status, 206);
			assert.equal(first.headers.get('content-range'), 'bytes 0-1/1000');
			assert.equal(first.headers.get('accept-ranges'), 'bytes');
			await first.arrayBuffer();
		});
	});

	/* A music server that ignores `Range` for an original file gets the same honesty. */
	describe('a file the music server will not range', () => {
		const body = Buffer.from(Array.from({ length: 1000 }, (_, i) => (i * 7) % 253));

		before(() => {
			subsonic.state.audio = { type: 'audio/flac', body };
			subsonic.state.ignoreRange = true;
		});

		after(() => {
			subsonic.state.ignoreRange = false;
			subsonic.state.audio = null;
		});

		test('from byte 0: relayed without a claim of ranges', async () => {
			const response = await user.request('/api/stream/s3a?mode=raw', { headers: { range: 'bytes=0-1' } });
			assert.equal(response.status, 200);
			assert.equal(response.headers.get('accept-ranges'), null);
			assert.equal(response.headers.get('content-length'), '1000');
			await response.arrayBuffer();
		});

		test('from further in: the bytes asked for, not the start of the song', async () => {
			const response = await user.request('/api/stream/s3a?mode=raw', { headers: { range: 'bytes=500-599' } });
			assert.equal(response.status, 206);
			assert.equal(response.headers.get('content-range'), 'bytes 500-599/1000');
			assert.deepEqual(Buffer.from(await response.arrayBuffer()), body.subarray(500, 600));
		});
	});
});

describe('covers', () => {
	test('a cover is sandboxed, then served from the disk cache', async () => {
		subsonic.calls.reset();
		const first = await user.request('/api/cover/al-1?size=256');
		assert.equal(first.status, 200);
		assert.equal(first.headers.get('content-type'), 'image/png');
		assert.match(first.headers.get('content-security-policy') ?? '', /sandbox/);
		await first.arrayBuffer();

		// The write to disk happens after the response, so wait for it.
		let cached;
		let hit = false;
		for (let attempt = 0; attempt < 20 && !hit; attempt++) {
			await new Promise((done) => setTimeout(done, 50));
			const before = subsonic.calls.get('getCoverArt');
			cached = await user.request('/api/cover/al-1?size=256');
			await cached.arrayBuffer();
			hit = subsonic.calls.get('getCoverArt') === before;
		}
		assert.ok(hit, 'the cover was never served from the cache');
		assert.equal(cached.headers.get('content-type'), 'image/png');
		assert.match(cached.headers.get('content-security-policy') ?? '', /sandbox/);
		assert.equal(cached.headers.get('x-content-type-options'), 'nosniff');
	});

	test('a cover streamed on a miss is stored whole', async () => {
		const first = await user.request('/api/cover/al-2?size=256');
		const streamed = Buffer.from(await first.arrayBuffer());
		let cached;
		for (let attempt = 0; attempt < 20; attempt++) {
			await new Promise((done) => setTimeout(done, 50));
			const before = subsonic.calls.get('getCoverArt');
			const response = await user.request('/api/cover/al-2?size=256');
			const body = Buffer.from(await response.arrayBuffer());
			if (subsonic.calls.get('getCoverArt') === before) {
				cached = body;
				break;
			}
		}
		assert.ok(cached, 'the cover was never served from the cache');
		assert.ok(streamed.length > 0);
		assert.deepEqual(cached, streamed);
	});

	test('a cover the music server calls HTML is not served as HTML', async () => {
		const response = await user.request('/api/cover/html?size=256');
		assert.equal(response.headers.get('content-type'), 'application/octet-stream');
		assert.match(response.headers.get('content-security-policy') ?? '', /sandbox/);
	});
});

describe('genres', () => {
	test('the genre list is read once for the genres page and the genre pages after it', async () => {
		subsonic.calls.reset();
		assert.match((await user.page('/genres')).html, /Rock/);
		for (const path of ['/genres/Rock', '/genres/Rock?page=2']) {
			assert.equal((await user.page(path)).response.status, 200, path);
		}
		assert.equal((await user.page('/genres/Jazz')).response.status, 404);
		assert.equal(subsonic.calls.get('getGenres'), 1);
		assert.equal(subsonic.calls.get('getAlbumList2'), 3);
	});
});

describe('Jellyfin', () => {
	test('the artists page lists album artists only, with their album counts', async () => {
		const client = new Client(app.url);
		const signIn = await client.signIn({ username: 'jfuser', password: 'jfpass', backend: 'jellyfin' });
		assert.equal(signIn.status, 303, explain('Jellyfin sign-in failed'));

		const { response, html } = await client.page('/artists');
		assert.equal(response.status, 200, explain('Jellyfin artists page failed'));
		for (const name of ['Artist A', 'Artist B', 'Various Artists']) assert.match(html, new RegExp(name));
		for (const name of ['Guest Singer', 'Compilation Track Artist']) assert.ok(!html.includes(name), name);
		assert.match(html, /Filter 3 artists/);
		assert.match(html, /2 albums/);
		assert.equal(jellyfin.calls.get('GET /Artists/AlbumArtists'), 0);
	});
});


describe('linking Last.fm and ListenBrainz', () => {
	/** Posts a settings form action as the enhanced form does, and returns SvelteKit's JSON result. */
	async function action(client, name, fields = {}) {
		const response = await client.request(`/settings?/${name}`, {
			method: 'POST',
			headers: {
				'content-type': 'application/x-www-form-urlencoded',
				accept: 'application/json',
				'x-sveltekit-action': 'true'
			},
			body: new URLSearchParams(fields).toString()
		});
		const result = await response.json();
		// Action data is serialised with devalue: an array whose first entry maps
		// each key to the index of its value.
		const data = result.data ? JSON.parse(result.data) : null;
		const values = data ? Object.fromEntries(Object.entries(data[0]).map(([k, i]) => [k, data[i]])) : {};
		return { type: result.type, status: result.status, ...values };
	}

	const nd = () => subsonic.state.navidrome;

	test('a ListenBrainz token goes to Navidrome and is not kept here', async () => {
		subsonic.calls.reset();
		const malformed = await action(user, 'linkListenBrainz', { token: 'not a token!' });
		assert.equal(malformed.status, 400);
		assert.equal(subsonic.calls.get('/api/listenbrainz/link'), 0, 'a malformed token must not reach the server');

		const refused = await action(user, 'linkListenBrainz', { token: '0b6a6f3e-0000-4000-8000-000000000000' });
		assert.equal(refused.status, 400);
		assert.match(refused.scrobblerError, /did not accept/);
		assert.equal(nd().linked.listenbrainz, false);

		const linked = await action(user, 'linkListenBrainz', { token: subsonic.LISTENBRAINZ_TOKEN });
		assert.equal(linked.type, 'success', explain(JSON.stringify(linked)));
		assert.equal(nd().listenBrainzToken, subsonic.LISTENBRAINZ_TOKEN);

		const { readdirSync, readFileSync } = await import('node:fs');
		for (const file of readdirSync(app.dataDir)) {
			if (!file.endsWith('.db') && !file.endsWith('-wal')) continue;
			const bytes = readFileSync(`${app.dataDir}/${file}`);
			assert.ok(!bytes.includes(subsonic.LISTENBRAINZ_TOKEN), `the token is in ${file}`);
		}
		assert.ok(!app.output().includes(subsonic.LISTENBRAINZ_TOKEN), 'the token is in the log');

		const unlinked = await action(user, 'unlinkScrobbler', { service: 'listenbrainz' });
		assert.equal(unlinked.type, 'success');
		assert.equal(nd().linked.listenbrainz, false);
		// Navidrome allows 5 sign-ins per 20s from one address, so the session
		// token is reused across these calls (and may already be held from the
		// settings page loaded earlier in this file).
		assert.ok(subsonic.calls.get('/auth/login') <= 1, `${subsonic.calls.get('/auth/login')} sign-ins`);
	});

	test('a session token Navidrome stopped accepting is replaced once', async () => {
		nd().acceptFrom = nd().issued + 1;
		subsonic.calls.reset();
		const linked = await action(user, 'linkListenBrainz', { token: subsonic.LISTENBRAINZ_TOKEN });
		assert.equal(linked.type, 'success');
		assert.equal(subsonic.calls.get('/auth/login'), 1);
		await action(user, 'unlinkScrobbler', { service: 'listenbrainz' });
	});

	test('Last.fm: approval on last.fm comes back here and is handed to Navidrome', async () => {
		const started = await action(user, 'startLastfm');
		assert.equal(started.type, 'success', explain(JSON.stringify(started)));
		const approval = new URL(started.lastfmUrl);
		assert.equal(approval.origin, 'https://www.last.fm');
		assert.equal(approval.searchParams.get('api_key'), 'mock-lastfm-key');
		const callback = new URL(approval.searchParams.get('cb'));
		assert.equal(callback.origin, app.url);
		assert.equal(callback.pathname, '/settings/lastfm');
		assert.ok(nd().linkTokens.has(callback.searchParams.get('uid')));

		// What last.fm does: append its token and send the browser back.
		const back = await user.request(`${callback.pathname}${callback.search}&token=lastfm-ok`, {
			headers: { accept: 'text/html' }
		});
		assert.equal(back.status, 303);
		assert.equal(back.headers.get('location'), '/settings?lastfm=linked');
		assert.equal(nd().linked.lastfm, true);

		const unlinked = await action(user, 'unlinkScrobbler', { service: 'lastfm' });
		assert.equal(unlinked.type, 'success');
		assert.equal(nd().linked.lastfm, false);
	});

	test('Last.fm: a return from another account, or with a changed state, is refused', async () => {
		const started = await action(user, 'startLastfm');
		const callback = new URL(new URL(started.lastfmUrl).searchParams.get('cb'));
		const path = `${callback.pathname}${callback.search}&token=lastfm-ok`;

		subsonic.state.username = 'second';
		subsonic.state.password = 'secondpass';
		const other = new Client(app.url);
		await other.signIn({ username: 'second', password: 'secondpass', backend: 'subsonic' });
		subsonic.state.username = 'testuser';
		subsonic.state.password = 'testpass';
		const stolen = await other.request(path, { headers: { accept: 'text/html' } });
		assert.equal(stolen.headers.get('location'), '/settings?lastfm=refused');

		const tampered = await user.request(path.replace(/state=[^&]+/, 'state=AAAA'), { headers: { accept: 'text/html' } });
		assert.equal(tampered.headers.get('location'), '/settings?lastfm=refused');
		assert.equal(nd().linked.lastfm, false, 'nothing reached Navidrome');

		const anonymous = await new Client(app.url).request(path, { headers: { accept: 'text/html' } });
		assert.equal(anonymous.status, 303);
		assert.match(anonymous.headers.get('location') ?? '', /^\/login\?next=/);
	});

	test('a server that is not Navidrome, and a Jellyfin account, offer neither', async () => {
		const saved = nd();
		subsonic.state.navidrome = null;
		try {
			const started = await action(user, 'startLastfm');
			assert.equal(started.status, 404);
		} finally {
			subsonic.state.navidrome = saved;
		}

		const client = new Client(app.url);
		await client.signIn({ username: 'jfuser', password: 'jfpass', backend: 'jellyfin' });
		const jellyfin = await action(client, 'linkListenBrainz', { token: subsonic.LISTENBRAINZ_TOKEN });
		assert.equal(jellyfin.status, 404);
	});
});


describe('instant mix', () => {
	const mix = async (client, of, id) => {
		const response = await client.json('/api/tracks', 'POST', { source: 'mix', of, id });
		return { status: response.status, songs: response.ok ? (await response.json()).songs : null };
	};

	test('a server with nothing similar answers with an empty mix, not an error', async () => {
		subsonic.state.mixSize = 0;
		const { status, songs } = await mix(user, 'album', 'al3');
		assert.equal(status, 200, explain('mix failed'));
		assert.deepEqual(songs, []);
	});

	test('a song\'s mix starts with the song, and albums and artists mix too', async () => {
		subsonic.state.mixSize = 5;
		try {
			const bySong = await mix(user, 'song', 's3a');
			assert.equal(bySong.status, 200, explain('song mix failed'));
			assert.equal(bySong.songs[0].id, 's3a', 'the mix does not start with its song');
			assert.equal(bySong.songs.length, 6);
			assert.equal(new Set(bySong.songs.map((song) => song.id)).size, 6, 'a song is in the mix twice');

			for (const [of, id] of [['album', 'al3'], ['artist', 'ar3']]) {
				const result = await mix(user, of, id);
				assert.equal(result.songs.length, 5, `${of} mix`);
			}
		} finally {
			subsonic.state.mixSize = 0;
		}
	});

	test('the kind of seed and its id are required', async () => {
		assert.equal((await mix(user, 'playlist', 'al3')).status, 400);
		assert.equal((await mix(user, 'album', undefined)).status, 400);
	});

	test('Jellyfin mixes from its own endpoint, with a song first and once', async () => {
		const client = new Client(app.url);
		await client.signIn({ username: 'jfuser', password: 'jfpass', backend: 'jellyfin' });
		const byAlbum = await mix(client, 'album', 'b1');
		assert.equal(byAlbum.status, 200, explain('Jellyfin mix failed'));
		assert.deepEqual(byAlbum.songs.map((song) => song.id), ['t1', 't2', 't3']);
		const bySong = await mix(client, 'song', 't2');
		assert.deepEqual(bySong.songs.map((song) => song.id), ['t2', 't1', 't3']);
		assert.deepEqual((await mix(client, 'artist', 'a1')).songs, []);
	});
});

describe('links to albums and playlists', () => {
	const share = async (body) => {
		const response = await user.json('/api/shares', 'POST', body);
		return { status: response.status, body: response.ok ? await response.json() : null };
	};
	const anonymous = () => new Client(app.url);

	test('an album link lists its tracks and plays each by its position, and nothing past them', async () => {
		const made = await share({ kind: 'album', id: 'al5', days: 1 });
		assert.equal(made.status, 200, explain('album link failed'));
		const visitor = anonymous();
		const { response, html } = await visitor.page(made.body.path);
		assert.equal(response.status, 200);
		for (const text of ['Album 5', 'Song 5a', 'Song 5b']) assert.match(html, new RegExp(text));
		assert.ok(!html.includes('al5') && !html.includes('s5a'), 'an upstream id reached the page');

		const status = async (path) => (await visitor.request(made.body.path + path)).status;
		assert.equal(await status('/stream/0'), 200);
		assert.equal(await status('/stream/1'), 200);
		assert.equal(await status('/cover'), 200);
		assert.equal(await status('/cover/1'), 200);
		for (const path of ['/stream/2', '/stream/01', '/stream/-1', '/stream/abc', '/stream/99999', '/cover/2']) {
			assert.equal(await status(path), 404, path);
		}

		// Withdrawn: every position stops.
		assert.equal((await user.request(`/api/shares/${made.body.id}`, { method: 'DELETE' })).status, 200);
		assert.equal(await status('/stream/1'), 404);
	});

	test('a playlist link plays the playlist as its owner has it', async () => {
		const made = await share({ kind: 'playlist', id: 'pl1' });
		assert.equal(made.status, 200, explain('playlist link failed'));
		const { html } = await anonymous().page(made.body.path);
		assert.match(html, /Mock Playlist/);
		assert.match(html, /Song 1a/);
		assert.match(html, /Song 2a/);
		await user.request(`/api/shares/${made.body.id}`, { method: 'DELETE' });
	});

	test('an album its owner can no longer see stops playing through the link', async () => {
		const made = await share({ kind: 'album', id: 'al6' });
		subsonic.state.missing.add('al6');
		try {
			const visitor = anonymous();
			assert.equal((await visitor.request(`${made.body.path}/stream/0`)).status, 404);
			const { html } = await visitor.page(made.body.path);
			assert.match(html, /This music is not available/);
		} finally {
			subsonic.state.missing.delete('al6');
			await user.request(`/api/shares/${made.body.id}`, { method: 'DELETE' });
		}
	});

	test('only a kind it knows, and an item the owner can see, becomes a link', async () => {
		assert.equal((await share({ kind: 'artist', id: 'ar5' })).status, 400);
		assert.equal((await share({ kind: 'album', id: 'al9999' })).status, 404);
		assert.equal((await share({ kind: 'playlist', id: 'nope' })).status, 404);
	});

	test('a song link made the old way still works, at position 0 only', async () => {
		const made = await share({ songId: 's7a' });
		assert.equal(made.status, 200);
		const visitor = anonymous();
		assert.equal((await visitor.request(`${made.body.path}/stream`)).status, 200);
		assert.equal((await visitor.request(`${made.body.path}/stream/0`)).status, 200);
		assert.equal((await visitor.request(`${made.body.path}/stream/1`)).status, 404);
		await user.request(`/api/shares/${made.body.id}`, { method: 'DELETE' });
	});

	test('Settings names each link by what it is to', async () => {
		const album = await share({ kind: 'album', id: 'al8' });
		const { html } = await user.page('/settings');
		assert.match(html, /Album 8/);
		assert.match(html, /Album ·/);
		await user.request(`/api/shares/${album.body.id}`, { method: 'DELETE' });
	});
});

describe('reordering a playlist', () => {
	const move = (client, id, body) => client.json(`/api/playlists/${id}/tracks`, 'PATCH', body);

	test('an entry moves, and the playlist is written back in the new order', async () => {
		subsonic.state.playlistEntries = ['s1a', 's2a', 's3a'];
		try {
			const response = await move(user, 'pl1', { from: 0, to: 2, songId: 's1a', count: 3 });
			assert.equal(response.status, 200, explain('move failed'));
			assert.deepEqual(subsonic.state.playlistEntries, ['s2a', 's3a', 's1a']);
			assert.equal(subsonic.state.lastWrite.post, false, 'a short playlist went as a form');
		} finally {
			subsonic.state.playlistEntries = ['s1a', 's2a'];
		}
	});

	test('a playlist changed since the page loaded is refused and left alone', async () => {
		subsonic.state.playlistEntries = ['s1a', 's2a', 's3a'];
		try {
			// Another song at `from` now, and one entry more than the page saw.
			for (const body of [
				{ from: 0, to: 1, songId: 's9a', count: 3 },
				{ from: 0, to: 1, songId: 's1a', count: 2 },
				{ from: 0, to: 5, songId: 's1a', count: 3 }
			]) {
				const response = await move(user, 'pl1', body);
				assert.equal(response.status, 409, JSON.stringify(body));
			}
			assert.deepEqual(subsonic.state.playlistEntries, ['s1a', 's2a', 's3a']);
		} finally {
			subsonic.state.playlistEntries = ['s1a', 's2a'];
		}
	});

	test('a long playlist is written as a form rather than a URL', async () => {
		const ids = Array.from({ length: 160 }, (_, i) => `s${i % 40}${String.fromCharCode(97 + Math.floor(i / 40))}`);
		subsonic.state.playlistEntries = [...ids];
		try {
			const response = await move(user, 'pl1', { from: 159, to: 0, songId: ids[159], count: 160 });
			assert.equal(response.status, 200, explain('long move failed'));
			assert.equal(subsonic.state.lastWrite.post, true, 'the rewrite went in the URL');
			assert.deepEqual(subsonic.state.playlistEntries, [ids[159], ...ids.slice(0, 159)]);
		} finally {
			subsonic.state.playlistEntries = ['s1a', 's2a'];
		}
	});

	test('the positions have to be two different places in the list', async () => {
		for (const body of [
			{ from: 1, to: 1, songId: 's2a', count: 2 },
			{ from: -1, to: 0, songId: 's1a', count: 2 },
			{ from: 0, to: 1.5, songId: 's1a', count: 2 },
			{ from: 0, to: 1, count: 2 }
		]) {
			assert.equal((await move(user, 'pl1', body)).status, 400, JSON.stringify(body));
		}
	});

	test('Jellyfin moves the entry in place, by its entry id', async () => {
		const client = new Client(app.url);
		await client.signIn({ username: 'jfuser', password: 'jfpass', backend: 'jellyfin' });
		const response = await move(client, 'jpl', { from: 0, to: 2, songId: 'jt1', count: 3 });
		assert.equal(response.status, 200, explain('Jellyfin move failed'));
		assert.equal(jellyfin.calls.get('POST /Playlists/jpl/Items/e1/Move/2'), 1);
		// The page's view is now stale: the first entry is jt2.
		const stale = await move(client, 'jpl', { from: 0, to: 1, songId: 'jt1', count: 3 });
		assert.equal(stale.status, 409);
		await move(client, 'jpl', { from: 2, to: 0, songId: 'jt1', count: 3 });
	});
});

describe('sessions ending', () => {
	test('a credential the music server stops accepting signs the account out', async () => {
		const client = new Client(app.url);
		await client.signIn({ username: 'testuser', password: 'testpass', backend: 'subsonic' });
		subsonic.state.password = 'changed-upstream';
		try {
			const { response } = await client.page('/albums');
			assert.equal(response.status, 401);
			const after = await client.request('/albums', { headers: { accept: 'text/html' } });
			assert.equal(after.status, 303);
			assert.match(after.headers.get('location') ?? '', /^\/login/);
		} finally {
			subsonic.state.password = 'testpass';
		}
	});

	test('signing out ends the session', async () => {
		const client = new Client(app.url);
		await client.signIn({ username: 'testuser', password: 'testpass', backend: 'subsonic' });
		const response = await client.request('/logout', { method: 'POST' });
		assert.ok([200, 303].includes(response.status), `logout answered ${response.status}`);
		const after = await client.request('/', { headers: { accept: 'text/html' } });
		assert.equal(after.status, 303);
	});
});

describe('signed in on', () => {
	const FIREFOX_ANDROID = 'Mozilla/5.0 (Android 15; Mobile; rv:143.0) Gecko/143.0 Firefox/143.0';
	const SAFARI_IPHONE =
		'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1';

	/** A client signed in with `userAgent`, as a browser of that kind would be. */
	async function signedIn(userAgent, account = { username: 'testuser', password: 'testpass', backend: 'subsonic' }) {
		const client = new Client(app.url);
		const response = await client.request('/login', {
			method: 'POST',
			headers: {
				'content-type': 'application/x-www-form-urlencoded',
				accept: 'text/html',
				'user-agent': userAgent
			},
			body: new URLSearchParams({ ...account, next: '/' }).toString()
		});
		assert.equal(response.status, 303, explain('sign-in failed'));
		return client;
	}

	/** The handles the settings page offers to sign out, in its order. */
	async function handles(client) {
		const { html } = await client.page('/settings');
		return [...html.matchAll(/name="handle" value="([0-9a-f]{16})"/g)].map((match) => match[1]);
	}

	async function action(client, name, fields = {}) {
		const response = await client.request(`/settings?/${name}`, {
			method: 'POST',
			headers: {
				'content-type': 'application/x-www-form-urlencoded',
				accept: 'application/json',
				'x-sveltekit-action': 'true'
			},
			body: new URLSearchParams(fields).toString()
		});
		return { status: response.status, result: await response.json() };
	}

	const signedOut = async (client) => (await client.request('/', { headers: { accept: 'text/html' } })).status === 303;

	test('settings lists each browser by name, and marks this one', async () => {
		const phone = await signedIn(FIREFOX_ANDROID);
		const iphone = await signedIn(SAFARI_IPHONE);
		const { html } = await phone.page('/settings');
		assert.match(html, /Firefox on Android/);
		assert.match(html, /Safari on iPhone/);
		assert.match(html, /This browser/);
		// A browser signs out only sessions older than its own: the iPhone, signed
		// in second, is offered the phone; the phone is told to use the iPhone.
		assert.ok((await handles(iphone)).length >= 1);
		assert.match(html, /Signed in after this browser\.\s*<span class="later-how[^"]*">Sign it out there, or sign in again here\.</);
		assert.ok(!html.includes('Mozilla/5.0'), 'the whole user agent reached the page');
		await iphone.request('/logout', { method: 'POST' });
		await phone.request('/logout', { method: 'POST' });
	});

	test('an older browser can be signed out, and only that one', async () => {
		const phone = await signedIn(FIREFOX_ANDROID);
		const iphone = await signedIn(SAFARI_IPHONE);
		// Each browser is offered the sessions older than its own, so the phone's
		// is the one the iPhone is offered and the phone is not.
		const phoneSees = new Set(await handles(phone));
		const target = (await handles(iphone)).find((handle) => !phoneSees.has(handle));
		assert.ok(target, 'no handle for the phone');

		const ended = await action(iphone, 'endSession', { handle: target });
		assert.equal(ended.result.type, 'success', JSON.stringify(ended.result));
		assert.equal(await signedOut(phone), true, 'the phone is still signed in');
		assert.equal(await signedOut(iphone), false, 'the iPhone signed itself out');
		await iphone.request('/logout', { method: 'POST' });
	});

	test('a stolen, older session cannot sign out the owner who signed in after it', async () => {
		const stolen = await signedIn(FIREFOX_ANDROID);
		const owner = await signedIn(SAFARI_IPHONE);
		const attempt = await action(stolen, 'endOtherSessions');
		assert.equal(attempt.result.type, 'success');
		assert.equal(await signedOut(owner), false, 'the owner was signed out');

		const ownerSees = await handles(owner);
		for (const handle of ownerSees) await action(owner, 'endSession', { handle });
		assert.equal(await signedOut(stolen), true, 'the owner could not end the older session');
		await owner.request('/logout', { method: 'POST' });
	});

	test('a handle that is not one of the account\'s own ends nothing', async () => {
		const phone = await signedIn(FIREFOX_ANDROID);
		const other = await signedIn(SAFARI_IPHONE, { username: 'jfuser', password: 'jfpass', backend: 'jellyfin' });
		const otherHandles = await handles(await signedIn(FIREFOX_ANDROID, { username: 'jfuser', password: 'jfpass', backend: 'jellyfin' }));
		assert.ok(otherHandles.length > 0);

		for (const handle of [...otherHandles, 'ffffffffffffffff', 'not-a-handle', '']) {
			const attempt = await action(phone, 'endSession', { handle });
			assert.equal(attempt.result.type, 'failure', `${handle}: ${JSON.stringify(attempt.result)}`);
		}
		assert.equal(await signedOut(other), false, 'a session of another account ended');
		await other.request('/logout', { method: 'POST' });
		await phone.request('/logout', { method: 'POST' });
	});

	test('"everywhere else" leaves this browser signed in and the older ones out', async () => {
		const others = [await signedIn(SAFARI_IPHONE), await signedIn(SAFARI_IPHONE)];
		const here = await signedIn(FIREFOX_ANDROID);
		const later = await signedIn(SAFARI_IPHONE);
		const ended = await action(here, 'endOtherSessions');
		assert.equal(ended.result.type, 'success');
		for (const client of others) assert.equal(await signedOut(client), true, 'an older browser is still signed in');
		assert.equal(await signedOut(here), false, 'this browser was signed out');
		assert.equal(await signedOut(later), false, 'a browser that signed in later was signed out');
		assert.deepEqual(await handles(here), [], 'the list still offers another session');
		await later.request('/logout', { method: 'POST' });
		await here.request('/logout', { method: 'POST' });
	});

	test('a database from before the device column opens and records it', async () => {
		const { default: Database } = await import('better-sqlite3');
		const { mkdtempSync } = await import('node:fs');
		const { tmpdir } = await import('node:os');
		const { join } = await import('node:path');
		const dataDir = mkdtempSync(join(tmpdir(), 'heddohon-e2e-old-'));
		const old = new Database(join(dataDir, 'heddohon.db'));
		old.exec(`CREATE TABLE sessions (
			token_digest TEXT PRIMARY KEY, account_id TEXT NOT NULL, created_at INTEGER NOT NULL,
			expires_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, client_pseudonym TEXT)`);
		old.close();

		const upgraded = await startApp({ subsonicUrl: subsonic.url, jellyfinUrl: jellyfin.url, dataDir });
		try {
			const client = new Client(upgraded.url);
			const response = await client.request('/login', {
				method: 'POST',
				headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'text/html', 'user-agent': FIREFOX_ANDROID },
				body: new URLSearchParams({ username: 'testuser', password: 'testpass', backend: 'subsonic', next: '/' }).toString()
			});
			assert.equal(response.status, 303, upgraded.output());
			const { html } = await client.page('/settings');
			assert.match(html, /Firefox on Android/);
		} finally {
			await upgraded.stop();
		}
	});
});

describe('the security review of 2026-09-28', () => {
	// The session tests above end every older session of the account, the shared
	// client's among them.
	before(async () => {
		assert.equal((await user.signIn({ username: 'testuser', password: 'testpass', backend: 'subsonic' })).status, 303);
	});

	const share = async (body, client = user) => {
		const response = await client.json('/api/shares', 'POST', body);
		return { status: response.status, body: response.ok ? await response.json() : null };
	};
	const withdraw = (id) => user.request(`/api/shares/${id}`, { method: 'DELETE' });

	test('a link reads its album from the music server once while it is held', async () => {
		const made = await share({ kind: 'album', id: 'al6', days: 1 });
		assert.equal(made.status, 200, explain('album link failed'));
		subsonic.calls.reset();
		const visitor = new Client(app.url);
		await visitor.page(made.body.path);
		for (let i = 0; i < 5; i++) {
			assert.equal((await visitor.request(`${made.body.path}/stream/${i % 2}`, { method: 'HEAD' })).status, 200);
			assert.equal((await visitor.request(`${made.body.path}/cover/${i % 2}`)).status, 200);
		}
		assert.equal(subsonic.calls.get('getAlbum'), 1);
		await withdraw(made.body.id);
	});

	test('a playlist edited here reaches its link at once', async () => {
		const made = await share({ kind: 'playlist', id: 'pl1' });
		assert.equal(made.status, 200, explain('playlist link failed'));
		const visitor = new Client(app.url);
		const order = (html) => html.indexOf('>Song 2a<') < html.indexOf('>Song 1a<');
		subsonic.state.playlistEntries = ['s1a', 's2a'];
		try {
			assert.equal(order((await visitor.page(made.body.path)).html), false);
			const moved = await user.json('/api/playlists/pl1/tracks', 'PATCH', { from: 0, to: 1, songId: 's1a', count: 2 });
			assert.equal(moved.status, 200, explain('move failed'));
			assert.equal(order((await visitor.page(made.body.path)).html), true, 'the link served the old order');
		} finally {
			subsonic.state.playlistEntries = ['s1a', 's2a'];
			await withdraw(made.body.id);
		}
	});

	test('a link withdrawn while its track is being looked up does not play it', async () => {
		const made = await share({ kind: 'album', id: 'al7', days: 1 });
		subsonic.state.delays.set('getAlbum', 1500);
		try {
			const pending = new Client(app.url).request(`${made.body.path}/stream/0`);
			await new Promise((done) => setTimeout(done, 300));
			assert.equal((await withdraw(made.body.id)).status, 200);
			const response = await pending;
			assert.equal(response.status, 404, 'the track played after the link was withdrawn');
		} finally {
			subsonic.state.delays.clear();
		}
	});

	test('a link to a playlist the account does not own is refused', async () => {
		subsonic.state.playlistOwner = 'someone-else';
		try {
			assert.equal((await share({ kind: 'playlist', id: 'pl1' })).status, 403);
		} finally {
			subsonic.state.playlistOwner = null;
		}
	});

	test('on Jellyfin a link is only made to an item of its kind', async () => {
		const client = new Client(app.url);
		await client.signIn({ username: 'jfuser', password: 'jfpass', backend: 'jellyfin' });
		assert.equal((await share({ kind: 'album', id: 'jpl' }, client)).status, 404, 'an album link to a playlist');
		assert.equal((await share({ kind: 'song', id: 'b1' }, client)).status, 404, 'a song link to an album');
		const album = await share({ kind: 'album', id: 'b1' }, client);
		assert.equal(album.status, 200, explain('album link on Jellyfin failed'));
		await client.request(`/api/shares/${album.body.id}`, { method: 'DELETE' });
	});

	test('on Jellyfin an artist id that names no artist reads nothing', async () => {
		const client = new Client(app.url);
		await client.signIn({ username: 'jfuser', password: 'jfpass', backend: 'jellyfin' });
		jellyfin.calls.reset();
		const response = await client.json('/api/tracks', 'POST', { source: 'artist', id: 'x' });
		assert.equal(response.status, 404);
		assert.equal(jellyfin.calls.get('GET /Items MusicAlbum'), 0, 'the albums were listed without a filter');
		assert.equal((await client.json('/api/tracks', 'POST', { source: 'artist', id: 'a2' })).status, 200);
	});

	test('a playlist with entries the server leaves out of its list is not rewritten', async () => {
		subsonic.state.playlistEntries = ['s1a', 's2a'];
		subsonic.state.hiddenEntries = 1;
		try {
			const response = await user.json('/api/playlists/pl1/tracks', 'PATCH', { from: 0, to: 1, songId: 's1a', count: 2 });
			assert.equal(response.status, 409);
			assert.deepEqual(subsonic.state.playlistEntries, ['s1a', 's2a'], 'the playlist was rewritten');
		} finally {
			subsonic.state.hiddenEntries = 0;
		}
	});

	test("the music server's own error text stays in the log", async () => {
		const response = await user.json('/api/tracks', 'POST', { source: 'album', id: 'broken' });
		assert.equal(response.status, 502);
		assert.ok(!(await response.text()).includes('navidrome.db'), 'the upstream text reached the browser');
		assert.match((await user.page('/albums/broken')).html, /Something went wrong|music server/);
		assert.ok(!(await user.page('/albums/broken')).html.includes('navidrome.db'));
	});

	test('an id of 256 characters or more is refused before the music server is asked', async () => {
		subsonic.calls.reset();
		assert.equal((await user.request(`/albums/${'a'.repeat(300)}`, { headers: { accept: 'text/html' } })).status, 404);
		assert.equal((await user.request(`/api/lyrics/${'a'.repeat(300)}`)).status, 404);
		assert.equal(subsonic.calls.get('getAlbum'), 0);
	});

	test('files served from disk carry the hardening headers', async () => {
		const anonymous = new Client(app.url);
		for (const path of ['/offline.html', '/offline.js', '/service-worker.js', '/_app/version.json']) {
			const response = await anonymous.request(path);
			assert.equal(response.status, 200, path);
			assert.equal(response.headers.get('x-content-type-options'), 'nosniff', path);
			assert.equal(response.headers.get('x-frame-options'), 'SAMEORIGIN', path);
			assert.match(response.headers.get('strict-transport-security') ?? '', /max-age/, path);
		}
		const page = await anonymous.request('/offline.html');
		assert.match(page.headers.get('content-security-policy') ?? '', /default-src 'none'/);
	});

	test("every response is marked as Heddohon's, for the offline page to tell it from a proxy's", async () => {
		const anonymous = new Client(app.url);
		for (const path of ['/login', '/offline.js', '/healthz', '/api/settings', '/nowhere']) {
			assert.equal((await anonymous.request(path)).headers.get('x-heddohon'), '1', path);
		}
	});

	test('signing out deletes the cookie as it was set', async () => {
		const client = new Client(app.url);
		await client.signIn({ username: 'testuser', password: 'testpass', backend: 'subsonic' });
		const response = await client.request('/logout', { method: 'POST', headers: { accept: 'text/html' } });
		const bare = response.headers.getSetCookie().find((line) => line.startsWith('heddohon_session='));
		assert.ok(bare, 'the cookie was not deleted');
		assert.doesNotMatch(bare, /;\s*Secure/i, 'a plain-http deletion marked Secure is ignored by the browser');
	});

	test('an account holds at most 50 sessions', async () => {
		const separate = await startApp({ subsonicUrl: subsonic.url, jellyfinUrl: jellyfin.url });
		try {
			let last;
			for (let i = 0; i < 55; i++) {
				last = new Client(separate.url);
				assert.equal((await last.signIn({ username: 'testuser', password: 'testpass', backend: 'subsonic' })).status, 303);
			}
			const { html } = await last.page('/settings');
			const count = Number(/Signed in on<\/h3>\s*<span[^>]*>(\d+)</.exec(html)?.[1]);
			assert.equal(count, 50, separate.output());
		} finally {
			await separate.stop();
		}
	});

	test('a share token after stray characters is still taken out of the log', async () => {
		const logged = await startApp({ subsonicUrl: subsonic.url, jellyfinUrl: jellyfin.url, env: { HEDDOHON_LOG_LEVEL: 'debug' } });
		try {
			const token = 'A'.repeat(20) + 'b'.repeat(23);
			const visitor = new Client(logged.url);
			for (const path of [`/share/%20${token}/stream/0`, `/share//${token}`, `/share/%22${token}`]) {
				await visitor.request(path);
			}
			assert.ok(!logged.output().includes(token), 'a token reached the log');
		} finally {
			await logged.stop();
		}
	});

	test('an unreachable music server is not named to the browser', async () => {
		const unreachable = await startApp({ subsonicUrl: 'http://127.0.0.1:9', jellyfinUrl: jellyfin.url });
		try {
			const client = new Client(unreachable.url);
			const response = await client.signIn({ username: 'testuser', password: 'testpass', backend: 'subsonic' });
			const html = await response.text();
			assert.ok(!html.includes('127.0.0.1:9') && !html.includes('ECONNREFUSED'), html.slice(0, 400));
		} finally {
			await unreachable.stop();
		}
	});

	test('ending a session stops the audio it is receiving', async () => {
		const agent = (ua) => ({ 'user-agent': ua, 'content-type': 'application/x-www-form-urlencoded', accept: 'text/html' });
		const signed = async (ua) => {
			const client = new Client(app.url);
			const response = await client.request('/login', {
				method: 'POST',
				headers: agent(ua),
				body: new URLSearchParams({ username: 'testuser', password: 'testpass', backend: 'subsonic', next: '/' }).toString()
			});
			assert.equal(response.status, 303);
			return client;
		};
		const offered = async (client) =>
			[...(await client.page('/settings')).html.matchAll(/name="handle" value="([0-9a-f]{16})"/g)].map((m) => m[1]);

		subsonic.state.audio = { type: 'audio/flac', body: Buffer.alloc(200_000, 7) };
		// Half the file at once and the rest 1.5s later; the mock holds back only
		// where it ignores ranges.
		subsonic.state.ignoreRange = true;
		subsonic.state.streamSlowMs = 1500;
		try {
			const phone = await signed('Mozilla/5.0 (Android 15; Mobile; rv:143.0) Gecko/143.0 Firefox/143.0');
			const laptop = await signed('Mozilla/5.0 (X11; Linux x86_64; rv:143.0) Gecko/20100101 Firefox/143.0');
			const phoneSees = new Set(await offered(phone));
			const target = (await offered(laptop)).find((handle) => !phoneSees.has(handle));
			assert.ok(target, 'no handle for the phone');

			const response = await phone.request('/api/stream/s1a?mode=raw');
			assert.equal(response.status, 200);
			const reader = response.body.getReader();
			let received = (await reader.read()).value?.byteLength ?? 0;

			const ended = await laptop.request('/settings?/endSession', {
				method: 'POST',
				headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', 'x-sveltekit-action': 'true' },
				body: new URLSearchParams({ handle: target }).toString()
			});
			assert.equal((await ended.json()).type, 'success');

			try {
				for (;;) {
					const { done, value } = await reader.read();
					if (done) break;
					received += value.byteLength;
				}
			} catch {
				// Cut mid-body, which is the point.
			}
			assert.ok(received < 200_000, `the whole file arrived after the session ended (${received} bytes)`);
			await laptop.request('/logout', { method: 'POST' });
		} finally {
			subsonic.state.audio = null;
			subsonic.state.ignoreRange = false;
			subsonic.state.streamSlowMs = 0;
		}
	});
});

describe('the security review of 2026-09-29', () => {
	test('a music server that stalls mid-answer is given up on', async () => {
		const bounded = await startApp({
			subsonicUrl: subsonic.url,
			jellyfinUrl: jellyfin.url,
			env: { HEDDOHON_UPSTREAM_TIMEOUT_MS: '1000' }
		});
		const client = new Client(bounded.url);
		await client.signIn({ username: 'testuser', password: 'testpass', backend: 'subsonic' });
		subsonic.state.stalled.add('getAlbum');
		try {
			const started = Date.now();
			const response = await client.json('/api/tracks', 'POST', { source: 'album', id: 'al1' });
			assert.equal(response.status, 502, bounded.output());
			assert.ok(Date.now() - started < 5000, `answered after ${Date.now() - started}ms`);
		} finally {
			subsonic.state.stalled.clear();
			await bounded.stop();
		}
	});

	test('sign-in attempts from one IPv6 /64 share one address counter', async () => {
		const proxied = await startApp({
			subsonicUrl: subsonic.url,
			jellyfinUrl: jellyfin.url,
			env: { ADDRESS_HEADER: 'x-real-ip' }
		});
		const attempt = (address, i) =>
			new Client(proxied.url).request('/login', {
				method: 'POST',
				headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'text/html', 'x-real-ip': address },
				body: new URLSearchParams({ username: `spray${i}`, password: 'wrong', backend: 'subsonic', next: '/' }).toString()
			});
		try {
			for (let i = 0; i < 60; i++) {
				const response = await attempt(`2001:db8:1:2::${(i + 1).toString(16)}`, i);
				assert.notEqual(response.status, 429, `attempt ${i + 1} was throttled`);
			}
			assert.equal((await attempt('2001:db8:1:2:ffff::1', 60)).status, 429, proxied.output());
			assert.notEqual((await attempt('2001:db8:1:3::1', 61)).status, 429, 'the next /64 was throttled');
		} finally {
			await proxied.stop();
		}
	});

	test("SvelteKit's own error page carries a policy", async () => {
		assert.equal((await user.signIn({ username: 'testuser', password: 'testpass', backend: 'subsonic' })).status, 303);
		const response = await user.request('/api/lyrics/zzz', { headers: { accept: 'text/html' } });
		assert.equal(response.status, 404);
		assert.match(response.headers.get('content-type') ?? '', /^text\/html/);
		assert.match(response.headers.get('content-security-policy') ?? '', /default-src 'none'/);
	});
});
describe('headphone corrections from AutoEq', () => {
	let autoeq;
	let on;
	let listener;

	before(async () => {
		autoeq = await startAutoEq();
		on = await startApp({
			subsonicUrl: subsonic.url,
			jellyfinUrl: jellyfin.url,
			env: { HEDDOHON_AUTOEQ: 'true', HEDDOHON_AUTOEQ_URL: autoeq.url }
		});
		listener = new Client(on.url);
		await listener.signIn({ username: 'testuser', password: 'testpass', backend: 'subsonic' });
	});

	after(async () => {
		await on?.stop();
		await autoeq?.close();
	});

	const search = async (query, client = listener) => {
		const response = await client.request(`/api/autoeq?q=${encodeURIComponent(query)}`);
		return { status: response.status, results: response.ok ? (await response.json()).results : null };
	};
	const profile = (id, client = listener) => client.request(`/api/autoeq/profile?id=${encodeURIComponent(id)}`);

	test('is off unless asked for', async () => {
		const off = new Client(app.url);
		await off.signIn({ username: 'testuser', password: 'testpass', backend: 'subsonic' });
		assert.equal((await search('hd 650', off)).status, 404);
		assert.equal((await profile('oratory1990/over-ear/Sennheiser HD 650', off)).status, 404);
	});

	test('needs a session', async () => {
		assert.equal((await search('hd 650', new Client(on.url))).status, 401);
	});

	test('a search finds each measurement of a headphone, and reads the index once', async () => {
		const found = await search('hd 650');
		assert.equal(found.status, 200);
		assert.deepEqual(
			found.results.map((entry) => [entry.id, entry.source, entry.rig]),
			[
				['oratory1990/over-ear/Sennheiser HD 650', 'oratory1990', null],
				['crinacle/GRAS 43AG-7 over-ear/Sennheiser HD 650', 'crinacle', 'GRAS 43AG-7'],
				['crinacle/GRAS 43AG-7 over-ear/Sennheiser HD 650 (2020)', 'crinacle', 'GRAS 43AG-7']
			]
		);
		assert.deepEqual((await search('aero anc')).results.map((entry) => entry.name), ['1MORE Aero (ANC Off)']);
		assert.deepEqual((await search('climber')).results, [], 'a path that climbs out of the directory is not listed');
		assert.deepEqual((await search('h')).results, [], 'one letter is not searched for');
		assert.equal(autoeq.calls.get('index'), 1);
	});

	test('a profile comes back as numbers, and is fetched once', async () => {
		autoeq.calls.reset();
		const response = await profile('oratory1990/over-ear/Sennheiser HD 650');
		assert.equal(response.status, 200);
		assert.deepEqual(await response.json(), {
			id: 'oratory1990/over-ear/Sennheiser HD 650',
			name: 'Sennheiser HD 650',
			source: 'oratory1990',
			preamp: -6.1,
			filters: [
				{ type: 'lowshelf', frequency: 105, gain: 6.4, q: 0.7 },
				{ type: 'peaking', frequency: 8800, gain: 5.1, q: 1.42 },
				{ type: 'peaking', frequency: 118, gain: -3.1, q: 0.5 },
				{ type: 'highshelf', frequency: 10000, gain: -2.1, q: 0.7 }
			]
		});
		assert.equal((await profile('oratory1990/over-ear/Sennheiser HD 650')).status, 200);
		assert.equal(autoeq.calls.get('profile'), 1);
	});

	test('an id the index does not list is never asked for upstream', async () => {
		autoeq.calls.reset();
		for (const id of ['../../secret/Climber', 'oratory1990/over-ear/Nothing', 'oratory1990/over-ear/Sennheiser HD 650/../x']) {
			assert.equal((await profile(id)).status, 404, id);
		}
		assert.equal(autoeq.calls.get('profile'), 0);
	});

	test('a profile whose file is missing answers 502', async () => {
		assert.equal((await profile('crinacle/GRAS 43AG-7 over-ear/Sennheiser HD 650')).status, 502);
	});

	test('a restart reads the index from the data directory, and a failed fetch leaves it in use', async () => {
		// A data directory of its own with the index the first app stored: two
		// processes do not share a database.
		const dataDir = mkdtempSync(join(tmpdir(), 'heddohon-e2e-'));
		const file = join(dataDir, 'autoeq-index.json');
		copyFileSync(join(on.dataDir, 'autoeq-index.json'), file);
		const stored = JSON.parse(readFileSync(file, 'utf8'));
		assert.equal(stored.etag, '"v1"');
		autoeq.calls.reset();
		const again = await startApp({
			subsonicUrl: subsonic.url,
			jellyfinUrl: jellyfin.url,
			dataDir,
			env: { HEDDOHON_AUTOEQ: 'true', HEDDOHON_AUTOEQ_URL: autoeq.url }
		});
		try {
			const client = new Client(again.url);
			await client.signIn({ username: 'testuser', password: 'testpass', backend: 'subsonic' });
			assert.equal((await search('hd 650', client)).results.length, 3);
			assert.equal(autoeq.calls.get('index') + autoeq.calls.get('index304'), 0, 'a day has not passed');
		} finally {
			await again.stop();
		}

		// A day on, by the date in the file: the server asks with the ETag it kept.
		// Stopping an app removes its data directory, so it is made again each time.
		for (const [down, expected] of [
			[false, { index304: 1, results: 3 }],
			[true, { index304: 0, results: 3 }]
		]) {
			mkdirSync(dataDir, { recursive: true });
			writeFileSync(file, JSON.stringify({ ...stored, fetchedAt: Date.now() - 25 * 60 * 60 * 1000 }));
			autoeq.calls.reset();
			autoeq.state.down = down;
			const aged = await startApp({
				subsonicUrl: subsonic.url,
				jellyfinUrl: jellyfin.url,
				dataDir,
				env: { HEDDOHON_AUTOEQ: 'true', HEDDOHON_AUTOEQ_URL: autoeq.url }
			});
			try {
				const client = new Client(aged.url);
				await client.signIn({ username: 'testuser', password: 'testpass', backend: 'subsonic' });
				assert.equal((await search('hd 650', client)).results.length, expected.results, `down=${down}`);
				assert.equal(autoeq.calls.get('index304'), expected.index304, `down=${down}`);
				assert.equal(autoeq.calls.get('index'), 0);
			} finally {
				autoeq.state.down = false;
				await aged.stop();
			}
		}
	});
});


describe('log files', () => {
	const day = (daysAgo) => new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
	/** A data directory with log files of these ages, in days, and a file that is not a log. */
	function seeded(ages) {
		const dataDir = mkdtempSync(join(tmpdir(), 'heddohon-e2e-'));
		mkdirSync(join(dataDir, 'logs'));
		for (const age of ages) writeFileSync(join(dataDir, 'logs', `heddohon-${day(age)}.log`), 'old\n');
		writeFileSync(join(dataDir, 'logs', 'notes.txt'), 'kept\n');
		return dataDir;
	}
	const start = (dataDir, env) =>
		startApp({ subsonicUrl: subsonic.url, jellyfinUrl: jellyfin.url, dataDir, env: { HEDDOHON_LOG_LEVEL: 'info', ...env } });

	test('one file a day under the data directory, and files more than 7 days old are deleted', async () => {
		const dataDir = seeded([3, 7, 8, 400]);
		const logged = await start(dataDir, {});
		try {
			const client = new Client(logged.url);
			await client.signIn({ username: 'testuser', password: 'testpass', backend: 'subsonic' });
			assert.deepEqual(
				readdirSync(join(dataDir, 'logs')).sort(),
				[`heddohon-${day(0)}.log`, `heddohon-${day(3)}.log`, `heddohon-${day(7)}.log`, 'notes.txt'].sort()
			);
			const today = readFileSync(join(dataDir, 'logs', `heddohon-${day(0)}.log`), 'utf8');
			assert.match(today, / info  started .*logFiles=7d/);
			assert.match(today, / info  signed-in username=testuser /);
			// What the file holds is what the logger sent to stdout and stderr
			// (the line the Node adapter prints as it starts to listen is not its own).
			const printed = logged.output().trim().split('\n').filter((line) => /^\d{4}-\d{2}-\d{2}T/.test(line));
			assert.deepEqual(today.trim().split('\n'), printed);
			assert.ok(!today.includes('testpass'));
		} finally {
			await logged.stop();
		}
	});

	test('HEDDOHON_LOG_KEEP_DAYS sets how many days are kept, and 0 writes no files', async () => {
		const longer = seeded([8, 29, 31]);
		const kept = await start(longer, { HEDDOHON_LOG_KEEP_DAYS: '30' });
		try {
			assert.deepEqual(
				readdirSync(join(longer, 'logs')).sort(),
				[`heddohon-${day(0)}.log`, `heddohon-${day(8)}.log`, `heddohon-${day(29)}.log`, 'notes.txt'].sort()
			);
		} finally {
			await kept.stop();
		}

		const none = seeded([400]);
		const off = await start(none, { HEDDOHON_LOG_KEEP_DAYS: '0' });
		try {
			assert.deepEqual(readdirSync(join(none, 'logs')).sort(), [`heddohon-${day(400)}.log`, 'notes.txt'].sort(), 'nothing written, nothing deleted');
			assert.match(off.output(), /started .*logFiles=off/);
		} finally {
			await off.stop();
		}
	});

	test('a logs directory that cannot be written is reported once, and the server runs', async () => {
		const dataDir = mkdtempSync(join(tmpdir(), 'heddohon-e2e-'));
		// A file where the directory should be.
		writeFileSync(join(dataDir, 'logs'), '');
		const blocked = await start(dataDir, {});
		try {
			assert.equal((await fetch(`${blocked.url}/healthz`)).status, 200);
			assert.equal(blocked.output().split('\n').filter((line) => line.includes('log-file-failed')).length, 1);
			assert.match(blocked.output(), / info  started /);
		} finally {
			await blocked.stop();
		}
	});
});

describe('internet radio', () => {
	let host;
	let on;
	let listener;
	const station = (id, path, extra = {}) => ({ id, name: `Station ${id}`, streamUrl: `${host.url}${path}`, ...extra });

	before(async () => {
		host = await startStationHost();
		subsonic.state.radio = [
			station('1', '/live', { homePageUrl: 'https://radio.example/one' }),
			station('2', '/moved', { homePageUrl: 'javascript:alert(1)' }),
			station('3', '/list.m3u'),
			station('4', '/list.pls'),
			station('5', '/hls.m3u8'),
			station('6', '/page'),
			station('7', '/loop'),
			{ id: '8', name: 'By name', streamUrl: `http://localhost:${new URL(host.url).port}/live` },
			{ id: '9', name: 'A file', streamUrl: 'file:///etc/passwd' },
			{ id: '10', name: 'With a password', streamUrl: `http://user:pass@127.0.0.1:${new URL(host.url).port}/live` }
		];
		// The mock host is on loopback, which a station may not be unless this is set.
		on = await startApp({ subsonicUrl: subsonic.url, jellyfinUrl: jellyfin.url, env: { HEDDOHON_RADIO_PRIVATE: 'true' } });
		listener = new Client(on.url);
		await listener.signIn({ username: 'testuser', password: 'testpass', backend: 'subsonic' });
	});

	after(async () => {
		subsonic.state.radio = [];
		await on?.stop();
		await host?.close();
	});

	const stream = (id, client = listener) => client.request(`/api/radio/${id}/stream`);

	test('the page lists the stations, with a link only to an http or https page, and never the stream address', async () => {
		const { response, html } = await listener.page('/radio');
		assert.equal(response.status, 200);
		assert.match(html, /Station 1/);
		assert.match(html, /href="https:\/\/radio\.example\/one"/);
		assert.ok(!html.includes('javascript:'), 'a page address that is not http or https is dropped');
		assert.ok(!html.includes(host.url), 'the stream address stays on the server');
	});

	test('a station plays through the server: directly, after a redirect, and from an .m3u or a .pls', async () => {
		for (const id of ['1', '2', '3', '4']) {
			host.calls.reset();
			const response = await stream(id);
			assert.equal(response.status, 200, `station ${id}`);
			assert.equal(response.headers.get('content-type'), 'audio/mpeg');
			assert.equal(response.headers.get('cache-control'), 'no-store');
			assert.equal((await response.arrayBuffer()).byteLength, 2000, `station ${id}`);
			assert.equal(host.calls.get('/live'), 1, `station ${id}`);
		}
	});

	test('what is not an audio stream is not passed on', async () => {
		for (const id of ['5', '6']) {
			const response = await stream(id);
			assert.equal(response.status, 502, `station ${id}`);
			assert.ok(!(await response.text()).includes('secret'));
		}
		assert.equal((await stream('7')).status, 502, 'a redirect to itself stops after three hops');
		assert.equal(host.calls.get('/loop'), 4);
	});

	test('an address that is not plain http or https, or carries a password, is refused without a request', async () => {
		host.calls.reset();
		assert.equal((await stream('9')).status, 502);
		assert.equal((await stream('10')).status, 502);
		assert.equal(host.calls.get('/live'), 0);
	});

	test('an id the music server does not list is a 404, and a session is needed', async () => {
		assert.equal((await stream('nope')).status, 404);
		assert.equal((await stream('1', new Client(on.url))).status, 401);
	});

	test('a station on a private address is refused unless HEDDOHON_RADIO_PRIVATE is set, by address and by name', async () => {
		const guarded = new Client(app.url);
		await guarded.signIn({ username: 'testuser', password: 'testpass', backend: 'subsonic' });
		host.calls.reset();
		assert.equal((await stream('1', guarded)).status, 502, 'a loopback address');
		assert.equal((await stream('8', guarded)).status, 502, 'a name that resolves to loopback');
		assert.equal(host.calls.get('/live'), 0, 'nothing was sent to it');
		// With the setting, the same name is reached.
		assert.equal((await stream('8')).status, 200);
	});

	test('HEDDOHON_RADIO=false takes the page and the route away, and Jellyfin has neither', async () => {
		const off = await startApp({ subsonicUrl: subsonic.url, jellyfinUrl: jellyfin.url, env: { HEDDOHON_RADIO: 'false' } });
		try {
			const client = new Client(off.url);
			await client.signIn({ username: 'testuser', password: 'testpass', backend: 'subsonic' });
			assert.equal((await client.page('/radio')).response.status, 404);
			assert.equal((await stream('1', client)).status, 404);
		} finally {
			await off.stop();
		}
		const jf = new Client(on.url);
		await jf.signIn({ username: 'jfuser', password: 'jfpass', backend: 'jellyfin' });
		assert.equal((await jf.page('/radio')).response.status, 404);
		assert.equal((await stream('1', jf)).status, 404);
	});
});

describe('an artist\'s releases by kind', () => {
	/** The headings of the release sections on an artist page, in order, each with its albums. */
	async function sections(client, artistId) {
		const { response, html } = await client.page(`/artists/${artistId}`);
		assert.equal(response.status, 200);
		const found = [];
		for (const part of html.split('<section').slice(1)) {
			const title = /<h2[^>]*>([^<]+)<\/h2>/.exec(part)?.[1];
			const albums = [...part.matchAll(/href="\/albums\/([^"]+)"/g)].map((match) => match[1]);
			if (title && ['Albums', 'EPs', 'Singles', 'Live', 'Compilations'].includes(title)) found.push([title, [...new Set(albums)]]);
		}
		return found;
	}

	test('what the server calls a release decides, and its size where the server does not say', async () => {
		// An account of its own: an artist read in the last minute is held per account.
		await asFreshAccount('releases', async (client) => {
		try {
			subsonic.state.releaseTypes.set('al0', ['Album']);
			subsonic.state.releaseTypes.set('al5', ['EP']);
			subsonic.state.releaseTypes.set('al6', ['Album', 'Live']);
			subsonic.state.releaseTypes.set('al7', ['Single', 'Compilation']);
			subsonic.state.albumShapes.set('al8', { songCount: 12, duration: 45 * 60 });
			subsonic.state.albumShapes.set('al9', { songCount: 5, duration: 20 * 60 });
			subsonic.state.albumShapes.set('al10', { songCount: 3, duration: 60 * 60 });
			subsonic.state.albumShapes.set('al11', { isCompilation: true });

			// Artist 0 has two records: one the server calls an album, one it says nothing about (two tracks, six minutes).
			assert.deepEqual(await sections(client, 'ar0'), [
				['Albums', ['al0']],
				['Singles', ['al0x']]
			]);
			assert.deepEqual(await sections(client, 'ar5'), [['EPs', ['al5']]]);
			assert.deepEqual(await sections(client, 'ar6'), [['Live', ['al6']]], 'a live album is listed as live');
			assert.deepEqual(await sections(client, 'ar7'), [['Compilations', ['al7']]]);
			assert.deepEqual(await sections(client, 'ar8'), [['Albums', ['al8']]], '12 tracks, 45 minutes');
			assert.deepEqual(await sections(client, 'ar9'), [['EPs', ['al9']]], '5 tracks, 20 minutes');
			assert.deepEqual(await sections(client, 'ar10'), [['Albums', ['al10']]], '3 tracks of 20 minutes are not a single');
			assert.deepEqual(await sections(client, 'ar11'), [['Compilations', ['al11']]], 'isCompilation');
		} finally {
			subsonic.state.releaseTypes.clear();
			subsonic.state.albumShapes.clear();
		}
		});
	});
});
