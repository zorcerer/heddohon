/**
 * Mock music servers for the end-to-end suite.
 *
 * Each one answers the endpoints the app calls with the shapes Navidrome and
 * Jellyfin return, over a library small enough to reason about in a test and
 * large enough to page. Both run in the test process, so a test reads the call
 * counts and changes the state directly rather than over HTTP.
 */
import { createHash } from 'node:crypto';
import http from 'node:http';
import { crc32, deflateSync } from 'node:zlib';

/** Starts a server on a free loopback port and resolves once it listens. */
function listen(handler) {
	const server = http.createServer(handler);
	return new Promise((resolve) => {
		server.listen(0, '127.0.0.1', () => {
			const { port } = server.address();
			resolve({
				url: `http://127.0.0.1:${port}`,
				close: () => new Promise((done) => server.close(() => done()))
			});
		});
	});
}

/** Counts calls per endpoint. `take` reads and resets one counter. */
function counter() {
	const counts = new Map();
	return {
		hit: (name) => counts.set(name, (counts.get(name) ?? 0) + 1),
		get: (name) => counts.get(name) ?? 0,
		reset: () => counts.clear()
	};
}

const PNG = Buffer.from(
	'89504e470d0a1a0a0000000d4948445200000001000000010806000000' +
		'1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082',
	'hex'
);

/** An 8px PNG of one colour, for checks that read the colour of a cover. */
function solidPng([r, g, b]) {
	const chunk = (type, data) => {
		const length = Buffer.alloc(4);
		length.writeUInt32BE(data.length);
		const body = Buffer.concat([Buffer.from(type), data]);
		const crc = Buffer.alloc(4);
		crc.writeUInt32BE(crc32(body));
		return Buffer.concat([length, body, crc]);
	};
	const header = Buffer.alloc(13);
	header.writeUInt32BE(8, 0);
	header.writeUInt32BE(8, 4);
	header[8] = 8; // bit depth
	header[9] = 2; // truecolour
	const row = Buffer.from([0, ...Array(8).fill([r, g, b]).flat()]);
	return Buffer.concat([
		Buffer.from('89504e470d0a1a0a', 'hex'),
		chunk('IHDR', header),
		chunk('IDAT', deflateSync(Buffer.concat(Array(8).fill(row)))),
		chunk('IEND', Buffer.alloc(0))
	]);
}

/**
 * A Subsonic server with `artistCount` artists. Artist `ar{i}` has album
 * `al{i}`, which holds songs `s{i}a` and `s{i}b`; `ar0` has a second album,
 * `al0x`. Songs `s0a` and `s1a` start starred, a day apart; `starred` maps each
 * starred id to the time of its star.
 */
/**
 * Enough genres for the genres page to set its six largest apart from the
 * A to Z (it does past eight). Jazz is left out: a test asks for it and
 * expects the page for a genre the server does not have.
 */
const GENRES = [
	['Rock', 12, 24],
	['Electronic', 9, 80],
	['Hip-Hop', 7, 61],
	['Ambient', 6, 40],
	['Folk', 5, 38],
	['Classical', 4, 52],
	['Soul', 3, 27],
	['Metal', 3, 30],
	['Blues', 2, 16],
	['Pop', 2, 21],
	['Reggae', 1, 9],
	['Soundtrack', 1, 14],
	['Drum & Bass', 1, 8],
	['80s', 1, 11]
].map(([value, albumCount, songCount]) => ({ value, albumCount, songCount }));

