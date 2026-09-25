// A mock Jellyfin server for the end-to-end suite.
//
// Covers the calls the Jellyfin adapter makes: password sign-in, item and
// playlist listings, audio, images and deletes. Tokens are per sign-in and
// checked on every call. `/__recreate` deletes a user and creates a new one
// under the same name, the way an administrator reuses a name; the old user's
// tokens stop working, as they do in Jellyfin.
//
//   node tests/mocks/jellyfin.mjs [port]      (default 8096)

import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

const PORT = Number(process.argv[2] ?? process.env.JELLYFIN_PORT ?? 8096);

function freshUsers() {
	return new Map([
		['testuser', { id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', password: 'testpass', admin: true }],
		['other', { id: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', password: 'otherpass', admin: false }],
		['alice', { id: 'cccccccccccccccccccccccccccccccc', password: 'jellyfin-alice', admin: false }],
		['bob', { id: 'dddddddddddddddddddddddddddddddd', password: 'bob-first', admin: false }],
		['carol', { id: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', password: 'jellyfin-carol', admin: false }]
	]);
}

let users = freshUsers();
/** token -> user id */
let tokens = new Map();
const playlists = new Map();
const deleted = [];

// `j9` is in a library only `testuser` may see.
const SONGS = Array.from({ length: 9 }, (_, i) => ({
	Id: `j${i + 1}`,
	Name: `Jelly song ${i + 1}`,
	Type: 'Audio',
	AlbumId: 'jal1',
	Album: 'Jelly album',
	AlbumArtist: 'Jelly artist',
	ArtistItems: [{ Id: 'jar1', Name: 'Jelly artist' }],
	RunTimeTicks: 1_800_000_000,
	ImageTags: { Primary: `tag${i + 1}` },
	MediaSources: [{ Container: 'flac', Size: 65536, MediaStreams: [{ Type: 'Audio', Codec: 'flac' }] }]
}));
const RESTRICTED = new Set(['j9']);
const ALBUM = { Id: 'jal1', Name: 'Jelly album', Type: 'MusicAlbum', AlbumArtist: 'Jelly artist', ChildCount: 9 };
const MOVIE = { Id: 'jmovie', Name: 'A film', Type: 'Movie' };

const AUDIO = Buffer.alloc(65536, 0x62);
const PNG = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
	'base64'
);

function sendJson(res, payload, status = 200) {
	const text = JSON.stringify(payload);
	res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
	res.end(text);
}

function readBody(req) {
	return new Promise((resolve) => {
		const chunks = [];
		req.on('data', (chunk) => chunks.push(chunk));
		req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
	});
}

function tokenOf(req) {
	const header = req.headers.authorization ?? req.headers['x-emby-authorization'] ?? '';
	const match = /Token="([^"]*)"/.exec(header);
	return match ? match[1] : null;
}

function userById(id) {
	for (const [name, user] of users) if (user.id === id) return { name, ...user };
	return null;
}

function visible(userId, item) {
	if (!RESTRICTED.has(item.Id)) return true;
	return userId === users.get('testuser').id;
}

function itemById(userId, id) {
	const song = SONGS.find((entry) => entry.Id === id);
	if (song) return visible(userId, song) ? song : null;
	if (id === ALBUM.Id) return ALBUM;
	if (id === MOVIE.Id) return MOVIE;
	const playlist = playlists.get(id);
	if (playlist && playlist.owner === userId) return { Id: id, Name: playlist.name, Type: 'Playlist', ChildCount: playlist.items.length };
	return null;
}

const server = createServer(async (req, res) => {
	const url = new URL(req.url, `http://${req.headers.host}`);
	const path = url.pathname;
	const q = url.searchParams;

	if (path === '/__reset') {
		users = freshUsers();
		tokens = new Map();
		playlists.clear();
		deleted.length = 0;
		return sendJson(res, { ok: true });
	}
	if (path === '/__recreate') {
		const name = (q.get('name') ?? '').toLowerCase();
		const old = users.get(name);
		if (old) for (const [token, id] of tokens) if (id === old.id) tokens.delete(token);
		users.set(name, { id: randomUUID().replace(/-/g, ''), password: q.get('password') ?? 'changed', admin: false });
		return sendJson(res, { ok: true, id: users.get(name).id });
	}
	if (path === '/__deleted') return sendJson(res, deleted);

	if (path === '/QuickConnect/Enabled') return sendJson(res, false);

	if (path === '/Users/AuthenticateByName' && req.method === 'POST') {
		let body;
		try {
			body = JSON.parse(await readBody(req));
		} catch {
			return sendJson(res, { error: 'bad body' }, 400);
		}
		const name = String(body.Username ?? '').toLowerCase();
		const user = users.get(name);
		if (!user || user.password !== body.Pw) {
			res.writeHead(401);
			return res.end();
		}
		const token = randomUUID().replace(/-/g, '');
		tokens.set(token, user.id);
		return sendJson(res, { AccessToken: token, User: { Id: user.id, Name: name } });
	}

	const token = tokenOf(req);
	const userId = token ? tokens.get(token) : undefined;
	if (!userId) {
		res.writeHead(401);
		return res.end();
	}

	let m;
	if ((m = /^\/Users\/([^/]+)$/.exec(path))) {
		const user = userById(decodeURIComponent(m[1]));
		if (!user || user.id !== userId) return sendJson(res, {}, 404);
		return sendJson(res, { Id: user.id, Name: user.name, Policy: { IsAdministrator: user.admin } });
	}

	if (path === '/Items' && req.method === 'GET') {
		const types = q.get('IncludeItemTypes');
		const ids = q.get('Ids');
		let items;
		if (ids) {
			items = ids
				.split(',')
				.map((id) => itemById(userId, id))
				.filter(Boolean);
		} else if (types === 'MusicAlbum') {
			items = [ALBUM];
		} else if (types === 'Playlist') {
			items = [...playlists.entries()]
				.filter(([, entry]) => entry.owner === userId)
				.map(([id, entry]) => ({ Id: id, Name: entry.name, Type: 'Playlist', ChildCount: entry.items.length }));
		} else {
			items = SONGS.filter((song) => visible(userId, song));
		}
		return sendJson(res, { Items: items, TotalRecordCount: items.length });
	}

	if ((m = /^\/Items\/([^/]+)$/.exec(path))) {
		const id = decodeURIComponent(m[1]);
		const item = itemById(userId, id);
		if (!item) return sendJson(res, {}, 404);
		if (req.method === 'DELETE') {
			deleted.push(id);
			playlists.delete(id);
			res.writeHead(204);
			return res.end();
		}
		return sendJson(res, item);
	}

	if ((m = /^\/Items\/([^/]+)\/Images\/Primary$/.exec(path))) {
		const item = itemById(userId, decodeURIComponent(m[1]));
		if (!item) return sendJson(res, {}, 404);
		res.writeHead(200, { 'content-type': 'image/png', 'content-length': PNG.length });
		return res.end(req.method === 'HEAD' ? undefined : PNG);
	}

	if ((m = /^\/Audio\/([^/]+)\/(stream|universal)$/.exec(path))) {
		const item = itemById(userId, decodeURIComponent(m[1]));
		if (!item || item.Type !== 'Audio') return sendJson(res, {}, 404);
		res.writeHead(200, { 'content-type': 'audio/flac', 'content-length': AUDIO.length, 'accept-ranges': 'bytes' });
		return res.end(req.method === 'HEAD' ? undefined : AUDIO);
	}

	if ((m = /^\/Audio\/([^/]+)\/Lyrics$/.exec(path))) return sendJson(res, {}, 404);

	if (path === '/Playlists' && req.method === 'POST') {
		const body = JSON.parse((await readBody(req)) || '{}');
		const id = randomUUID().replace(/-/g, '');
		playlists.set(id, { owner: userId, name: body.Name, items: body.Ids ?? [] });
		return sendJson(res, { Id: id });
	}

	if ((m = /^\/Playlists\/([^/]+)\/Items$/.exec(path))) {
		const playlist = playlists.get(decodeURIComponent(m[1]));
		if (!playlist || playlist.owner !== userId) return sendJson(res, {}, 404);
		if (req.method === 'GET') {
			return sendJson(res, {
				Items: playlist.items.map((id, index) => ({ ...itemById(userId, id), PlaylistItemId: `${id}#${index}` }))
			});
		}
		if (req.method === 'POST') playlist.items.push(...(q.get('ids') ?? '').split(',').filter(Boolean));
		if (req.method === 'DELETE') {
			const remove = new Set((q.get('entryIds') ?? '').split(','));
			playlist.items = playlist.items.filter((id, index) => !remove.has(`${id}#${index}`));
		}
		res.writeHead(204);
		return res.end();
	}

	if ((m = /^\/Playlists\/([^/]+)$/.exec(path)) && req.method === 'POST') {
		const playlist = playlists.get(decodeURIComponent(m[1]));
		if (!playlist || playlist.owner !== userId) return sendJson(res, {}, 404);
		playlist.name = JSON.parse((await readBody(req)) || '{}').Name ?? playlist.name;
		res.writeHead(204);
		return res.end();
	}

	if (path.startsWith('/Sessions/Playing') || path.includes('/FavoriteItems/')) {
		res.writeHead(204);
		return res.end();
	}

	if (path === '/MusicGenres' || path === '/Artists/AlbumArtists' || /\/Similar$/.test(path)) {
		return sendJson(res, { Items: [], TotalRecordCount: 0 });
	}

	sendJson(res, { error: `unhandled ${req.method} ${path}` }, 404);
});

server.listen(PORT, '127.0.0.1', () => {
	console.log(`mock jellyfin on http://127.0.0.1:${PORT}`);
});
