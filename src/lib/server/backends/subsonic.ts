/**
 * Subsonic API adapter (Navidrome, Gonic, Airsonic, …).
 *
 * Auth note: the Subsonic scheme is `t = md5(password + salt)` with a fresh
 * salt per request, which requires the plaintext password on every call. That
 * is a property of the protocol, not a choice — see StoredCredential. The
 * password is therefore held sealed at rest and opened only per request.
 */
import { upstreamFor } from '../config';
import { subsonicToken, randomSalt } from '../crypto';
import {
	UpstreamError,
	forwardRequestHeaders,
	mapLimited,
	upstreamFetch,
	upstreamUrl,
	type UpstreamParams
} from './http';
import type {
	MediaBackend,
	PlaybackReport,
	StoredCredential,
	StreamRequest,
	UpstreamResponse
} from './types';
import type {
	Album,
	AlbumDetail,
	AlbumQuery,
	Artist,
	ArtistDetail,
	AudioQuality,
	Playlist,
	PlaylistDetail,
	LyricLine,
	Lyrics,
	SearchResults,
	Song,
	StarKind
} from '$lib/types';

const API_VERSION = '1.16.1';
const CLIENT_NAME = 'heddohon';

interface SubsonicEnvelope<T = Record<string, unknown>> {
	'subsonic-response': T & {
		status: 'ok' | 'failed';
		version: string;
		error?: { code: number; message: string };
	};
}

function creds(cred: StoredCredential): { username: string; password: string } {
	if (cred.kind !== 'subsonic') throw new Error('Wrong credential kind for the Subsonic backend');
	return cred;
}

function authParams(cred: StoredCredential): Record<string, string> {
	const { username, password } = creds(cred);
	const salt = randomSalt();
	return {
		u: username,
		t: subsonicToken(password, salt),
		s: salt,
		v: API_VERSION,
		c: CLIENT_NAME,
		f: 'json'
	};
}

function endpoint(cred: StoredCredential, method: string, params: UpstreamParams = {}) {
	const base = upstreamFor('subsonic').url;
	return upstreamUrl(base, `/rest/${method}`, { ...authParams(cred), ...params });
}

/** Subsonic error codes worth distinguishing: 40 = bad credentials, 70 = not found. */
function throwForSubsonicError(code: number, message: string): never {
	if (code === 40 || code === 41 || code === 42 || code === 43 || code === 44) {
		throw new UpstreamError(message || 'Invalid username or password', 401, 'auth');
	}
	if (code === 50) throw new UpstreamError(message || 'Not authorised', 403, 'auth');
	if (code === 70) throw new UpstreamError(message || 'Not found', 404, 'not_found');
	throw new UpstreamError(message || `Subsonic error ${code}`, 502, 'protocol');
}

async function call<T extends Record<string, unknown>>(
	cred: StoredCredential,
	method: string,
	params: UpstreamParams = {}
): Promise<T> {
	const response = await upstreamFetch(endpoint(cred, method, params), {
		headers: { accept: 'application/json' }
	});
	if (response.status === 401 || response.status === 403) {
		throw new UpstreamError('The music server rejected these credentials', 401, 'auth');
	}
	if (!response.ok) {
		throw new UpstreamError(`Music server returned HTTP ${response.status}`, 502);
	}

	let payload: SubsonicEnvelope<T>;
	try {
		payload = (await response.json()) as SubsonicEnvelope<T>;
	} catch {
		throw new UpstreamError('Music server returned a response that was not JSON', 502, 'protocol');
	}

	const body = payload['subsonic-response'];
	if (!body) throw new UpstreamError('Music server returned an unexpected payload', 502, 'protocol');
	if (body.status === 'failed') {
		throwForSubsonicError(body.error?.code ?? 0, body.error?.message ?? '');
	}
	return body as T;
}

function asArray<T>(value: T | T[] | undefined | null): T[] {
	if (value === undefined || value === null) return [];
	return Array.isArray(value) ? value : [value];
}

