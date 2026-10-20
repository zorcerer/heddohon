/**
 * Profile pages: four albums, a bio, recent listening and top artists, who
 * sees them, and the public link (`profilepage.ts`).
 *
 * Tests run in order and share one app; `testuser` owns the page and
 * `seconduser` looks at it.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { Client, startApp } from './harness.mjs';
import { startJellyfin, startSubsonic } from './mocks.mjs';

let subsonic;
let jellyfin;
let app;
let owner;
let other;
let handle;

const OWNER = { username: 'testuser', password: 'testpass', backend: 'subsonic' };
const OTHER = { username: 'seconduser', password: 'secondpass', backend: 'subsonic' };

before(async () => {
	subsonic = await startSubsonic({ artistCount: 10 });
	jellyfin = await startJellyfin();
	app = await startApp({ subsonicUrl: subsonic.url, jellyfinUrl: jellyfin.url });
	owner = new Client(app.url);
	other = new Client(app.url);
	assert.equal((await owner.signIn(OWNER)).status, 303);
	assert.equal((await other.signIn(OTHER)).status, 303);
});

after(async () => {
	await app?.stop();
	await subsonic?.close();
	await jellyfin?.close();
});

function explain(message) {
	return `${message}\n--- app output ---\n${app.output()}`;
}

const patch = (body) => owner.json('/api/profile/page', 'PATCH', body);

async function withDb(run) {
	const { default: Database } = await import('better-sqlite3');
	const db = new Database(`${app.dataDir}/heddohon.db`);
	try {
		return run(db);
	} finally {
		db.close();
	}
}

test('an account has an empty page of its own, seen by nobody else', async () => {
	const own = await (await owner.request('/api/profile/page')).json();
	handle = own.page.handle;
	assert.match(handle, /^[0-9a-f]{24}$/);
	assert.deepEqual(own.page.favourites, [null, null, null, null]);
	assert.deepEqual(own.settings, { listed: false, recent: false, top: false, linkMadeAt: null });
	assert.equal((await owner.page(`/people/${handle}`)).response.status, 200);
	assert.equal((await other.page(`/people/${handle}`)).response.status, 404);
	assert.equal((await other.request(`/api/people/${handle}/cover/f0`)).status, 404);
});

test('albums are read through the account’s own credential, and only ids are taken', async () => {
	assert.equal((await patch({ albums: ['al1', null] })).status, 400);
	assert.equal((await patch({ albums: [{ id: 'al1', title: 'Forged' }, null, null, null] })).status, 400);
	assert.equal((await patch({ albums: ['al1', 'al1', null, null] })).status, 400);
	const missing = await patch({ albums: ['al1', 'al999', null, null] });
	assert.equal(missing.status, 404);
	assert.equal((await missing.json()).slot, 1);

	const saved = await patch({ albums: ['al3', null, 'al1', null], bio: '  Hello‮\u0007 <b>there</b>\n\n\n\nsecond  line  ', listed: true });
	assert.equal(saved.status, 200, explain('save'));
	const { page } = await saved.json();
	assert.deepEqual(
		page.favourites.map((album) => album && [album.id, album.title, album.artist, album.cover]),
		[['al3', 'Album 3', page.favourites[0].artist, true], null, ['al1', 'Album 1', page.favourites[2].artist, true], null]
	);
	// Direction marks and control characters go; markup stays text; blank lines are one.
	assert.equal(page.bio, 'Hello <b>there</b>\n\nsecond line');
	assert.equal('coverArt' in page.favourites[0], false, 'a cover id reached the browser');
});

test('a listed page is seen by the other accounts, with its covers by place only', async () => {
	const seen = await other.page(`/people/${handle}`);
	assert.equal(seen.response.status, 200);
	assert.match(seen.html, /Album 3/);
	assert.match(seen.html, /Hello &lt;b>there&lt;\/b>/);
	assert.doesNotMatch(seen.html, /<b>there<\/b>/);

	const cover = await other.request(`/api/people/${handle}/cover/f0?size=128`);
	assert.equal(cover.status, 200, explain('cover'));
	assert.match(cover.headers.get('content-type'), /^image\//);
	assert.match(cover.headers.get('content-security-policy') ?? '', /sandbox/);
	for (const slot of ['f1', 'f4', 'f9', 'r0', 'x0', 'al-3', 'f0a']) {
		assert.equal((await other.request(`/api/people/${handle}/cover/${slot}`)).status, 404, slot);
	}

	const people = await other.page('/people');
	assert.match(people.html, new RegExp(`/people/${handle}`));
	assert.equal((await new Client(app.url).request(`/api/people/${handle}/cover/f0`)).status, 401);
});

test('recent listening and top artists are shown only once turned on', async () => {
	const now = Date.now();
	await withDb((db) => {
		const account = db.prepare('SELECT id FROM accounts WHERE username = ?').get('testuser').id;
		const insert = db.prepare(
			'INSERT INTO plays (account_id, song_id, played_at, title, artist, artist_id, album, album_id, cover_art, duration) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
		);
		insert.run(account, 's5a', now - 3000, 'Song', 'Artist Five', 'ar5', 'Album 5', 'al5', 'al-5', 200);
		insert.run(account, 's5b', now - 2000, 'Song', 'Artist Five', 'ar5', 'Album 5', 'al5', 'al-5', 200);
		insert.run(account, 's6a', now - 1000, 'Song', 'Artist Six', 'ar6', 'Album 6', 'al6', 'al-6', 200);
	});
	let page = (await (await owner.request('/api/profile/page')).json()).page;
	assert.equal(page.recent, null);
	assert.equal(page.top, null);
	assert.equal((await other.request(`/api/people/${handle}/cover/r0`)).status, 404);

	page = (await (await patch({ recent: true, top: true })).json()).page;
	assert.deepEqual(page.recent.map((album) => album.id), ['al6', 'al5']);
	assert.deepEqual(page.top, [
		{ id: 'ar5', name: 'Artist Five', plays: 2 },
		{ id: 'ar6', name: 'Artist Six', plays: 1 }
	]);
	assert.equal((await other.request(`/api/people/${handle}/cover/r1`)).status, 200);
});

test('the public link shows the page to anyone, until it is withdrawn or replaced', async () => {
	const made = await owner.json('/api/profile/page', 'POST', {});
	assert.equal(made.status, 200);
	const { url } = await made.json();
	const path = new URL(url).pathname;
	assert.match(path, /^\/p\/hhpr_[A-Za-z0-9_-]{43}$/);

	const visitor = new Client(app.url);
	const shown = await visitor.page(path);
	assert.equal(shown.response.status, 200, explain('public page'));
	assert.match(shown.html, /Album 3/);
	assert.match(shown.html, /noindex/);
	// Nothing leads into the library, and the handle is not on it.
	assert.doesNotMatch(shown.html, /href="\/albums\//);
	assert.doesNotMatch(shown.html, new RegExp(handle));
	assert.equal((await visitor.request(`${path}/cover/f2`)).status, 200);
	assert.equal((await visitor.request(`${path}/cover/f1`)).status, 404);
	assert.equal((await visitor.request(`${path}/avatar`)).status, 404);
	assert.equal((await visitor.page('/p/hhpr_nottherealtokenatall0000000000000000000000')).response.status, 404);

	// The token is a digest in the database.
	const stored = await withDb((db) => db.prepare('SELECT link_digest FROM profile_pages').get());
	assert.ok(!path.includes(stored.link_digest));

	const again = await (await owner.json('/api/profile/page', 'POST', {})).json();
	assert.equal((await visitor.page(path)).response.status, 404, 'the replaced link still works');
	const second = new URL(again.url).pathname;
	assert.equal((await visitor.page(second)).response.status, 200);
	assert.equal((await owner.request('/api/profile/page', { method: 'DELETE' })).status, 200);
	assert.equal((await visitor.page(second)).response.status, 404);
	assert.equal((await visitor.request(`${second}/cover/f0`)).status, 404);
});

test('a changed password takes the page out of sight and withdraws its link', async () => {
	const { url } = await (await owner.json('/api/profile/page', 'POST', {})).json();
	subsonic.state.password = 'newpass';
	try {
		assert.equal((await new Client(app.url).signIn({ ...OWNER, password: 'newpass' })).status, 303);
		assert.equal((await new Client(app.url).page(new URL(url).pathname)).response.status, 404);
		assert.equal((await other.page(`/people/${handle}`)).response.status, 404);
	} finally {
		subsonic.state.password = 'testpass';
	}
});
