// A mock Subsonic (Navidrome) server for the end-to-end suite.
//
// Answers `/rest/*.view` with the JSON envelope Navidrome returns. Accounts,
// the library and the hostile items are fixed below. `/__stats`, `/__reset`
// and `/__password` are for the suite: how many sign-in checks arrived, a clean
// slate, and a password change.
//
//   node tests/mocks/subsonic.mjs [port]      (default 4533)

import { createServer } from 'node:http';
import { createHash } from 'node:crypto';

const PORT = Number(process.argv[2] ?? process.env.SUBSONIC_PORT ?? 4533);

const USERS = {
	testuser: { password: 'testpass', admin: true },
	other: { password: 'otherpass', admin: false },
	alice: { password: 'subsonic-alice', admin: false },
	carol: { password: 'subsonic-carol', admin: false },
	dave: { password: 'dave-first', admin: false }
};

/**
 * The account a request names, or undefined. `Object.hasOwn`, not a bare
 * index: `USERS["__proto__"]` is `Object.prototype`, and `/__password` would
 * then have written a `password` onto every object in the process.
 */
function userNamed(name) {
	return Object.hasOwn(USERS, name) ? USERS[name] : undefined;
}

// 250 albums of one track each, so album and artist listings need three pages
// at 100 per page. Artists mirror the albums.
const ALBUMS = Array.from({ length: 250 }, (_, i) => ({
	id: `al${i + 1}`,
	name: `Album ${String(i + 1).padStart(3, '0')}`,
	artist: `Artist ${String(i + 1).padStart(3, '0')}`,
	artistId: `ar${i + 1}`,
	coverArt: `al${i + 1}`,
	songCount: 1,
	duration: 180,
	year: 2000 + (i % 25),
	created: new Date(Date.UTC(2020, 0, 1) + i * 86_400_000).toISOString()
}));

function songFor(album, index) {
	return {
		id: `s${index + 1}`,
		title: `Song ${index + 1}`,
		album: album.name,
		albumId: album.id,
		artist: album.artist,
		artistId: album.artistId,
		coverArt: album.coverArt,
		duration: 180,
		track: 1,
		year: album.year,
		suffix: 'flac',
		bitRate: 900,
		bitDepth: 16,
		samplingRate: 44100,
		size: 65536
	};
}

const SONGS = new Map(ALBUMS.map((album, index) => [`s${index + 1}`, songFor(album, index)]));

// Hostile library entries. Titles carry markup, covers lie about their type,
// and two tracks redirect: one within this server, one away from it.
SONGS.set('evil', {
	...songFor(ALBUMS[0], 0),
	id: 'evil',
	title: '<script>alert(1)</script><img src=x onerror=alert(2)>',
	artist: '"><svg onload=alert(3)>',
	coverArt: 'evilhtml'
});
SONGS.set('evilmulti', { ...songFor(ALBUMS[0], 0), id: 'evilmulti', coverArt: 'evilmulti' });
SONGS.set('evilsvg', { ...songFor(ALBUMS[0], 0), id: 'evilsvg', coverArt: 'evilsvg' });
SONGS.set('htmlaudio', { ...songFor(ALBUMS[0], 0), id: 'htmlaudio' });
SONGS.set('redirin', { ...songFor(ALBUMS[0], 0), id: 'redirin' });
SONGS.set('redirout', { ...songFor(ALBUMS[0], 0), id: 'redirout' });

const AUDIO = Buffer.alloc(65536, 0x61);
// A 1x1 PNG.
const PNG = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
	'base64'
);

const playlists = new Map();
let nextPlaylist = 1;
const stats = { pings: 0, requests: 0, queries: [] };

function reset() {
	playlists.clear();
	nextPlaylist = 1;
	stats.pings = 0;
	stats.requests = 0;
	stats.queries = [];
}

function envelope(body = {}) {
	return { 'subsonic-response': { status: 'ok', version: '1.16.1', ...body } };
}

function failure(code, message) {
	return { 'subsonic-response': { status: 'failed', version: '1.16.1', error: { code, message } } };
}

function sendJson(res, payload, status = 200) {
	const text = JSON.stringify(payload);
	res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
	res.end(text);
}

function authenticate(params) {
	const user = userNamed(params.get('u') ?? '');
	if (!user) return null;
	const salt = params.get('s') ?? '';
	const token = params.get('t') ?? '';
	const expected = createHash('md5').update(user.password + salt).digest('hex');
	if (params.get('p') !== null) return null;
	return token === expected ? params.get('u') : null;
}

