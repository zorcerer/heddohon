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

	test('Jellyfin, which does not date a favourite, is not offered "recently starred"', async () => {
		const client = new Client(app.url);
		await client.signIn({ username: 'jfuser', password: 'jfpass', backend: 'jellyfin' });
		const { response, html } = await client.page('/favourites?tab=artists&sort=recentlyStarred');
		assert.equal(response.status, 200, explain('Jellyfin favourites page failed'));
		assert.ok(!html.includes('Recently starred'));
		assert.match(html, /Most albums/);
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
		subsonic.calls.reset();
		const first = await user.json('/api/tracks', 'POST', { source: 'artist', id: 'ar0', part: 'first' });
		assert.equal(first.status, 200);
		const head = await first.json();
		assert.deepEqual(head.songs.map((song) => song.id), ['s0a', 's0b']);
		assert.equal(head.more, true);
		assert.equal(subsonic.calls.get('getAlbum'), 1, 'one album looked up before playing');

		const rest = await (await user.json('/api/tracks', 'POST', { source: 'artist', id: 'ar0', part: 'rest' })).json();
		assert.deepEqual(rest.songs.map((song) => song.id), ['s0a', 's0b']);
		assert.equal(rest.more, undefined);
		assert.equal(subsonic.calls.get('getAlbum'), 2);

		const single = await (await user.json('/api/tracks', 'POST', { source: 'artist', id: 'ar1', part: 'first' })).json();
		assert.equal(single.more, false, 'an artist with one album has no rest');
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