const LOSSLESS = new Set(['flac', 'alac', 'wav', 'aiff', 'aif', 'ape', 'wv', 'dsf', 'dff', 'shn', 'tta']);

function quality(raw: Record<string, any>): AudioQuality {
	const format = (raw.suffix ?? raw.transcodedSuffix ?? null) as string | null;
	const codec = format?.toLowerCase() ?? '';
	const lossless = LOSSLESS.has(codec);
	const bitDepth = numberOrNull(raw.bitDepth);
	const sampleRateHz = numberOrNull(raw.samplingRate);
	return {
		format,
		bitrateKbps: numberOrNull(raw.bitRate),
		bitDepth,
		sampleRateHz,
		channels: numberOrNull(raw.channelCount),
		sizeBytes: numberOrNull(raw.size),
		lossless,
		highResolution: lossless && ((bitDepth ?? 16) > 16 || (sampleRateHz ?? 44100) > 48000)
	};
}

function numberOrNull(value: unknown): number | null {
	const n = typeof value === 'string' ? Number(value) : value;
	return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

function toSong(raw: Record<string, any>): Song {
	return {
		id: String(raw.id),
		title: raw.title ?? raw.name ?? 'Unknown title',
		albumId: raw.albumId ? String(raw.albumId) : null,
		album: raw.album ?? null,
		artistId: raw.artistId ? String(raw.artistId) : null,
		artist: raw.artist ?? null,
		albumArtist: raw.albumArtist ?? null,
		duration: numberOrNull(raw.duration) ?? 0,
		track: numberOrNull(raw.track),
		disc: numberOrNull(raw.discNumber),
		year: numberOrNull(raw.year),
		genre: raw.genre ?? null,
		coverArt: raw.coverArt ? String(raw.coverArt) : null,
		starred: Boolean(raw.starred),
		playCount: numberOrNull(raw.playCount),
		quality: quality(raw)
	};
}

function toAlbum(raw: Record<string, any>): Album {
	const created = raw.created ? Date.parse(raw.created) : NaN;
	return {
		id: String(raw.id),
		name: raw.name ?? raw.album ?? 'Unknown album',
		artistId: raw.artistId ? String(raw.artistId) : null,
		artist: raw.artist ?? null,
		year: numberOrNull(raw.year),
		genre: raw.genre ?? null,
		songCount: numberOrNull(raw.songCount),
		duration: numberOrNull(raw.duration),
		coverArt: raw.coverArt ? String(raw.coverArt) : null,
		starred: Boolean(raw.starred),
		createdAt: Number.isFinite(created) ? created : null
	};
}

function toArtist(raw: Record<string, any>): Artist {
	return {
		id: String(raw.id),
		name: raw.name ?? 'Unknown artist',
		albumCount: numberOrNull(raw.albumCount),
		coverArt: raw.coverArt ? String(raw.coverArt) : raw.artistImageUrl ? null : null,
		starred: Boolean(raw.starred)
	};
}

/**
 * Navidrome reports a similar artist that is not in the library with the id
 * `-1` rather than leaving it out, and a link to that goes nowhere. The
 * `includeNotPresent` parameter defaults to false, so this should not arrive
 * at all. It is filtered anyway: the cost is one comparison, and the failure
 * mode is a card in the middle of the page that leads to a 404.
 */
function present(raw: Record<string, any>): boolean {
	const id = raw.id === undefined || raw.id === null ? '' : String(raw.id);
	return id !== '' && id !== '-1';
}

/**
 * Groups tracks into the albums they belong to, keeping first-seen order.
 *
 * A song carries its album's id, name, artist and cover, which is everything a
 * card shows. It does not carry the album's own `starred` flag or track count,
 * so those are left null and false rather than filled in from the track: a
 * favourite song does not make its album a favourite.
 *
 * Albums credited to `seedArtistId` are dropped. Subsonic's similar-songs list
 * includes the seed artist's own tracks, and the album page shows that
 * catalogue in its own section above this shelf, so keeping them here put the
 * same record on the page twice.
 *
 * The id compared is the track artist, which is not always the album artist:
 * a record by the seed artist whose tracks credit a guest can still get
 * through. That costs one duplicate card rather than anything worse.
 */
function albumsFromSongs(
	songs: Record<string, any>[],
	options: { excludeAlbumId: string; seedArtistId: string | null; limit: number }
): Album[] {
	const seen = new Map<string, Album>();

	for (const raw of songs) {
		const albumId = raw.albumId ? String(raw.albumId) : null;
		if (!albumId || albumId === options.excludeAlbumId || seen.has(albumId)) continue;
		const artistId = raw.artistId ? String(raw.artistId) : null;
		if (artistId !== null && artistId === options.seedArtistId) continue;
		seen.set(albumId, {
			id: albumId,
			name: raw.album ?? 'Unknown album',
			artistId,
			artist: raw.artist ?? null,
			year: numberOrNull(raw.year),
			genre: raw.genre ?? null,
			songCount: null,
			duration: null,
			coverArt: raw.coverArt ? String(raw.coverArt) : null,
			starred: false,
			createdAt: null
		});
	}

	return [...seen.values()].slice(0, options.limit);
}

function toPlaylist(raw: Record<string, any>): Playlist {
	const changed = raw.changed ? Date.parse(raw.changed) : NaN;
	const created = raw.created ? Date.parse(raw.created) : NaN;
	return {
		id: String(raw.id),
		name: raw.name ?? 'Untitled playlist',
		comment: raw.comment ?? null,
		songCount: numberOrNull(raw.songCount),
		duration: numberOrNull(raw.duration),
		coverArt: raw.coverArt ? String(raw.coverArt) : null,
		owner: raw.owner ?? null,
		isPublic: Boolean(raw.public),
		createdAt: Number.isFinite(created) ? created : null,
		changedAt: Number.isFinite(changed) ? changed : null
	};
}

const SORT_TO_LIST_TYPE: Record<AlbumQuery['sort'], string> = {
	recentlyAdded: 'newest',
	recentlyPlayed: 'recent',
	mostPlayed: 'frequent',
	alphabetical: 'alphabeticalByName',
	byArtist: 'alphabeticalByArtist',
	byYear: 'byYear',
	random: 'random',
	starred: 'starred'
};

export const subsonicBackend: MediaBackend = {
	kind: 'subsonic',

	async login(username, password) {
		const cred: StoredCredential = { kind: 'subsonic', username, password };
		// `ping` authenticates without returning anything sensitive.
		await call(cred, 'ping.view');
		return { credential: cred, remoteUserId: username };
	},

	async verify(cred) {
		try {
			await call(cred, 'ping.view');
			return true;
		} catch {
			return false;
		}
	},

	/**
	 * `getUser` for the caller's own account. Navidrome answers this for the
	 * account asking, and reserves other usernames for administrators, so no
	 * elevated permission is needed to read one's own record. Servers that do
	 * not implement the method answer with an error, which is reported as
	 * "not known" rather than as "not an administrator".
	 */
	async isAdmin(cred) {
		if (cred.kind !== 'subsonic') return null;
		try {
			const body = await call<{ user?: { adminRole?: boolean } }>(cred, 'getUser.view', {
				username: cred.username
			});
			const role = body.user?.adminRole;
			return typeof role === 'boolean' ? role : null;
		} catch {
			return null;
		}
	},

	async getAlbums(cred, query) {
		const params: Record<string, string | number> = {
			type: SORT_TO_LIST_TYPE[query.sort],
			size: Math.min(query.limit, 500),
			offset: query.offset
		};
		if (query.sort === 'byYear') {
			params.fromYear = 1900;
			params.toYear = new Date().getFullYear() + 1;
		}
		const body = await call<{ albumList2?: { album?: unknown } }>(cred, 'getAlbumList2.view', params);
		return asArray(body.albumList2?.album as Record<string, any>[]).map(toAlbum);
	},

	async getAlbum(cred, id): Promise<AlbumDetail> {
		const body = await call<{ album?: Record<string, any> }>(cred, 'getAlbum.view', { id });
		const raw = body.album;
		if (!raw) throw new UpstreamError('Album not found', 404, 'not_found');
		return { ...toAlbum(raw), songs: asArray(raw.song as Record<string, any>[]).map(toSong) };
	},

	async getArtists(cred) {
		const body = await call<{ artists?: { index?: unknown } }>(cred, 'getArtists.view');
		const indexes = asArray(body.artists?.index as Record<string, any>[]);
		return indexes.flatMap((index) => asArray(index.artist as Record<string, any>[]).map(toArtist));
	},

	async getArtist(cred, id): Promise<ArtistDetail> {
		const body = await call<{ artist?: Record<string, any> }>(cred, 'getArtist.view', { id });
		const raw = body.artist;
		if (!raw) throw new UpstreamError('Artist not found', 404, 'not_found');

		// Both of these are optional extras: a server that lacks them should not
		// break the page, so failures degrade to empty rather than propagating.
		const [info, top] = await Promise.allSettled([
			call<{ artistInfo2?: Record<string, any> }>(cred, 'getArtistInfo2.view', { id, count: 0 }),
			call<{ topSongs?: { song?: unknown } }>(cred, 'getTopSongs.view', {
				artist: raw.name,
				count: 10
			})
		]);

		return {
			...toArtist(raw),
			albums: asArray(raw.album as Record<string, any>[]).map(toAlbum),
			biography:
				info.status === 'fulfilled'
					? ((info.value.artistInfo2?.biography as string | undefined)?.trim() ?? null)
					: null,
			topSongs:
				top.status === 'fulfilled'
					? asArray(top.value.topSongs?.song as Record<string, any>[]).map(toSong)
					: []
		};
	},

	async getArtistAlbums(cred, artistId): Promise<Album[]> {
		// `getArtist.view` carries the album list, so this is one request. The
		// biography and top songs that getArtist above pairs it with are two
		// more, and the album page has no use for either.
		const body = await call<{ artist?: Record<string, any> }>(cred, 'getArtist.view', {
			id: artistId
		});
		return asArray(body.artist?.album as Record<string, any>[]).map(toAlbum);
	},

	async getSimilarArtists(cred, artistId, limit): Promise<Artist[]> {
		/*
		 * This is the second call to `getArtistInfo2` in an artist page view:
		 * getArtist above makes the first, with count 0, for the biography.
		 * The duplicate is deliberate. Folding the similar artists into
		 * `ArtistDetail` would save the round trip, but it would also put them
		 * on the path the page waits for, and this is loaded separately so a
		 * slow Last.fm never delays the releases. Navidrome answers the second
		 * call from its own cache of the first.
		 */
		const body = await call<{ artistInfo2?: { similarArtist?: unknown } }>(
			cred,
			'getArtistInfo2.view',
			{ id: artistId, count: limit }
		);
		return asArray(body.artistInfo2?.similarArtist as Record<string, any>[])
			.filter(present)
			.map(toArtist)
			.slice(0, limit);
	},

	async getSimilarAlbums(cred, albumId, artistId, limit): Promise<Album[]> {
		// Subsonic has no album-to-album similarity. This is the nearest thing it
		// offers: tracks by artists the server considers similar, grouped back
		// into the albums they came from. `getSimilarSongs2` is specified to take
		// an artist id only, so an album with no artist id has nothing to ask.
		if (!artistId) return [];

		// The shelf counts distinct albums, and several tracks from one album
		// count once, so the song count has to exceed the shelf size by some
		// margin. Eight times, capped at 100. The endpoint's documented default
		// is 50.
		const body = await call<{ similarSongs2?: { song?: unknown } }>(cred, 'getSimilarSongs2.view', {
			id: artistId,
			count: Math.min(100, limit * 8)
		});
		return albumsFromSongs(
			asArray(body.similarSongs2?.song as Record<string, any>[]),
			{ excludeAlbumId: albumId, seedArtistId: artistId, limit }
		);
	},

	async getPlaylists(cred) {
		const body = await call<{ playlists?: { playlist?: unknown } }>(cred, 'getPlaylists.view');
		return asArray(body.playlists?.playlist as Record<string, any>[]).map(toPlaylist);
	},

	async getPlaylist(cred, id): Promise<PlaylistDetail> {
		const body = await call<{ playlist?: Record<string, any> }>(cred, 'getPlaylist.view', { id });
		const raw = body.playlist;
		if (!raw) throw new UpstreamError('Playlist not found', 404, 'not_found');
		return { ...toPlaylist(raw), songs: asArray(raw.entry as Record<string, any>[]).map(toSong) };
	},

	async getSongs(cred, ids) {
		// One call per id, since Subsonic has no batch lookup, and bounded, since
		// the caller may pass 1000 of them.
		const songs = await mapLimited(ids, async (id) => {
			const body = await call<{ song?: Record<string, any> }>(cred, 'getSong.view', { id });
			return body.song ? toSong(body.song) : null;
		});
		return songs.filter((song): song is Song => song !== null);
	},

	async getRandomSongs(cred, limit) {
		const body = await call<{ randomSongs?: { song?: unknown } }>(cred, 'getRandomSongs.view', {
			size: Math.min(limit, 500)
		});
		return asArray(body.randomSongs?.song as Record<string, any>[]).map(toSong);
	},

	async getStarred(cred): Promise<SearchResults> {
		const body = await call<{ starred2?: Record<string, any> }>(cred, 'getStarred2.view');
		const starred = body.starred2 ?? {};
		return {
			albums: asArray(starred.album as Record<string, any>[]).map(toAlbum),
			artists: asArray(starred.artist as Record<string, any>[]).map(toArtist),
			songs: asArray(starred.song as Record<string, any>[]).map(toSong)
		};
	},

	async search(cred, query, limit): Promise<SearchResults> {
		const body = await call<{ searchResult3?: Record<string, any> }>(cred, 'search3.view', {
			query,
			songCount: limit,
			albumCount: limit,
			artistCount: limit
		});
		const result = body.searchResult3 ?? {};
		return {
			albums: asArray(result.album as Record<string, any>[]).map(toAlbum),
			artists: asArray(result.artist as Record<string, any>[]).map(toArtist),
			songs: asArray(result.song as Record<string, any>[]).map(toSong)
		};
	},

	async setStarred(cred, id, kind: StarKind, starred) {
		const key = kind === 'album' ? 'albumId' : kind === 'artist' ? 'artistId' : 'id';
		await call(cred, starred ? 'star.view' : 'unstar.view', { [key]: id });
	},

	async getLyrics(cred, song): Promise<Lyrics | null> {
		// OpenSubsonic's getLyricsBySongId is the good one: it returns structured,
		// optionally synced lines. Navidrome supports it; older servers do not, and
		// answer with an error code that we treat as "ask the other way".
		try {
			const body = await call<{ lyricsList?: { structuredLyrics?: unknown } }>(
				cred,
				'getLyricsBySongId.view',
				{ id: song.id }
			);
			const structured = asArray(body.lyricsList?.structuredLyrics as Record<string, any>[]);
			// Prefer a synced set when the server offers both.
			const chosen =
				structured.find((entry) => entry.synced === true) ?? structured[0];

			if (chosen) {
				const lines: LyricLine[] = asArray(chosen.line as Record<string, any>[])
					.map((line) => ({
						timeMs: numberOrNull(line.start),
						text: typeof line.value === 'string' ? line.value : ''
					}))
					.filter((line) => line.text.length > 0 || line.timeMs !== null);

				if (lines.length > 0) {
					return {
						synced: Boolean(chosen.synced) && lines.every((line) => line.timeMs !== null),
						lines,
						artist: chosen.displayArtist ?? song.artist,
						title: chosen.displayTitle ?? song.title
					};
				}
			}
		} catch (err) {
			// Unimplemented on this server; fall through to the 1.x endpoint.
			if (err instanceof UpstreamError && err.kind === 'auth') throw err;
		}

		if (!song.artist || !song.title) return null;

		const body = await call<{ lyrics?: Record<string, any> }>(cred, 'getLyrics.view', {
			artist: song.artist,
			title: song.title
		}).catch(() => null);

		const text = typeof body?.lyrics?.value === 'string' ? body.lyrics.value : '';
		if (!text.trim()) return null;

		return {
			synced: false,
			lines: text.split(/\r?\n/).map((line) => ({ timeMs: null, text: line })),
			artist: body?.lyrics?.artist ?? song.artist,
			title: body?.lyrics?.title ?? song.title
		};
	},

	async createPlaylist(cred, name, songIds) {
		const body = await call<{ playlist?: Record<string, any> }>(cred, 'createPlaylist.view', {
			name,
			songId: songIds
		});
		// Older servers answer createPlaylist with an empty body. Falling back to a
		// name lookup is not perfect — two playlists can share a name — so prefer
		// the most recently created match.
		if (body.playlist?.id) return String(body.playlist.id);

		const listing = await call<{ playlists?: { playlist?: unknown } }>(cred, 'getPlaylists.view');
		const matches = asArray(listing.playlists?.playlist as Record<string, any>[])
			.filter((entry) => entry.name === name)
			.map(toPlaylist)
			.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
		if (matches[0]) return matches[0].id;
		throw new UpstreamError('The music server created the playlist but did not return it', 502, 'protocol');
	},

	async renamePlaylist(cred, id, name) {
		await call(cred, 'updatePlaylist.view', { playlistId: id, name });
	},

	async addToPlaylist(cred, id, songIds) {
		if (songIds.length === 0) return;
		await call(cred, 'updatePlaylist.view', { playlistId: id, songIdToAdd: songIds });
	},

	async removeFromPlaylist(cred, id, indices) {
		if (indices.length === 0) return;
		// Subsonic removes by index and applies them against the original list, so
		// they can all go in one call regardless of order.
		await call(cred, 'updatePlaylist.view', {
			playlistId: id,
			songIndexToRemove: [...indices].sort((a, b) => b - a)
		});
	},

	async deletePlaylist(cred, id) {
		await call(cred, 'deletePlaylist.view', { id });
	},

	async reportPlayback(cred, report: PlaybackReport) {
		// Subsonic has no progress channel. `submission=false` marks the track as
		// now-playing; `true` records an actual play.
		if (report.event === 'progress') return;
		if (report.event === 'stop' && !report.completed) return;
		await call(cred, 'scrobble.view', {
			id: report.songId,
			submission: report.event === 'stop' ? 'true' : 'false'
		});
	},

	async openStream(cred, songId, req: StreamRequest, transcode): Promise<UpstreamResponse> {
		// `format=raw` and `maxBitRate=0` together tell Navidrome to hand back the
		// original file untouched, which is what this player is for and what it
		// asks for unless the account has said otherwise.
		//
		// A named format and a bitrate ask Navidrome to convert instead. Both
		// values come from an allowlist in `settings.ts` rather than from a
		// request, and go through `URLSearchParams` like every other parameter.
		const url = endpoint(cred, 'stream.view', {
			id: songId,
			format: transcode ? transcode.codec : 'raw',
			maxBitRate: transcode ? transcode.bitrateKbps : 0,
			estimateContentLength: 'true'
		});
		const response = await upstreamFetch(url, {
			method: req.method ?? 'GET',
			headers: forwardRequestHeaders(req),
			signal: req.signal
		});
		return { status: response.status, headers: response.headers, body: response.body };
	},

	async openCover(cred, coverId, size, req): Promise<UpstreamResponse> {
		const url = endpoint(cred, 'getCoverArt.view', { id: coverId, size });
		const response = await upstreamFetch(url, {
			method: req.method ?? 'GET',
			headers: forwardRequestHeaders(req),
			signal: req.signal
		});
		return { status: response.status, headers: response.headers, body: response.body };
	}
};