function sendRanged(req, res, body, type) {
	const range = req.headers.range;
	const match = range && /^bytes=(\d*)-(\d*)$/.exec(range);
	if (match) {
		const start = match[1] ? Number(match[1]) : 0;
		const end = match[2] ? Math.min(Number(match[2]), body.length - 1) : body.length - 1;
		res.writeHead(206, {
			'content-type': type,
			'content-length': end - start + 1,
			'content-range': `bytes ${start}-${end}/${body.length}`,
			'accept-ranges': 'bytes'
		});
		res.end(req.method === 'HEAD' ? undefined : body.subarray(start, end + 1));
		return;
	}
	res.writeHead(200, {
		'content-type': type,
		'content-length': body.length,
		'accept-ranges': 'bytes',
		etag: '"mock-etag"',
		// Headers that must not be relayed to the browser.
		'set-cookie': 'upstream=1; Path=/',
		'access-control-allow-origin': '*',
		'content-disposition': 'attachment; filename="evil.html"'
	});
	res.end(req.method === 'HEAD' ? undefined : body);
}

const server = createServer((req, res) => {
	const url = new URL(req.url, `http://${req.headers.host}`);

	if (url.pathname === '/__reset') {
		reset();
		return sendJson(res, { ok: true });
	}
	if (url.pathname === '/__stats') return sendJson(res, stats);
	// Sets a user's password, as a password change or a name given to someone
	// else does. Navidrome reports no user id, so the two look the same.
	if (url.pathname === '/__password') {
		const user = userNamed(url.searchParams.get('name') ?? '');
		if (user) user.password = url.searchParams.get('password') ?? '';
		return sendJson(res, { ok: Boolean(user) });
	}

	const match = /^\/rest\/([A-Za-z0-9]+)(\.view)?$/.exec(url.pathname);
	if (!match) {
		res.writeHead(404, { 'content-type': 'text/plain' });
		return res.end('not found');
	}
	const method = match[1];
	const params = url.searchParams;
	stats.requests++;
	stats.queries.push(url.search);
	if (stats.queries.length > 200) stats.queries.shift();

	if (method === 'ping') stats.pings++;
	const user = authenticate(params);
	// Navidrome answers a bad credential with its envelope and HTTP 200, on
	// stream.view as on everything else.
	if (!user) return sendJson(res, failure(40, 'Wrong username or password'));

	const id = params.get('id') ?? '';

	switch (method) {
		case 'ping':
			return sendJson(res, envelope());
		case 'getUser':
			return sendJson(res, envelope({ user: { username: user, adminRole: USERS[user].admin } }));
		case 'getAlbumList2': {
			const size = Number(params.get('size') ?? 10);
			const offset = Number(params.get('offset') ?? 0);
			return sendJson(res, envelope({ albumList2: { album: ALBUMS.slice(offset, offset + size) } }));
		}
		case 'getAlbum': {
			const album = ALBUMS.find((entry) => entry.id === id);
			if (!album) return sendJson(res, failure(70, 'Album not found'));
			const index = ALBUMS.indexOf(album);
			return sendJson(res, envelope({ album: { ...album, song: [songFor(album, index)] } }));
		}
		case 'getArtists':
			return sendJson(
				res,
				envelope({
					artists: {
						index: [
							{
								name: 'A',
								artist: ALBUMS.map((album) => ({ id: album.artistId, name: album.artist, albumCount: 1 }))
							}
						]
					}
				})
			);
		case 'getArtist': {
			const album = ALBUMS.find((entry) => entry.artistId === id);
			if (!album) return sendJson(res, failure(70, 'Artist not found'));
			return sendJson(res, envelope({ artist: { id, name: album.artist, albumCount: 1, album: [album] } }));
		}
		case 'getArtistInfo2':
			return sendJson(res, envelope({ artistInfo2: { biography: 'A biography.', similarArtist: [] } }));
		case 'getTopSongs':
			return sendJson(res, envelope({ topSongs: { song: [] } }));
		case 'getSimilarSongs2':
			return sendJson(res, envelope({ similarSongs2: { song: [] } }));
		case 'getSong': {
			const song = SONGS.get(id);
			if (!song) return sendJson(res, failure(70, 'Song not found'));
			return sendJson(res, envelope({ song }));
		}
		case 'getRandomSongs':
			return sendJson(res, envelope({ randomSongs: { song: [...SONGS.values()].slice(0, 10) } }));
		case 'getStarred2':
			return sendJson(res, envelope({ starred2: { song: [], album: [], artist: [] } }));
		case 'getGenres':
			return sendJson(res, envelope({ genres: { genre: [{ value: 'Rock', songCount: 1, albumCount: 1 }] } }));
		case 'search3':
			return sendJson(res, envelope({ searchResult3: { song: [SONGS.get('evil')], album: [], artist: [] } }));
		case 'star':
		case 'unstar':
		case 'scrobble':
			return sendJson(res, envelope());
		case 'getLyricsBySongId':
			return sendJson(
				res,
				envelope({
					lyricsList: {
						structuredLyrics: [
							{ synced: true, line: [{ start: 0, value: 'First line' }, { start: 1000, value: '<b>second</b>' }] }
						]
					}
				})
			);
		case 'getLyrics':
			return sendJson(res, envelope({ lyrics: {} }));
		case 'getPlaylists':
			return sendJson(
				res,
				envelope({
					playlists: {
						playlist: [...playlists.values()]
							.filter((entry) => entry.owner === user)
							.map(({ entry, ...rest }) => ({ ...rest, songCount: entry.length }))
					}
				})
			);
		case 'getPlaylist': {
			const playlist = playlists.get(id);
			if (!playlist || playlist.owner !== user) return sendJson(res, failure(70, 'Playlist not found'));
			return sendJson(res, envelope({ playlist: { ...playlist, entry: playlist.entry.map((sid) => SONGS.get(sid)) } }));
		}
		case 'createPlaylist': {
			const pid = `pl${nextPlaylist++}`;
			const playlist = {
				id: pid,
				name: params.get('name') ?? '',
				owner: user,
				public: false,
				created: new Date().toISOString(),
				changed: new Date().toISOString(),
				entry: params.getAll('songId')
			};
			playlists.set(pid, playlist);
			const { entry, ...rest } = playlist;
			return sendJson(res, envelope({ playlist: { ...rest, songCount: entry.length } }));
		}
		case 'updatePlaylist': {
			const playlist = playlists.get(params.get('playlistId') ?? '');
			if (!playlist || playlist.owner !== user) return sendJson(res, failure(70, 'Playlist not found'));
			if (params.get('name')) playlist.name = params.get('name');
			const remove = new Set(params.getAll('songIndexToRemove').map(Number));
			playlist.entry = playlist.entry.filter((_, index) => !remove.has(index));
			playlist.entry.push(...params.getAll('songIdToAdd'));
			return sendJson(res, envelope());
		}
		case 'deletePlaylist': {
			const playlist = playlists.get(id);
			if (!playlist || playlist.owner !== user) return sendJson(res, failure(70, 'Playlist not found'));
			playlists.delete(id);
			return sendJson(res, envelope());
		}
		case 'getCoverArt': {
			if (id === 'evilhtml') {
				res.writeHead(200, { 'content-type': 'text/html' });
				return res.end('<script>document.title="pwned"</script>');
			}
			if (id === 'evilmulti') {
				res.writeHead(200, [
					['content-type', 'image/png'],
					['content-type', 'text/html']
				]);
				return res.end('<script>document.title="pwned"</script>');
			}
			if (id === 'evilsvg') {
				res.writeHead(200, { 'content-type': 'image/svg+xml' });
				return res.end('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
			}
			if (id === 'big') {
				res.writeHead(200, { 'content-type': 'image/png' });
				return res.end(Buffer.alloc(9 * 1024 * 1024, 1));
			}
			return sendRanged(req, res, PNG, 'image/png');
		}
		case 'stream':
		case 'download': {
			if (id === 'htmlaudio') {
				res.writeHead(200, { 'content-type': 'text/html' });
				return res.end('<script>document.title="pwned"</script>');
			}
			if (id === 'redirin') {
				const next = new URL(url);
				next.searchParams.set('id', 's1');
				res.writeHead(302, { location: next.pathname + next.search });
				return res.end();
			}
			if (id === 'redirout') {
				// Another port is another origin.
				res.writeHead(302, { location: 'http://127.0.0.1:1/internal' });
				return res.end();
			}
			if (!SONGS.has(id)) return sendJson(res, failure(70, 'Song not found'));
			return sendRanged(req, res, AUDIO, 'audio/flac');
		}
		default:
			return sendJson(res, failure(0, `Unknown method ${method}`));
	}
});

server.listen(PORT, '127.0.0.1', () => {
	console.log(`mock subsonic on http://127.0.0.1:${PORT}`);
});
