/**
 * Subsonic API adapter (Navidrome, Gonic, Airsonic, …).
 *
 * The scheme is `t = md5(password + salt)` with a fresh salt per request, so
 * the plaintext password is needed on every call (see StoredCredential). It is
 * held sealed and opened per request.
 */
import { log } from '../log';
import { upstreamFor } from '../config';
import { subsonicToken, randomSalt } from '../crypto';
import {
	UpstreamError,
	forwardRequestHeaders,
	mapLimited,
	readJson,
	upstreamFetch,
	upstreamUrl,
	type UpstreamParams
} from './http';
import { finishLastfm, linkListenBrainz, scrobblerLinks, startLastfm, unlinkScrobbler } from './navidrome';
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
	Folder,
	FolderRef,
	Playlist,
	PlaylistDetail,
	LyricLine,
	Genre,
	Lyrics,
	SearchResults,
	ReplayGain,
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

/**
 * Subsonic error codes: 40 = bad credentials, 70 = not found.
 *
 * The server's text goes to the log and the error carries a fixed one: routes
 * pass an error's message to the browser, and Navidrome's text for an internal
 * failure can name its database file and path.
 */
function throwForSubsonicError(code: number, message: string): never {
	if (message) log.warn('upstream-error', { code, detail: message });
	if (code === 40 || code === 41 || code === 42 || code === 43 || code === 44) {
		throw new UpstreamError('Invalid username or password', 401, 'auth');
	}
	if (code === 50) throw new UpstreamError('Not authorised', 403, 'auth');
	if (code === 70) throw new UpstreamError('Not found', 404, 'not_found');
	throw new UpstreamError(`The music server reported error ${code}`, 502, 'protocol');
}

/** The same encoding as the address takes, repeated keys for a list, as a form body. */
function formBody(params: UpstreamParams): string {
	const body = new URLSearchParams();
	for (const [key, value] of Object.entries(params)) {
		if (value === undefined) continue;
		for (const item of Array.isArray(value) ? value : [value]) body.append(key, String(item));
	}
	return body.toString();
}

/**
 * `form` goes in a POST body instead of the address, for a list too long for a
 * URL: a reverse proxy commonly allows 8KB of request line and headers
 * (nginx's default), and a playlist of about 250 tracks as `songId` parameters
 * is over that. OpenSubsonic calls this `formPost`, and Navidrome reads it.
 */
