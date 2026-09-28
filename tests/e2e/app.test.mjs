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
import { after, before, describe, test } from 'node:test';
import { Client, startApp } from './harness.mjs';
import { startJellyfin, startSubsonic } from './mocks.mjs';

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

describe('the gate', () => {
	test('/healthz answers without a session and names no upstream URL', async () => {
		const response = await fetch(`${app.url}/healthz`);
		assert.equal(response.status, 200);
		const body = await response.text();
		assert.match(body, /"status":"ok"/);
		assert.ok(!body.includes(subsonic.url), 'the upstream URL must not appear');
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
		const { response, html } = await client.page('/favourites?tab=artists&sort=recentlyStarred');
		assert.equal(response.status, 200, explain('Jellyfin favourites page failed'));
		assert.ok(!html.includes('Recently starred'));
		assert.match(html, /Most albums/);
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
		assert.match(html, /Sign out from that browser/);
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