export async function startSubsonic({ artistCount = 250 } = {}) {
	const calls = counter();
	const state = {
		username: 'testuser',
		password: 'testpass',
		starred: new Map([
			['s0a', '2026-01-01T00:00:00Z'],
			['s1a', '2026-01-02T00:00:00Z']
		]),
		/** Song ids that answer `getSong` with error 70, as a deleted track does. */
		missing: new Set(),
		/** Milliseconds to hold an endpoint's answer, by method name. */
		delays: new Map(),
		/**
		 * What `stream` answers with, as `{ type, body }`. The default is 1000
		 * bytes no browser can decode, which is all the HTTP suite needs.
		 */
		audio: null,
		/**
		 * Answer `stream` with a 200 from byte 0 whatever `Range` asks for, and
		 * without `Accept-Ranges`, as Navidrome does while a transcode is still
		 * running.
		 */
		ignoreRange: false,
		/** Milliseconds between the first and second half of a `stream` body, to keep a read in progress. */
		streamSlowMs: 0,
		/** Cover ids answered with a solid colour, as `[r, g, b]`, instead of the 1px PNG. */
		coverColors: new Map(),
		/** Songs on each album from `getAlbum`, up to 26: `s1a`, `s1b`, `s1c` and on. */
		albumSongs: 2,
		/**
		 * Navidrome's own API (`/auth/login`, `/api/lastfm/link`,
		 * `/api/listenbrainz/link`). Null makes this a Subsonic server that is not
		 * Navidrome, which answers those paths with 404. Session tokens numbered
		 * below `acceptFrom` are refused, as expired ones are.
		 */
		navidrome: {
			enabled: { lastfm: true, listenbrainz: true },
			linked: { lastfm: false, listenbrainz: false },
			issued: 0,
			acceptFrom: 0,
			linkTokens: new Set(),
			listenBrainzToken: null
		}
	};

	const name = (i) => `Artist ${String(i).padStart(4, '0')}`;
	const song = (i, side) => ({
		id: `s${i}${side}`,
		title: `Song ${i}${side}`,
		album: `Album ${i}`,
		albumId: `al${i}`,
		artist: name(i),
		artistId: `ar${i}`,
		coverArt: `al-${i}`,
		duration: 180,
		track: side.charCodeAt(0) - 96,
		suffix: 'flac',
		bitRate: 900,
		bitDepth: 16,
		samplingRate: 44100,
		size: 20_000_000,
		starred: state.starred.get(`s${i}${side}`)
	});
	const album = (i, id = `al${i}`) => ({
		id,
		name: id === `al${i}` ? `Album ${i}` : `Album ${i} (reissue)`,
		artist: name(i),
		artistId: `ar${i}`,
		coverArt: `al-${i}`,
		songCount: 2,
		duration: 360,
		year: 2000 + (i % 20)
	});
	const artist = (i) => ({ id: `ar${i}`, name: name(i), albumCount: i === 0 ? 2 : 1, coverArt: `ar-${i}` });
	const index = (id) => Number.parseInt(String(id).replace(/^\D+/, ''), 10);

	const ok = (extra) => ({ 'subsonic-response': { status: 'ok', version: '1.16.1', ...extra } });
	const failed = (code, message) => ({
		'subsonic-response': { status: 'failed', version: '1.16.1', error: { code, message } }
	});

	/** The ListenBrainz token the mock treats as valid. */
	const LISTENBRAINZ_TOKEN = '0b6a6f3e-1111-4222-8333-444455556666';

	const native = (req, res, url, body) => {
		const nd = state.navidrome;
		const reply = (status, payload = {}) => {
			res.statusCode = status;
			res.setHeader('content-type', 'application/json');
			res.end(JSON.stringify(payload));
		};
		if (!nd) return reply(404);
		let sent = {};
		try {
			sent = body ? JSON.parse(body) : {};
		} catch {
			return reply(422, { error: 'invalid request payload' });
		}

		if (url.pathname === '/auth/login' && req.method === 'POST') {
			if (sent.username !== state.username || sent.password !== state.password) {
				return reply(401, { error: 'Invalid username or password' });
			}
			nd.issued += 1;
			return reply(200, { id: `u-${state.username}`, username: state.username, token: `nd-${nd.issued}` });
		}
		if (url.pathname === '/api/lastfm/link/callback' && nd.enabled.lastfm) {
			if (!nd.linkTokens.has(url.searchParams.get('uid')) || url.searchParams.get('token') !== 'lastfm-ok') {
				return reply(400, { error: 'invalid link token' });
			}
			nd.linked.lastfm = true;
			return reply(200);
		}

		const bearer = /^Bearer nd-(\d+)$/.exec(req.headers['x-nd-authorization'] ?? '');
		if (!bearer || Number(bearer[1]) < nd.acceptFrom || Number(bearer[1]) > nd.issued) {
			return reply(401, { error: 'Not authenticated' });
		}
		const service = /^\/api\/(lastfm|listenbrainz)\/link$/.exec(url.pathname)?.[1];
		if (!service || !nd.enabled[service]) return reply(404);
		if (req.method === 'GET' && service === 'lastfm') {
			const linkToken = `lt-${nd.linkTokens.size + 1}`;
			nd.linkTokens.add(linkToken);
			return reply(200, { status: nd.linked.lastfm, apiKey: 'mock-lastfm-key', linkToken });
		}
		if (req.method === 'GET') return reply(200, { status: nd.linked.listenbrainz });
		if (req.method === 'DELETE') {
			nd.linked[service] = false;
			return reply(200);
		}
		if (req.method === 'PUT' && service === 'listenbrainz') {
			if (sent.token !== LISTENBRAINZ_TOKEN) return reply(400, { error: 'Invalid token' });
			nd.linked.listenbrainz = true;
			nd.listenBrainzToken = sent.token;
			return reply(200, { status: true, user: 'lbuser' });
		}
		return reply(405);
	};

	const respond = (req, res) => {
		const url = new URL(req.url, 'http://mock');
		const method = url.pathname.replace(/^\/rest\//, '').replace(/\.view$/, '');
		const p = url.searchParams;
		const send = (body) => {
			res.setHeader('content-type', 'application/json');
			res.end(JSON.stringify(body));
		};

		const expected = createHash('md5').update(state.password + p.get('s')).digest('hex');
		if (p.get('u') !== state.username || p.get('t') !== expected) return send(failed(40, 'Wrong username or password'));

		switch (method) {
			case 'ping':
				return send(ok({}));
			case 'getArtists': {
				const letters = new Map();
				for (let i = 0; i < artistCount; i++) {
					const key = name(i)[0];
					if (!letters.has(key)) letters.set(key, []);
					letters.get(key).push(artist(i));
				}
				return send(ok({ artists: { index: [...letters].map(([key, list]) => ({ name: key, artist: list })) } }));
			}
			case 'getArtist': {
				const i = index(p.get('id'));
				if (!(i >= 0 && i < artistCount)) return send(failed(70, 'Artist not found'));
				const albums = i === 0 ? [album(0), album(0, 'al0x')] : [album(i)];
				return send(ok({ artist: { ...artist(i), album: albums } }));
			}
			// Artist 0 has the whole artist page: a biography, related artists and
			// most played tracks. The others have none of it.
			case 'getArtistInfo2':
				if (p.get('id') !== 'ar0') return send(ok({ artistInfo2: {} }));
				return send(
					ok({
						artistInfo2: {
							biography: 'Artist 0000 is a mock artist. '.repeat(12).trim(),
							similarArtist: [1, 2, 3, 4, 5, 6].map((i) => artist(i))
						}
					})
				);
			case 'getTopSongs':
				if (p.get('artist') !== name(0)) return send(ok({ topSongs: {} }));
				return send(ok({ topSongs: { song: [song(0, 'a'), song(0, 'b'), song(1, 'a'), song(2, 'a')] } }));
			case 'getAlbum': {
				const id = p.get('id') ?? '';
				const i = index(id);
				if (!(i >= 0 && i < artistCount)) return send(failed(70, 'Album not found'));
				const songs = Array.from({ length: state.albumSongs }, (_, k) => song(i, String.fromCharCode(97 + k)));
				return send(ok({ album: { ...album(i, id), song: songs } }));
			}
			case 'getSong': {
				const id = p.get('id') ?? '';
				const i = index(id);
				if (state.missing.has(id) || !(i >= 0 && i < artistCount)) return send(failed(70, 'Song not found'));
				return send(ok({ song: song(i, id.endsWith('b') ? 'b' : 'a') }));
			}
			case 'getStarred2': {
				const songs = [...state.starred.keys()].map((id) => song(index(id), id.endsWith('b') ? 'b' : 'a'));
				return send(ok({ starred2: { song: songs, album: [], artist: [] } }));
			}
			case 'star':
				for (const id of p.getAll('id')) state.starred.set(id, new Date().toISOString());
				return send(ok({}));
			case 'unstar':
				for (const id of p.getAll('id')) state.starred.delete(id);
				return send(ok({}));
			case 'getAlbumList2':
				return send(ok({ albumList2: { album: Array.from({ length: Math.min(12, artistCount) }, (_, i) => album(i)) } }));
			case 'getGenres':
				return send(ok({ genres: { genre: GENRES } }));
			case 'getPlaylists':
				return send(ok({ playlists: { playlist: [{ id: 'pl1', name: 'Mock Playlist', songCount: 2, duration: 360, owner: state.username }] } }));
			case 'getPlaylist':
				if (p.get('id') !== 'pl1') return send(failed(70, 'Playlist not found'));
				return send(
					ok({
						playlist: { id: 'pl1', name: 'Mock Playlist', songCount: 2, duration: 360, owner: state.username, entry: [song(1, 'a'), song(2, 'a')] }
					})
				);
			case 'getRandomSongs':
				return send(ok({ randomSongs: { song: [song(1, 'a'), song(2, 'a')] } }));
			case 'getUser':
				return send(ok({ user: { username: state.username, adminRole: true } }));
			case 'getCoverArt': {
				const id = p.get('id');
				if (id === 'html') {
					res.setHeader('content-type', 'text/html');
					return res.end('<script>parent.stolen = document.cookie</script>');
				}
				res.setHeader('content-type', 'image/png');
				return res.end(state.coverColors.has(id) ? solidPng(state.coverColors.get(id)) : PNG);
			}
			case 'stream': {
				const body = state.audio?.body ?? Buffer.alloc(1000, 7);
				const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
				res.setHeader('content-type', state.audio?.type ?? 'audio/flac');
				if (state.ignoreRange) {
					res.setHeader('content-length', body.length);
					if (state.streamSlowMs > 0) {
						const half = Math.floor(body.length / 2);
						res.write(body.subarray(0, half));
						return setTimeout(() => res.end(body.subarray(half)), state.streamSlowMs);
					}
					return res.end(body);
				}
				res.setHeader('accept-ranges', 'bytes');
				if (!range) return res.end(body);
				const start = Number(range[1]);
				const end = range[2] ? Number(range[2]) : body.length - 1;
				res.statusCode = 206;
				res.setHeader('content-range', `bytes ${start}-${end}/${body.length}`);
				return res.end(body.subarray(start, end + 1));
			}
			default:
				return send(ok({}));
		}
	};

	const server = await listen((req, res) => {
		const method = new URL(req.url, 'http://mock').pathname.replace(/^\/rest\//, '').replace(/\.view$/, '');
		calls.hit(method);
		const url = new URL(req.url, 'http://mock');
		if (!url.pathname.startsWith('/rest/')) {
			let body = '';
			req.on('data', (chunk) => (body += chunk));
			req.on('end', () => native(req, res, url, body));
			return;
		}
		const delay = state.delays.get(method) ?? 0;
		if (delay > 0) setTimeout(() => respond(req, res), delay);
		else respond(req, res);
	});

	return { ...server, calls, state, LISTENBRAINZ_TOKEN };
}

/**
 * A Jellyfin server with three album artists and two artists that only appear
 * on tracks. `Artist B` is album artist of two albums.
 */
export async function startJellyfin() {
	const calls = counter();
	const artists = [
		{ Id: 'a1', Name: 'Artist A', Type: 'MusicArtist', ImageTags: {} },
		{ Id: 'a2', Name: 'Artist B', Type: 'MusicArtist', ImageTags: {} },
		{ Id: 'g1', Name: 'Guest Singer', Type: 'MusicArtist', ImageTags: {} },
		{ Id: 'a3', Name: 'Various Artists', Type: 'MusicArtist', ImageTags: {} },
		{ Id: 'g2', Name: 'Compilation Track Artist', Type: 'MusicArtist', ImageTags: {} }
	];
	const albums = [
		{ Id: 'b1', Name: 'First', Type: 'MusicAlbum', AlbumArtists: [{ Id: 'a1', Name: 'Artist A' }] },
		{ Id: 'b2', Name: 'Second', Type: 'MusicAlbum', AlbumArtists: [{ Id: 'a2', Name: 'Artist B' }] },
		{ Id: 'b3', Name: 'Third', Type: 'MusicAlbum', AlbumArtists: [{ Id: 'a2', Name: 'Artist B' }] },
		{ Id: 'b4', Name: 'Compilation', Type: 'MusicAlbum', AlbumArtists: [{ Id: 'a3', Name: 'Various Artists' }] }
	];

	const server = await listen((req, res) => {
		const url = new URL(req.url, 'http://mock');
		const send = (body, status = 200) => {
			res.statusCode = status;
			res.setHeader('content-type', 'application/json');
			res.end(JSON.stringify(body));
		};
		const types = url.searchParams.get('IncludeItemTypes') ?? url.searchParams.get('includeItemTypes');
		calls.hit(`${req.method} ${url.pathname}${types ? ` ${types}` : ''}`);

		if (req.method === 'POST' && url.pathname === '/Users/AuthenticateByName') {
			let raw = '';
			req.on('data', (chunk) => (raw += chunk));
			req.on('end', () => {
				const body = JSON.parse(raw || '{}');
				if (body.Username !== 'jfuser' || body.Pw !== 'jfpass') return send({}, 401);
				send({ AccessToken: 'jf-token', User: { Id: 'u1', Name: 'jfuser' } });
			});
			return;
		}
		if (url.pathname === '/QuickConnect/Enabled') return send(false);
		if (url.pathname === '/Users/u1') return send({ Id: 'u1', Name: 'jfuser', Policy: { IsAdministrator: false } });
		if (url.pathname === '/Items' && types === 'MusicArtist') return send({ Items: artists });
		if (url.pathname === '/Items' && types === 'MusicAlbum') return send({ Items: albums });
		if (url.pathname === '/Items') return send({ Items: [] });
		return send({}, 404);
	});

	return { ...server, calls };
}