async function call<T extends Record<string, unknown>>(
	cred: StoredCredential,
	method: string,
	params: UpstreamParams = {},
	form?: UpstreamParams
): Promise<T> {
	const response = await upstreamFetch(
		endpoint(cred, method, params),
		form
			? {
					method: 'POST',
					headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
					body: formBody(form)
				}
			: { headers: { accept: 'application/json' } }
	);
	if (response.status === 401 || response.status === 403) {
		throw new UpstreamError('The music server rejected these credentials', 401, 'auth');
	}
	if (!response.ok) {
		throw new UpstreamError(`Music server returned HTTP ${response.status}`, 502);
	}

	let payload: SubsonicEnvelope<T>;
	try {
		payload = (await readJson(response)) as SubsonicEnvelope<T>;
	} catch (err) {
		if (err instanceof UpstreamError) throw err;
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

function shuffledCopy<T>(items: T[]): T[] {
	const copy = [...items];
	for (let i = copy.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[copy[i], copy[j]] = [copy[j], copy[i]];
	}
	return copy;
}

function numberOrNull(value: unknown): number | null {
	const n = typeof value === 'string' ? Number(value) : value;
	return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

/**
 * The year a record first came out, where the server knows it: a 2011 remaster
 * of a 1973 album is 1973.
 *
 * `originalReleaseDate` is OpenSubsonic's (`{ year, month, day }`), which
 * Navidrome fills from the ORIGINALDATE or ORIGINALYEAR tag. Without it, or
 * with a year of 0 (Navidrome's for a date without one), `year` is used, which
 * is the edition's.
 */
function yearOf(raw: Record<string, any>): number | null {
	const original = numberOrNull(raw.originalReleaseDate?.year);
	return original !== null && original > 0 ? original : numberOrNull(raw.year);
}

/** OpenSubsonic's `replayGain`, which Navidrome fills from the file's tags. Absent on a plain Subsonic server or an untagged file. */
function replayGainOf(raw: unknown): ReplayGain | null {
	if (typeof raw !== 'object' || raw === null) return null;
	const value = raw as Record<string, unknown>;
	const gain = {
		trackGain: numberOrNull(value.trackGain),
		albumGain: numberOrNull(value.albumGain),
		trackPeak: numberOrNull(value.trackPeak),
		albumPeak: numberOrNull(value.albumPeak)
	};
	return gain.trackGain === null && gain.albumGain === null ? null : gain;
}

/** When an item was starred. Subsonic's `starred` is the time of the star, absent on an item that is not starred. */
function starredAt(value: unknown): number | null {
	const parsed = typeof value === 'string' ? Date.parse(value) : NaN;
	return Number.isFinite(parsed) ? parsed : null;
}

/** The listener's rating, 0 to 5. Navidrome leaves `userRating` out of an unrated item, so missing is 0. */
function ratingOf(value: unknown): number {
	const rating = numberOrNull(value) ?? 0;
	return Math.min(5, Math.max(0, Math.round(rating)));
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
		year: yearOf(raw),
		genre: raw.genre ?? null,
		coverArt: raw.coverArt ? String(raw.coverArt) : null,
		starred: Boolean(raw.starred),
		starredAt: starredAt(raw.starred),
		playCount: numberOrNull(raw.playCount),
		rating: ratingOf(raw.userRating),
		quality: quality(raw),
		replayGain: replayGainOf(raw.replayGain)
	};
}

/**
 * OpenSubsonic's `releaseTypes`, with `isCompilation` counted as one. Null
 * where the server sends neither, which leaves the kind to the record's size.
 */
function releaseTypesOf(raw: Record<string, any>): string[] | null {
	const types = asArray(raw.releaseTypes as unknown[])
		.filter((type): type is string => typeof type === 'string' && type.trim() !== '')
		.slice(0, 8)
		.map((type) => type.trim().slice(0, 40));
	if (raw.isCompilation === true && !types.some((type) => type.toLowerCase() === 'compilation')) types.push('Compilation');
	return types.length > 0 ? types : null;
}

function toAlbum(raw: Record<string, any>): Album {
	const created = raw.created ? Date.parse(raw.created) : NaN;
	return {
		id: String(raw.id),
		name: raw.name ?? raw.album ?? 'Unknown album',
		artistId: raw.artistId ? String(raw.artistId) : null,
		artist: raw.artist ?? null,
		year: yearOf(raw),
		genre: raw.genre ?? null,
		songCount: numberOrNull(raw.songCount),
		duration: numberOrNull(raw.duration),
		coverArt: raw.coverArt ? String(raw.coverArt) : null,
		starred: Boolean(raw.starred),
		starredAt: starredAt(raw.starred),
		rating: ratingOf(raw.userRating),
		createdAt: Number.isFinite(created) ? created : null,
		releaseTypes: releaseTypesOf(raw)
	};
}

function toArtist(raw: Record<string, any>): Artist {
	return {
		id: String(raw.id),
		name: raw.name ?? 'Unknown artist',
		albumCount: numberOrNull(raw.albumCount),
		coverArt: raw.coverArt ? String(raw.coverArt) : raw.artistImageUrl ? null : null,
		starred: Boolean(raw.starred),
		starredAt: starredAt(raw.starred)
	};
}

/**
 * Navidrome reports a similar artist that is not in the library with the id
 * `-1`, and a link to that is a 404. `includeNotPresent` defaults to false, so
 * this should not arrive. It is filtered anyway.
 */
function present(raw: Record<string, any>): boolean {
	const id = raw.id === undefined || raw.id === null ? '' : String(raw.id);
	return id !== '' && id !== '-1';
}

/**
 * Groups tracks into the albums they belong to, keeping first-seen order.
 *
 * A song carries its album's id, name, artist and cover. It does not carry the
 * album's `starred` flag or track count, which are left null and false: a
 * favourite song does not make its album a favourite.
 *
 * Albums credited to `seedArtistId` are dropped. Subsonic's similar-songs list
 * includes the seed artist's own tracks, and the album page shows that
 * catalogue above this shelf. The id compared is the track artist, so a record
 * by the seed artist whose tracks credit a guest can still get through.
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
			year: yearOf(raw),
			genre: raw.genre ?? null,
			songCount: null,
			duration: null,
			coverArt: raw.coverArt ? String(raw.coverArt) : null,
			starred: false,
			starredAt: null,
			// The album's own rating is not on its tracks.
			rating: null,
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

/**
 * The top of one library, which `getIndexes` lists by its music folder id,
 * where `getMusicDirectory` takes a directory id. The prefix keeps the two
 * kinds of id apart in a folder's address.
 */
const LIBRARY_PREFIX = 'library:';

/**
 * Folders read upward for the trail above a folder. Subsonic names only a
 * directory's parent, so each level is its own call, in series.
 * `Artist/Album/Disc` is three.
 */
const MAX_FOLDER_DEPTH = 8;

/** A subfolder: an entry of `getIndexes` (`name`) or a child of a directory (`title`). */
function toFolderRef(raw: Record<string, any>): FolderRef {
	return {
		id: String(raw.id),
		name: String(raw.title ?? raw.name ?? 'Untitled folder'),
		coverArt: raw.coverArt ? String(raw.coverArt) : null
	};
}

/** What a directory holds: its subfolders, and its tracks without any video. */
function folderContents(children: Record<string, any>[]): Pick<Folder, 'folders' | 'songs'> {
	return {
		folders: children.filter((child) => child.isDir === true).map(toFolderRef),
		songs: children.filter((child) => child.isDir !== true && child.isVideo !== true).map(toSong)
	};
}

async function libraryIndex(cred: StoredCredential, musicFolderId: string | null): Promise<Pick<Folder, 'folders' | 'songs'>> {
	const body = await call<{ indexes?: Record<string, any> }>(
		cred,
		'getIndexes.view',
		musicFolderId === null ? {} : { musicFolderId }
	);
	const indexes = body.indexes ?? {};
	return {
		folders: asArray(indexes.index as Record<string, any>[])
			.flatMap((index) => asArray(index.artist as Record<string, any>[]))
			.map(toFolderRef),
		// Files at the top of a library, beside its folders.
		songs: folderContents(asArray(indexes.child as Record<string, any>[])).songs
	};
}

/** Songs a page of `getPlayedSongs` reads. */
const PLAYED_PAGE = 500;

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

	scrobblers: {
		status: scrobblerLinks,
		linkListenBrainz,
		unlink: unlinkScrobbler,
		startLastfm,
		finishLastfm
	},

	async login(username, password) {
		const cred: StoredCredential = { kind: 'subsonic', username, password };
		// `ping` authenticates without returning anything sensitive.
		await call(cred, 'ping.view');
		return { credential: cred, remoteUserId: username };
	},

	/**
	 * `getUser` for the caller's own account, which Navidrome answers without
	 * elevated permission. A server that does not implement the method answers
	 * with an error, reported as "not known".
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

	async getGenres(cred): Promise<Genre[]> {
		const body = await call<{ genres?: { genre?: unknown } }>(cred, 'getGenres.view');
		return asArray(body.genres?.genre as Record<string, any>[])
			.map((raw) => {
				const name = String(raw.value ?? raw.name ?? '');
				return {
					id: name,
					name,
					albumCount: numberOrNull(raw.albumCount),
					songCount: numberOrNull(raw.songCount)
				};
			})
			.filter((genre) => genre.name !== '' && (genre.albumCount ?? 1) > 0)
			.sort((a, b) => a.name.localeCompare(b.name));
	},

	async getGenreAlbums(cred, genreId, limit, offset) {
		const body = await call<{ albumList2?: { album?: unknown } }>(cred, 'getAlbumList2.view', {
			type: 'byGenre',
			genre: genreId,
			size: Math.min(limit, 500),
			offset
		});
		return asArray(body.albumList2?.album as Record<string, any>[]).map(toAlbum);
	},

	async getGenreSongs(cred, genreId, limit) {
		const body = await call<{ songsByGenre?: { song?: unknown } }>(cred, 'getSongsByGenre.view', {
			genre: genreId,
			count: Math.min(limit, 500)
		});
		// Subsonic returns these in library order. Shuffled, so playing a genre
		// does not start with the same album every time.
		return shuffledCopy(asArray(body.songsByGenre?.song as Record<string, any>[]).map(toSong));
	},

	async getInstantMix(cred, kind, id, limit) {
		// `getSimilarSongs` takes a song, an album or an artist id, and does not
		// return the song it was asked about, so a song's mix fetches that song
		// and puts it first.
		const [similar, seed] = await Promise.all([
			call<{ similarSongs?: { song?: unknown } }>(cred, 'getSimilarSongs.view', {
				id,
				count: Math.min(limit, 500)
			}),
			kind === 'song'
				? call<{ song?: Record<string, any> }>(cred, 'getSong.view', { id }).then((body) => body.song ?? null)
				: Promise.resolve(null)
		]);
		const songs = asArray(similar.similarSongs?.song as Record<string, any>[]).map(toSong);
		// Nothing similar is an empty mix, not the seed alone.
		if (songs.length === 0) return [];
		return seed ? [toSong(seed), ...songs.filter((song) => song.id !== seed.id)] : songs;
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

		// Both are optional extras: a server without them gives an empty
		// biography and no top songs.
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
		// `getArtist.view` carries the album list in one request, without the
		// biography and top songs that `getArtist` above adds two more for.
		const body = await call<{ artist?: Record<string, any> }>(cred, 'getArtist.view', {
			id: artistId
		});
		return asArray(body.artist?.album as Record<string, any>[]).map(toAlbum);
	},

	/**
	 * Subsonic has no call for this, so it is a search for the artist's name,
	 * kept to the songs the artist is on: by `artistId`, or by OpenSubsonic's
	 * `artists`, which Navidrome fills with every artist of a track ("A feat.
	 * B"). Each song's album is one entry. `albumArtists`, where sent, leaves
	 * out the artist's own albums here. Elsewhere `details.ts` does.
	 *
	 * The search also matches titles and returns at most 500 songs, so an
	 * artist on more than 500 tracks can be missing an album.
	 */
	async getAppearsOn(cred, artistId, artistName): Promise<Album[]> {
		const body = await call<{ searchResult3?: Record<string, any> }>(cred, 'search3.view', {
			query: artistName,
			songCount: 500,
			albumCount: 0,
			artistCount: 0
		});
		const albums = new Map<string, Album>();
		for (const raw of asArray(body.searchResult3?.song as Record<string, any>[])) {
			const on =
				String(raw.artistId ?? '') === artistId ||
				asArray(raw.artists as Record<string, any>[]).some((entry) => String(entry?.id) === artistId);
			if (!on || !raw.albumId) continue;
			const albumArtists = asArray(raw.albumArtists as Record<string, any>[]);
			if (albumArtists.some((entry) => String(entry?.id) === artistId)) continue;
			const id = String(raw.albumId);
			if (albums.has(id)) continue;
			albums.set(id, {
				id,
				name: raw.album ?? 'Unknown album',
				artistId: albumArtists[0]?.id ? String(albumArtists[0].id) : null,
				artist: raw.displayAlbumArtist ?? albumArtists[0]?.name ?? null,
				year: yearOf(raw),
				genre: null,
				songCount: null,
				duration: null,
				coverArt: raw.coverArt ? String(raw.coverArt) : null,
				starred: false,
				starredAt: null,
				rating: null,
				createdAt: null
			});
		}
		return [...albums.values()];
	},

	async getSimilarArtists(cred, artistId, limit): Promise<Artist[]> {
		/*
		 * The second `getArtistInfo2` of an artist page view: `getArtist` makes
		 * the first, with count 0, for the biography. Loaded separately so a
		 * slow Last.fm does not delay the releases. Navidrome answers it from
		 * its cache of the first.
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

	async getSimilarAlbums(cred, albumId, artistId, limit, like): Promise<Album[]> {
		// The nearest Subsonic has to album similarity: tracks by artists the
		// server considers similar, grouped into their albums. `getSimilarSongs2`
		// takes an artist id only, so an album without one has nothing to ask.
		//
		// Several tracks from one album count once on the shelf, so eight times
		// the shelf size is asked for, capped at 100. The endpoint's default is
		// 50.
		const count = Math.min(100, limit * 8);
		const found = artistId
			? albumsFromSongs(
					asArray(
						(await call<{ similarSongs2?: { song?: unknown } }>(cred, 'getSimilarSongs2.view', { id: artistId, count }))
							.similarSongs2?.song as Record<string, any>[]
					),
					{ excludeAlbumId: albumId, seedArtistId: artistId, limit }
				)
			: [];
		if (found.length >= limit || !like) return found;

		/*
		 * The rest of the shelf, from the album's own genre: random tracks under
		 * it, grouped into albums as above. An album without a genre is given the
		 * years around its own.
		 *
		 * Navidrome 0.64.2 with no similar artist in the library answers
		 * `getSimilarSongs2` with the artist's own tracks (64 of 64 on
		 * 2026-10-06), which are all dropped, so the album page had no shelf at
		 * all where Jellyfin, which works from genres, had one.
		 */
		const within: Record<string, string | number> | null = like.genre
			? { genre: like.genre }
			: like.year !== null
				? { fromYear: like.year - 2, toYear: like.year + 2 }
				: null;
		if (!within) return found;
		const body = await call<{ randomSongs?: { song?: unknown } }>(cred, 'getRandomSongs.view', { size: count, ...within }).catch(
			(err) => {
				// What was found stands, unless the credential has stopped working.
				if (err instanceof UpstreamError && err.kind === 'auth') throw err;
				return null;
			}
		);
		const held = new Set(found.map((album) => album.id));
		const more = albumsFromSongs(asArray(body?.randomSongs?.song as Record<string, any>[]), {
			excludeAlbumId: albumId,
			seedArtistId: artistId,
			limit: limit * 2
		});
		for (const album of more) {
			if (found.length >= limit) break;
			if (!held.has(album.id)) found.push(album);
		}
		return found;
	},

	async getFolder(cred, id): Promise<Folder> {
		if (id === null) {
			const body = await call<{ musicFolders?: { musicFolder?: unknown } }>(cred, 'getMusicFolders.view');
			const libraries = asArray(body.musicFolders?.musicFolder as Record<string, any>[]);
			// With one library, a level holding only it is a press that goes nowhere.
			if (libraries.length <= 1) return { id: null, name: 'Folders', parents: [], ...(await libraryIndex(cred, null)) };
			return {
				id: null,
				name: 'Folders',
				parents: [],
				folders: libraries.map((library) => ({
					id: `${LIBRARY_PREFIX}${library.id}`,
					name: String(library.name ?? `Library ${library.id}`),
					coverArt: null
				})),
				songs: []
			};
		}

		if (id.startsWith(LIBRARY_PREFIX)) {
			const musicFolderId = id.slice(LIBRARY_PREFIX.length);
			const [body, contents] = await Promise.all([
				call<{ musicFolders?: { musicFolder?: unknown } }>(cred, 'getMusicFolders.view'),
				libraryIndex(cred, musicFolderId)
			]);
			const library = asArray(body.musicFolders?.musicFolder as Record<string, any>[]).find(
				(entry) => String(entry.id) === musicFolderId
			);
			if (!library) throw new UpstreamError('Folder not found', 404, 'not_found');
			return { id, name: String(library.name ?? 'Library'), parents: [], ...contents };
		}

		const body = await call<{ directory?: Record<string, any> }>(cred, 'getMusicDirectory.view', { id });
		const directory = body.directory;
		if (!directory) throw new UpstreamError('Folder not found', 404, 'not_found');

		const parents: FolderRef[] = [];
		const seen = new Set([id]);
		let parent = directory.parent ? String(directory.parent) : null;
		while (parent && !seen.has(parent) && parents.length < MAX_FOLDER_DEPTH) {
			seen.add(parent);
			// A level that cannot be read ends the trail, not the folder asked for.
			const above = await call<{ directory?: Record<string, any> }>(cred, 'getMusicDirectory.view', {
				id: parent
			}).catch(() => null);
			if (!above?.directory) break;
			parents.unshift(toFolderRef(above.directory));
			parent = above.directory.parent ? String(above.directory.parent) : null;
		}

		return {
			id,
			name: String(directory.name ?? 'Untitled folder'),
			parents,
			...folderContents(asArray(directory.child as Record<string, any>[]))
		};
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
		// One call per id, since Subsonic has no batch lookup, bounded since the
		// caller may pass 1000.
		//
		// A track removed from the library answers error 70 and is left out, as
		// Jellyfin leaves it out of a batch. Rethrown, it rejected the lookup and
		// a saved queue holding one deleted track did not restore. Any other
		// failure still rejects.
		const songs = await mapLimited(ids, async (id) => {
			try {
				const body = await call<{ song?: Record<string, any> }>(cred, 'getSong.view', { id });
				return body.song ? toSong(body.song) : null;
			} catch (err) {
				if (err instanceof UpstreamError && err.kind === 'not_found') return null;
				throw err;
			}
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

	async setRating(cred, id, rating) {
		// One method for a song, an album or an artist id alike; 0 removes it.
		await call(cred, 'setRating.view', { id, rating });
	},

	async getRadioStations(cred) {
		const body = await call<{ internetRadioStations?: { internetRadioStation?: unknown } }>(
			cred,
			'getInternetRadioStations.view'
		);
		return asArray(body.internetRadioStations?.internetRadioStation as Record<string, any>[])
			.filter((station) => station?.id !== undefined && typeof station.streamUrl === 'string')
			.slice(0, 500)
			.map((station) => ({
				id: String(station.id),
				name: typeof station.name === 'string' && station.name.trim() ? station.name.trim().slice(0, 200) : 'Station',
				streamUrl: station.streamUrl,
				homePageUrl: typeof station.homePageUrl === 'string' ? station.homePageUrl : null
			}));
	},

	async getLyrics(cred, song): Promise<Lyrics | null> {
		// OpenSubsonic's getLyricsBySongId returns structured, optionally synced
		// lines. Navidrome supports it. An older server answers with an error
		// code, and the plain call below is tried.
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
		// Older servers answer createPlaylist with an empty body. Two playlists
		// can share a name, so the lookup takes the most recently created match.
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
		// Subsonic applies the indexes against the original list, so one call
		// takes them all in any order.
		await call(cred, 'updatePlaylist.view', {
			playlistId: id,
			songIndexToRemove: [...indices].sort((a, b) => b - a)
		});
	},

	async movePlaylistEntry(cred, id, { from, to, songId, count }) {
		// Subsonic cannot move an entry. `createPlaylist` with a `playlistId`
		// replaces a playlist's entries, so the whole playlist is written back in
		// the new order. It is read again first and refused if it is not what the
		// page showed: a rewrite from a stale list would undo changes made since.
		const body = await call<{ playlist?: Record<string, any> }>(cred, 'getPlaylist.view', { id });
		const entries = asArray(body.playlist?.entry as Record<string, any>[]).map((entry) => String(entry.id));
		if (!body.playlist) throw new UpstreamError('Playlist not found', 404, 'not_found');
		if (entries.length !== count || entries[from] !== songId || to < 0 || to >= entries.length) {
			throw new UpstreamError('The playlist changed since it was loaded', 409, 'conflict');
		}
		// The rewrite keeps only what the read listed. Navidrome leaves out of
		// `getPlaylist` an entry whose file is missing, and on 0.58 and later one
		// from a library the account cannot see, so a move deleted those. Its
		// `songCount` counts them, and a playlist where the two differ is not
		// rewritten.
		const listed = numberOrNull(body.playlist.songCount);
		if (listed !== null && listed !== entries.length) {
			throw new UpstreamError(
				'This playlist holds tracks the music server does not list here; reorder it in the music server',
				409,
				'conflict'
			);
		}
		const [moved] = entries.splice(from, 1);
		entries.splice(to, 0, moved);
		// 150 ids is about 5KB of address; past that it goes as a form. See `call`.
		if (entries.length <= 150) await call(cred, 'createPlaylist.view', { playlistId: id, songId: entries });
		else await call(cred, 'createPlaylist.view', {}, { playlistId: id, songId: entries });

		// An entry another client added between the read and the write is lost
		// by the rewrite, which Subsonic cannot make one step. It is reported.
		const after = await call<{ playlist?: Record<string, any> }>(cred, 'getPlaylist.view', { id });
		const written = asArray(after.playlist?.entry as Record<string, any>[]).map((entry) => String(entry.id));
		if (written.length !== entries.length || written.some((entry, i) => entry !== entries[i])) {
			throw new UpstreamError('The playlist changed while it was being saved; reload it', 409, 'conflict');
		}
	},

	async deletePlaylist(cred, id) {
		await call(cred, 'deletePlaylist.view', { id });
	},

	async reportPlayback(cred, report: PlaybackReport) {
		// Subsonic has no progress channel. `submission=false` marks the track as
		// now-playing, `true` records a play.
		if (report.event === 'progress') return;
		if (report.event === 'stop' && !report.completed) return;
		await call(cred, 'scrobble.view', {
			id: report.songId,
			submission: report.event === 'stop' ? 'true' : 'false',
			// Milliseconds, as the API takes them. Without it the server dates the
			// play as the request arrives.
			time: report.event === 'stop' ? report.at : undefined
		});
	},

	async getPlayedSongs(cred) {
		const played: { song: Song; playedAt: number }[] = [];
		// The whole library a page at a time, since no call lists played songs
		// alone. 500 is the most Navidrome returns in one page.
		for (let offset = 0; ; offset += PLAYED_PAGE) {
			const body = await call<{ searchResult3?: Record<string, any> }>(cred, 'search3.view', {
				query: '',
				songCount: PLAYED_PAGE,
				songOffset: offset,
				albumCount: 0,
				artistCount: 0
			});
			const songs = asArray(body.searchResult3?.song as Record<string, any>[]);
			for (const raw of songs) {
				const at = typeof raw.played === 'string' ? Date.parse(raw.played) : NaN;
				if (Number.isFinite(at)) played.push({ song: toSong(raw), playedAt: at });
			}
			if (songs.length < PLAYED_PAGE) return played;
		}
	},

	async openStream(cred, songId, req: StreamRequest, transcode): Promise<UpstreamResponse> {
		// `format=raw` with `maxBitRate=0` asks Navidrome for the original file.
		// A named format and a bitrate ask it to convert. Both values come from
		// an allowlist in `settings.ts` and go through `URLSearchParams`.
		//
		// Asked for an estimated length, Navidrome declares one worked out from
		// the bitrate and closes the connection when the transcode comes to
		// another size. Against 0.64.2 at 128kbps, first requests for an MP3, an
		// Opus and an AAC transcode each ended short of the declared length
		// (2911365 of 2980905 bytes for the MP3), and the same three asked
		// without it arrived whole. A read that has to reach the end
		// (`transcodes.ts`) does not ask for one.
		const url = endpoint(cred, 'stream.view', {
			id: songId,
			format: transcode ? transcode.codec : 'raw',
			maxBitRate: transcode ? transcode.bitrateKbps : 0,
			estimateContentLength: req.whole ? 'false' : 'true'
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
