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
		/**
		 * The libraries `getMusicFolders` lists. Each holds a folder per artist
		 * (`d-ar{i}`) and one empty folder, `d-empty`, under a top folder
		 * `d-lib`; an artist's folder holds its album's (`d-al{i}`), which
		 * holds the album's two songs and a video. With two, the second holds
		 * only `d-ar2`.
		 */
		musicFolders: [{ id: 1, name: 'Music' }],
		/** Ratings by song or album id, 1 to 5, as `setRating` leaves them. */
		ratings: new Map(),
		/** Synced lyrics by song id, as `[{ start, value }]` in milliseconds, for `getLyricsBySongId`. */
		lyrics: new Map(),
		/**
		 * Last plays by song id, as ISO dates, which `search3` with an empty query
		 * reports in OpenSubsonic's `played`, as Navidrome does.
		 */
		played: new Map(),
		/** Song and album ids that answer `getSong` or `getAlbum` with error 70, as a deleted one does. */
		missing: new Set(),
		/** Milliseconds to hold an endpoint's answer, by method name. */
		delays: new Map(),
		/** Methods answered with headers and the start of a body that never ends. */
		stalled: new Set(),
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
		 * Albums `getSimilarSongs2` answers with, one song from each, taken from
		 * the artists after the one asked about. Zero answers with none, as a
		 * server without an agent does.
		 */
		similarAlbums: 0,
		/** The songs in playlist `pl1`, in order; `createPlaylist` with its id replaces them. */
		playlistEntries: ['s1a', 's2a'],
		/** The last Subsonic call, and whether it came as a form POST. */
		lastRequest: null,
		/** Who `getPlaylist` names as the owner of `pl1`; null for the signed-in user. */
		playlistOwner: null,
		/** Entries of `pl1` counted in `songCount` but left out of the list, as Navidrome does for a missing file. */
		hiddenEntries: 0,
		/** The last request that wrote a playlist, which a verifying read may follow. */
		lastWrite: null,
		/**
		 * Songs `getSimilarSongs` answers with, one from each album after the
		 * seed's (for a song, album or artist id alike). Zero answers with none,
		 * as Navidrome does without an external agent.
		 */
		mixSize: 0,
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
		starred: state.starred.get(`s${i}${side}`),
		userRating: state.ratings.get(`s${i}${side}`)
	});
	const album = (i, id = `al${i}`) => ({
		id,
		name: id === `al${i}` ? `Album ${i}` : `Album ${i} (reissue)`,
		artist: name(i),
		artistId: `ar${i}`,
		coverArt: `al-${i}`,
		songCount: 2,
		duration: 360,
		year: 2000 + (i % 20),
		userRating: state.ratings.get(id),
		// A 2009 edition of a record from 1979, and a date with no year (Navidrome
		// sends 0), which leaves the edition's year.
		...(i === 29 ? { originalReleaseDate: { year: 1979, month: 5, day: 1 } } : {}),
		...(i === 28 ? { originalReleaseDate: { year: 0 } } : {})
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

	const respond = (req, res, form = '') => {
		const url = new URL(req.url, 'http://mock');
		const method = url.pathname.replace(/^\/rest\//, '').replace(/\.view$/, '');
		// A form POST's fields count as parameters, as they do on Navidrome.
		const p = new URLSearchParams(url.search);
		for (const [key, value] of new URLSearchParams(form)) p.append(key, value);
		state.lastRequest = { method, post: req.method === 'POST' };
		if (method === 'createPlaylist' || method === 'updatePlaylist') state.lastWrite = state.lastRequest;
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
			case 'getSimilarSongs': {
				const from = index(p.get('id'));
				const songs = Array.from({ length: state.mixSize }, (_, k) => song((from + k + 1) % artistCount, 'a'));
				return send(ok({ similarSongs: songs.length > 0 ? { song: songs } : {} }));
			}
			case 'getSimilarSongs2': {
				const from = index(p.get('id'));
				const songs = Array.from({ length: state.similarAlbums }, (_, k) => song((from + k + 1) % artistCount, 'a'));
				return send(ok({ similarSongs2: songs.length > 0 ? { song: songs } : {} }));
			}
			// A search for an artist's name: their own track, a track of theirs on
			// the next artist's album as a guest (OpenSubsonic `artists`), and a track
			// that matched on its title alone. Anything else finds nothing.
			case 'search3': {
				// The whole library, a page at a time, as Navidrome answers syncing
				// clients, with `played` on the songs `state.played` holds.
				if (p.get('query') === '') {
					const all = Array.from({ length: artistCount * 2 }, (_, k) => song(k >> 1, k % 2 ? 'b' : 'a'));
					const offset = Number(p.get('songOffset') ?? 0);
					const page = all
						.slice(offset, offset + Number(p.get('songCount') ?? 20))
						.map((entry) => (state.played.has(entry.id) ? { ...entry, played: state.played.get(entry.id) } : entry));
					return send(ok({ searchResult3: page.length > 0 ? { song: page } : {} }));
				}
				const match = /^Artist (\d{4})$/.exec(p.get('query') ?? '');
				if (!match) return send(ok({}));
				const i = Number(match[1]);
				const host = (i + 1) % artistCount;
				const guest = {
					...song(host, 'b'),
					artists: [
						{ id: `ar${host}`, name: name(host) },
						{ id: `ar${i}`, name: name(i) }
					],
					albumArtists: [{ id: `ar${host}`, name: name(host) }],
					displayAlbumArtist: name(host),
					year: 2020
				};
				const own = { ...song(i, 'a'), albumArtists: [{ id: `ar${i}`, name: name(i) }] };
				return send(ok({ searchResult3: { song: [own, guest, song((i + 2) % artistCount, 'a')] } }));
			}
			case 'getTopSongs':
				if (p.get('artist') !== name(0)) return send(ok({ topSongs: {} }));
				return send(ok({ topSongs: { song: [song(0, 'a'), song(0, 'b'), song(1, 'a'), song(2, 'a')] } }));
			case 'getAlbum': {
				const id = p.get('id') ?? '';
				// An internal failure, worded as Navidrome words one.
				if (id === 'broken') return send(failed(0, 'open /var/lib/navidrome/navidrome.db: database is locked'));
				const i = index(id);
				if (state.missing.has(id) || !(i >= 0 && i < artistCount)) return send(failed(70, 'Album not found'));
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
			case 'getLyricsBySongId': {
				const lines = state.lyrics.get(p.get('id'));
				return send(ok({ lyricsList: lines ? { structuredLyrics: [{ synced: true, line: lines }] } : {} }));
			}
			case 'getMusicFolders':
				return send(ok({ musicFolders: { musicFolder: state.musicFolders } }));
			case 'getIndexes': {
				const artists =
					p.get('musicFolderId') === '2'
						? [2]
						: Array.from({ length: Math.min(12, artistCount) }, (_, i) => i).filter(
								(i) => state.musicFolders.length < 2 || i !== 2
							);
				const entries = [...artists.map((i) => ({ id: `d-ar${i}`, name: name(i) })), { id: 'd-empty', name: 'Empty' }];
				return send(ok({ indexes: { index: [{ name: 'A', artist: entries }] } }));
			}
			// As Navidrome 0.55 and later answer it: the folders on disk, each
			// naming the one above it, up to the library's own top folder.
			case 'getMusicDirectory': {
				const id = p.get('id') ?? '';
				if (id === 'd-lib') {
					const tops = Array.from({ length: Math.min(12, artistCount) }, (_, i) => ({ id: `d-ar${i}`, isDir: true, title: name(i), parent: 'd-lib' }));
					return send(ok({ directory: { id, name: 'Music', child: tops } }));
				}
				if (id === 'd-empty') return send(ok({ directory: { id, name: 'Empty', parent: 'd-lib' } }));
				const folder = /^d-(ar|al)(\d+)$/.exec(id);
				const i = folder ? Number(folder[2]) : -1;
				if (!folder || i >= artistCount) return send(failed(70, 'Directory not found'));
				if (folder[1] === 'ar') {
					const child = [{ id: `d-al${i}`, isDir: true, title: `Album ${i}`, coverArt: `al-${i}`, parent: id }];
					return send(ok({ directory: { id, name: name(i), parent: 'd-lib', child } }));
				}
				const child = [
					{ ...song(i, 'a'), isDir: false, parent: id },
					{ ...song(i, 'b'), isDir: false, parent: id },
					{ id: `v${i}`, isDir: false, isVideo: true, title: 'A video', parent: id }
				];
				return send(ok({ directory: { id, name: `Album ${i}`, parent: `d-ar${i}`, child } }));
			}
			// 0 removes the rating, as Navidrome does; anything outside 0 to 5 is refused.
			case 'setRating': {
				const rating = Number(p.get('rating'));
				if (!Number.isInteger(rating) || rating < 0 || rating > 5) return send(failed(10, 'Invalid rating'));
				if (rating === 0) state.ratings.delete(p.get('id'));
				else state.ratings.set(p.get('id'), rating);
				return send(ok({}));
			}
			case 'getAlbumList2':
				return send(ok({ albumList2: { album: Array.from({ length: Math.min(12, artistCount) }, (_, i) => album(i)) } }));
			case 'getGenres':
				return send(ok({ genres: { genre: GENRES } }));
			case 'getPlaylists':
				return send(ok({ playlists: { playlist: [{ id: 'pl1', name: 'Mock Playlist', songCount: 2, duration: 360, owner: state.username }] } }));
			case 'getPlaylist': {
				if (p.get('id') !== 'pl1') return send(failed(70, 'Playlist not found'));
				const entry = state.playlistEntries.map((id) => song(index(id), id.slice(-1)));
				return send(
					ok({
						playlist: {
							id: 'pl1',
							name: 'Mock Playlist',
							songCount: entry.length + state.hiddenEntries,
							duration: 180 * entry.length,
							owner: state.playlistOwner ?? state.username,
							entry
						}
					})
				);
			}
			// With a `playlistId`, the playlist's entries replaced by the `songId`s
			// given, in their order, as Navidrome does.
			case 'createPlaylist': {
				if (p.get('playlistId') !== 'pl1') return send(failed(70, 'Playlist not found'));
				state.playlistEntries = p.getAll('songId');
				return send(ok({}));
			}
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
		let form = '';
		req.on('data', (chunk) => (form += chunk));
		req.on('end', () => {
			if (state.stalled.has(method)) {
				res.writeHead(200, { 'content-type': 'application/json' });
				res.write('{"subsonic-response":');
				return;
			}
			const delay = state.delays.get(method) ?? 0;
			if (delay > 0) setTimeout(() => respond(req, res, form), delay);
			else respond(req, res, form);
		});
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
		{ Id: 'b1', Name: 'First', Type: 'MusicAlbum', IsFolder: true, AlbumArtists: [{ Id: 'a1', Name: 'Artist A' }] },
		{ Id: 'b2', Name: 'Second', Type: 'MusicAlbum', IsFolder: true, AlbumArtists: [{ Id: 'a2', Name: 'Artist B' }] },
		{ Id: 'b3', Name: 'Third', Type: 'MusicAlbum', IsFolder: true, AlbumArtists: [{ Id: 'a2', Name: 'Artist B' }] },
		{ Id: 'b4', Name: 'Compilation', Type: 'MusicAlbum', IsFolder: true, AlbumArtists: [{ Id: 'a3', Name: 'Various Artists' }] }
	];
	/**
	 * The libraries, and the folders on disk under the music one: `fb` (a
	 * plain folder, "Artist B") holds the album `b2`, which holds its tracks.
	 * Each folder's ancestors are listed nearest first, ending at the server's
	 * own root, as `/Items/{id}/Ancestors` answers.
	 */
	const views = [
		{ Id: 'lib1', Name: 'Music', Type: 'CollectionFolder', CollectionType: 'music', IsFolder: true },
		{ Id: 'lib2', Name: 'Films', Type: 'CollectionFolder', CollectionType: 'movies', IsFolder: true }
	];
	const root = { Id: 'root', Name: 'Media Folders', Type: 'UserRootFolder', IsFolder: true };
	const folderB = { Id: 'fb', Name: 'Artist B', Type: 'Folder', IsFolder: true };
	const tracks = [1, 2, 3].map((n) => ({
		Id: `t${n}`,
		Name: `Track ${n}`,
		Type: 'Audio',
		Album: 'Second',
		AlbumId: 'b2',
		AlbumArtist: 'Artist B',
		ArtistItems: [{ Id: 'a2', Name: 'Artist B' }],
		RunTimeTicks: 1_800_000_000,
		IndexNumber: n
	}));
	const trackItem = (n) => ({
		Id: `jt${n}`,
		Name: `Jellyfin Track ${n}`,
		Type: 'Audio',
		Album: 'First',
		AlbumId: 'b1',
		ArtistItems: [{ Id: 'a1', Name: 'Artist A' }],
		RunTimeTicks: 1_800_000_000
	});
	/** Playlist `jpl`, in order: the entry id, and which track it is. */
	const playlist = [1, 2, 3].map((n) => ({ id: `e${n}`, track: n }));
	/**
	 * Songs the user has played: `{ Id, AlbumId, PlayCount, LastPlayedDate }`.
	 * Jellyfin keeps plays on songs only, so its albums carry none.
	 */
	/** Item ids the user has made a favourite, which every item it answers with carries in `UserData`. */
	const state = { played: [], favourites: new Set() };

	/** An item as Jellyfin answers with it for this user: with its favourite state. */
	const withUserData = (item) =>
		item && typeof item === 'object' && typeof item.Id === 'string' && item.Type !== 'UserRootFolder'
			? { ...item, UserData: { ...(item.UserData ?? {}), IsFavorite: state.favourites.has(item.Id) } }
			: item;

	const server = await listen((req, res) => {
		const url = new URL(req.url, 'http://mock');
		const send = (body, status = 200) => {
			res.statusCode = status;
			res.setHeader('content-type', 'application/json');
			const decorated = Array.isArray(body?.Items) ? { ...body, Items: body.Items.map(withUserData) } : withUserData(body);
			res.end(JSON.stringify(decorated));
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
		// Favourites, by the route Heddohon uses: POST adds, DELETE removes, and
		// the answer is the item's user data.
		const favourite = /^\/Users\/u1\/FavoriteItems\/([^/]+)$/.exec(url.pathname);
		if (favourite && (req.method === 'POST' || req.method === 'DELETE')) {
			if (req.method === 'POST') state.favourites.add(favourite[1]);
			else state.favourites.delete(favourite[1]);
			return send({ IsFavorite: state.favourites.has(favourite[1]), ItemId: favourite[1] });
		}
		// The favourites of one kind, as the favourites page and "play favourites" ask.
		if (url.pathname === '/Items' && url.searchParams.get('Filters') === 'IsFavorite') {
			const pool = { Audio: tracks, MusicAlbum: albums, MusicArtist: artists }[types] ?? [];
			return send({ Items: pool.filter((entry) => state.favourites.has(entry.Id)) });
		}
		// The tracks an artist is on: Guest Singer sings on one of Artist B's.
		if (url.pathname === '/Items' && types === 'Audio' && url.searchParams.get('ArtistIds') === 'g1') {
			return send({ Items: [{ ...tracks[1], ArtistItems: [...tracks[1].ArtistItems, { Id: 'g1', Name: 'Guest Singer' }] }] });
		}
		// An album's tracks, as the album page asks for them.
		if (url.pathname === '/Items' && types === 'Audio' && url.searchParams.get('ParentId')) {
			return send({ Items: tracks.filter((track) => track.AlbumId === url.searchParams.get('ParentId')) });
		}
		if (url.pathname === '/UserViews') return send({ Items: views });
		if (url.pathname === '/Items/lib1') return send(views[0]);
		if (url.pathname === '/Items/fb') return send(folderB);
		if (url.pathname === '/Items/t1') return send({ ...tracks[0], IsFolder: false });
		if (url.pathname === '/Items/fb/Ancestors') return send([views[0], root]);
		if (url.pathname === '/Items/b2/Ancestors') return send([folderB, views[0], root]);
		// A folder's children, which the album page also asks for, by type.
		const parent = url.searchParams.get('ParentId');
		if (url.pathname === '/Items' && parent && !types) {
			const children = { lib1: [folderB], fb: [albums[1]], b2: tracks.map((track) => ({ ...track, IsFolder: false })) };
			return send({ Items: children[parent] ?? [] });
		}
		if (url.pathname === '/Users/u1') return send({ Id: 'u1', Name: 'jfuser', Policy: { IsAdministrator: false } });
		if (url.pathname === '/Items' && types === 'MusicArtist') return send({ Items: artists });
		if (url.pathname === '/Items' && types === 'Audio' && url.searchParams.get('Filters') === 'IsPlayed') {
			const key = url.searchParams.get('SortBy') === 'PlayCount' ? 'PlayCount' : 'LastPlayedDate';
			const items = state.played
				.map(({ Id, AlbumId, PlayCount, LastPlayedDate }) => ({
					...tracks.find((track) => track.Id === Id),
					Id,
					Type: 'Audio',
					AlbumId,
					UserData: { PlayCount, LastPlayedDate, Played: true }
				}))
				.sort((a, b) => (a.UserData[key] < b.UserData[key] ? 1 : a.UserData[key] > b.UserData[key] ? -1 : 0));
			return send({ Items: items });
		}
		if (url.pathname === '/Items' && types === 'MusicAlbum') return send({ Items: albums });
		// An instant mix of the first album or of one of its tracks, and those
		// tracks by id; any other item has no mix.
		if (/^\/Items\/(b1|t[123])\/InstantMix$/.test(url.pathname)) return send({ Items: tracks });
		if (/^\/Items\/[^/]+\/InstantMix$/.test(url.pathname)) return send({ Items: [] });
		if (url.pathname === '/Items' && url.searchParams.get('Ids')) {
			const ids = url.searchParams.get('Ids').split(',');
			return send({ Items: [...tracks, ...albums].filter((item) => ids.includes(item.Id)) });
		}
		// A playlist of three tracks, each entry with an id of its own, which is
		// what Jellyfin moves and removes entries by.
		if (url.pathname === '/Items/jpl') return send({ Id: 'jpl', Name: 'Jellyfin Playlist', Type: 'Playlist' });
		// Artists and albums by id, each with its type, as the adapter checks it.
		const item = [...artists, ...albums].find((entry) => url.pathname === `/Items/${entry.Id}`);
		if (req.method === 'GET' && item) return send(item);
		if (req.method === 'GET' && url.pathname === '/Playlists/jpl/Items') {
			return send({ Items: playlist.map((entry) => ({ ...trackItem(entry.track), PlaylistItemId: entry.id })) });
		}
		const moveTo = /^\/Playlists\/jpl\/Items\/([^/]+)\/Move\/(\d+)$/.exec(url.pathname);
		if (req.method === 'POST' && moveTo) {
			const from = playlist.findIndex((entry) => entry.id === moveTo[1]);
			if (from < 0) return send({}, 404);
			const [moved] = playlist.splice(from, 1);
			playlist.splice(Number(moveTo[2]), 0, moved);
			res.statusCode = 204;
			return res.end();
		}
		if (url.pathname === '/Items') return send({ Items: [] });
		return send({}, 404);
	});

	return { ...server, calls, state };
}

/** The correction the mock AutoEq serves for the Sennheiser HD 650, as AutoEq writes it. */
export const HD650_PARAMETRIC = `Preamp: -6.1 dB
Filter 1: ON LSC Fc 105 Hz Gain 6.4 dB Q 0.70
Filter 2: ON PK Fc 8800 Hz Gain 5.1 dB Q 1.42
Filter 3: ON PK Fc 118 Hz Gain -3.1 dB Q 0.50
Filter 4: OFF PK Fc 37 Hz Gain 0.7 dB Q 3.96
Filter 5: ON HSC Fc 10000 Hz Gain -2.1 dB Q 0.70
`;

/**
 * The `results` directory of AutoEq: `INDEX.md`, answered with an ETag and a
 * 304 for a request that names it, and the ParametricEQ.txt of one profile.
 * The index lists a profile whose file is missing and one whose path climbs
 * out of the directory. `calls` counts `index`, `index304` and `profile`.
 */
export async function startAutoEq() {
	const calls = counter();
	const state = { etag: '"v1"', down: false };
	const index = () => `# Index
This is a list of all equalization profiles.

- [Sennheiser HD 650](./oratory1990/over-ear/Sennheiser%20HD%20650) by oratory1990
- [Sennheiser HD 650](./crinacle/GRAS%2043AG-7%20over-ear/Sennheiser%20HD%20650) by crinacle on GRAS 43AG-7
- [Sennheiser HD 650 (2020)](./crinacle/GRAS%2043AG-7%20over-ear/Sennheiser%20HD%20650%20(2020)) by crinacle on GRAS 43AG-7
- [1MORE Aero (ANC Off)](./HypetheSonics/GRAS%20RA0045%20in-ear/1MORE%20Aero%20(ANC%20Off)) by HypetheSonics on GRAS RA0045
- [Climber](./../../secret/Climber) by nobody
`;
	const server = await listen((req, res) => {
		const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
		if (state.down) {
			res.statusCode = 503;
			return res.end();
		}
		if (path === '/results/INDEX.md') {
			res.setHeader('etag', state.etag);
			if (req.headers['if-none-match'] === state.etag) {
				calls.hit('index304');
				res.statusCode = 304;
				return res.end();
			}
			calls.hit('index');
			res.setHeader('content-type', 'text/plain; charset=utf-8');
			return res.end(index());
		}
		calls.hit('profile');
		if (path === '/results/oratory1990/over-ear/Sennheiser HD 650/Sennheiser HD 650 ParametricEQ.txt') {
			res.setHeader('content-type', 'text/plain; charset=utf-8');
			return res.end(HD650_PARAMETRIC);
		}
		res.statusCode = 404;
		res.end('404: Not Found');
	});
	return { ...server, url: `${server.url}/results`, calls, state };
}
