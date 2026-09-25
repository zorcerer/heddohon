/**
 * Jellyfin adapter.
 *
 * Unlike Subsonic, Jellyfin issues a long-lived access token at login, so the
 * password is used exactly once and then discarded — only the token is sealed
 * and stored. Quick Connect ends at the same token without a password at all.
 */
import { upstreamFor } from '../config';
import {
	UpstreamError,
	assertSafeId,
	forwardRequestHeaders,
	upstreamFetch,
	upstreamUrl
} from './http';

/**
 * An id as a path segment. `encodeURIComponent` alone is not enough — it leaves
 * `..` intact, which `new URL()` then resolves upward — so every interpolation
 * goes through the guard as well as the encoder.
 */
const seg = (id: string) => encodeURIComponent(assertSafeId(id));

/**
 * A genre id for the `GenreIds` query parameter. Jellyfin reads that as a
 * comma-separated list, so an id is held to the GUID shape the server issues
 * and one request cannot widen itself to several genres.
 */
function genreIdOf(id: string): string {
	if (!/^[0-9a-fA-F-]{32,36}$/.test(id)) throw new UpstreamError('Not found', 404, 'not_found');
	return id;
}
import type {
	MediaBackend,
	PlaybackReport,
	QuickConnect,
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
	Genre,
	Playlist,
	PlaylistDetail,
	LyricLine,
	Lyrics,
	SearchResults,
	Song,
	StarKind
} from '$lib/types';
import { randomUUID } from 'node:crypto';
import { APP_VERSION } from '../version';

const CLIENT = 'Heddohon';
// From `package.json`. It was a literal here and had to be bumped by hand with
// every release, which two release commits did separately.
const CLIENT_VERSION = APP_VERSION;

/** Fields Jellyfin only returns when explicitly asked for. */
const ITEM_FIELDS = 'Genres,DateCreated,ChildCount,ParentId,PrimaryImageAspectRatio';
const SONG_FIELDS = `${ITEM_FIELDS},MediaSources`;

function creds(cred: StoredCredential) {
	if (cred.kind !== 'jellyfin') throw new Error('Wrong credential kind for the Jellyfin backend');
	return cred;
}

/**
 * Jellyfin identifies clients through this header. The device id is generated
 * per account at login and kept with the credential so the server sees a stable
 * device rather than a new one on every request.
 */
function authHeader(deviceId: string, token?: string): string {
	const parts = [
		`Client="${CLIENT}"`,
		`Device="${CLIENT}"`,
		`DeviceId="${deviceId}"`,
		`Version="${CLIENT_VERSION}"`
	];
	if (token) parts.push(`Token="${token}"`);
	return `MediaBrowser ${parts.join(', ')}`;
}

function headersFor(cred: StoredCredential): Record<string, string> {
	const { token, deviceId } = creds(cred);
	return {
		authorization: authHeader(deviceId, token),
		accept: 'application/json'
	};
}

function base(): string {
	return upstreamFor('jellyfin').url;
}

/**
 * The container each transcoded codec is delivered in. Opus in Ogg and AAC in
 * ADTS are what Jellyfin produces for these and what browsers decode; naming
 * the container leaves nothing for either end to guess at.
 */
const TRANSCODE_CONTAINERS: Record<'mp3' | 'opus' | 'aac', string> = {
	mp3: 'mp3',
	opus: 'ogg',
	aac: 'aac'
};

async function call<T>(
	cred: StoredCredential,
	path: string,
	params: Record<string, string | number | undefined> = {}
): Promise<T> {
	const response = await upstreamFetch(upstreamUrl(base(), path, params), {
		headers: headersFor(cred)
	});
	if (response.status === 401) {
		throw new UpstreamError('The Jellyfin session has expired. Please sign in again.', 401, 'auth');
	}
	if (response.status === 404) throw new UpstreamError('Not found', 404, 'not_found');
	if (!response.ok) throw new UpstreamError(`Jellyfin returned HTTP ${response.status}`, 502);
	if (response.status === 204) return undefined as T;
	try {
		return (await response.json()) as T;
	} catch {
		throw new UpstreamError('Jellyfin returned a response that was not JSON', 502, 'protocol');
	}
}

async function post(
	cred: StoredCredential,
	path: string,
	body?: unknown,
	params: Record<string, string | number | undefined> = {},
	method: 'POST' | 'DELETE' = 'POST'
): Promise<void> {
	const response = await upstreamFetch(upstreamUrl(base(), path, params), {
		method,
		headers: { ...headersFor(cred), 'content-type': 'application/json' },
		body: body === undefined ? undefined : JSON.stringify(body)
	});
	if (!response.ok && response.status !== 204) {
		throw new UpstreamError(`Jellyfin returned HTTP ${response.status}`, 502);
	}
	// Drain so the connection can be reused.
	await response.arrayBuffer().catch(() => undefined);
}

interface JellyfinItem {
	Id: string;
	Name?: string;
	AlbumId?: string;
	Album?: string;
	AlbumArtist?: string;
	AlbumArtists?: { Id: string; Name: string }[];
	ArtistItems?: { Id: string; Name: string }[];
	Artists?: string[];
	RunTimeTicks?: number;
	IndexNumber?: number;
	ParentIndexNumber?: number;
	ProductionYear?: number;
	Genres?: string[];
	ImageTags?: Record<string, string>;
	AlbumPrimaryImageTag?: string;
	UserData?: { IsFavorite?: boolean; PlayCount?: number; PlaybackPositionTicks?: number };
	ChildCount?: number;
	DateCreated?: string;
	Overview?: string;
	/** On genres, with `Fields=ItemCounts`. */
	AlbumCount?: number;
	SongCount?: number;
	/** Track loudness correction in dB, from Jellyfin 10.9's normalisation scan. */
	NormalizationGain?: number;
	MediaSources?: JellyfinMediaSource[];
	Type?: string;
	/** Present only on /Playlists/{id}/Items — identifies the entry, not the song. */
	PlaylistItemId?: string;
}

interface JellyfinMediaSource {
	Container?: string;
	Size?: number;
	Bitrate?: number;
	MediaStreams?: {
		Type?: string;
		Codec?: string;
		BitDepth?: number;
		SampleRate?: number;
		Channels?: number;
		BitRate?: number;
	}[];
}

/** Jellyfin measures time in 100-nanosecond ticks. */
const TICKS_PER_SECOND = 10_000_000;

function ticksToSeconds(ticks: number | undefined): number {
	return ticks ? Math.round(ticks / TICKS_PER_SECOND) : 0;
}

const LOSSLESS = new Set(['flac', 'alac', 'wav', 'aiff', 'ape', 'wavpack', 'dsd', 'pcm', 'truehd']);

function quality(item: JellyfinItem): AudioQuality {
	const source = item.MediaSources?.[0];
	const audio = source?.MediaStreams?.find((s) => s.Type === 'Audio');
	const format = (source?.Container ?? audio?.Codec ?? null)?.toLowerCase() ?? null;
	const codec = (audio?.Codec ?? format ?? '').toLowerCase();
	const lossless = LOSSLESS.has(codec) || LOSSLESS.has(format ?? '');
	const bitDepth = audio?.BitDepth ?? null;
	const sampleRateHz = audio?.SampleRate ?? null;
	const bitrate = audio?.BitRate ?? source?.Bitrate ?? null;
	return {
		format,
		// Jellyfin reports bits per second; the UI works in kbps.
		bitrateKbps: bitrate ? Math.round(bitrate / 1000) : null,
		bitDepth,
		sampleRateHz,
		channels: audio?.Channels ?? null,
		sizeBytes: source?.Size ?? null,
		lossless,
		highResolution: lossless && ((bitDepth ?? 16) > 16 || (sampleRateHz ?? 44100) > 48000)
	};
}

/**
 * Cover art in Jellyfin hangs off an item id, not a separate art id. We encode
 * `itemId` (optionally with an image tag) as the portable cover handle so the
 * rest of the app can stay backend-agnostic.
 */
function coverHandle(item: JellyfinItem): string | null {
	if (item.ImageTags?.Primary) return `${item.Id}:${item.ImageTags.Primary}`;
	if (item.AlbumPrimaryImageTag && item.AlbumId) return `${item.AlbumId}:${item.AlbumPrimaryImageTag}`;
	if (item.AlbumId) return item.AlbumId;
	return item.Id;
}

function toSong(item: JellyfinItem): Song {
	const artist = item.ArtistItems?.[0] ?? item.AlbumArtists?.[0];
	return {
		id: item.Id,
		title: item.Name ?? 'Unknown title',
		albumId: item.AlbumId ?? null,
		album: item.Album ?? null,
		artistId: artist?.Id ?? null,
		artist: item.Artists?.join(', ') ?? artist?.Name ?? null,
		albumArtist: item.AlbumArtist ?? null,
		duration: ticksToSeconds(item.RunTimeTicks),
		track: item.IndexNumber ?? null,
		disc: item.ParentIndexNumber ?? null,
		year: item.ProductionYear ?? null,
		genre: item.Genres?.[0] ?? null,
		coverArt: coverHandle(item),
		starred: Boolean(item.UserData?.IsFavorite),
		// Jellyfin records that an item is a favourite and not when it became
		// one, so the favourites page offers no "recently starred" order here.
		starredAt: null,
		playCount: item.UserData?.PlayCount ?? null,
		quality: quality(item),
		// Jellyfin 10.9 and later measure each track against its own loudness
		// target and report the correction as one number; there is no peak.
		replayGain:
			typeof item.NormalizationGain === 'number'
				? { trackGain: item.NormalizationGain, albumGain: null, trackPeak: null, albumPeak: null }
				: null
	};
}

function toAlbum(item: JellyfinItem): Album {
	const artist = item.AlbumArtists?.[0] ?? item.ArtistItems?.[0];
	const created = item.DateCreated ? Date.parse(item.DateCreated) : NaN;
	return {
		id: item.Id,
		name: item.Name ?? 'Unknown album',
		artistId: artist?.Id ?? null,
		artist: item.AlbumArtist ?? artist?.Name ?? null,
		year: item.ProductionYear ?? null,
		genre: item.Genres?.[0] ?? null,
		songCount: item.ChildCount ?? null,
		duration: ticksToSeconds(item.RunTimeTicks) || null,
		coverArt: coverHandle(item),
		starred: Boolean(item.UserData?.IsFavorite),
		starredAt: null,
		createdAt: Number.isFinite(created) ? created : null
	};
}

function toArtist(item: JellyfinItem): Artist {
	return {
		id: item.Id,
		name: item.Name ?? 'Unknown artist',
		albumCount: item.ChildCount ?? null,
		coverArt: coverHandle(item),
		starred: Boolean(item.UserData?.IsFavorite),
		starredAt: null
	};
}

function toPlaylist(item: JellyfinItem): Playlist {
	const created = item.DateCreated ? Date.parse(item.DateCreated) : NaN;
	// Jellyfin does not report a modification time for playlists, so the two
	// dates are the same; the playlist sort falls back accordingly.
	return {
		id: item.Id,
		name: item.Name ?? 'Untitled playlist',
		comment: item.Overview ?? null,
		songCount: item.ChildCount ?? null,
		duration: ticksToSeconds(item.RunTimeTicks) || null,
		coverArt: coverHandle(item),
		owner: null,
		isPublic: true,
		createdAt: Number.isFinite(created) ? created : null,
		changedAt: Number.isFinite(created) ? created : null
	};
}

interface ItemsResponse {
	Items?: JellyfinItem[];
	TotalRecordCount?: number;
}

const SORT_BY: Record<AlbumQuery['sort'], { sortBy: string; sortOrder: string }> = {
	recentlyAdded: { sortBy: 'DateCreated,SortName', sortOrder: 'Descending' },
	recentlyPlayed: { sortBy: 'DatePlayed,SortName', sortOrder: 'Descending' },
	mostPlayed: { sortBy: 'PlayCount,SortName', sortOrder: 'Descending' },
	alphabetical: { sortBy: 'SortName', sortOrder: 'Ascending' },
	byArtist: { sortBy: 'AlbumArtist,SortName', sortOrder: 'Ascending' },
	byYear: { sortBy: 'ProductionYear,SortName', sortOrder: 'Descending' },
	random: { sortBy: 'Random', sortOrder: 'Ascending' },
	starred: { sortBy: 'SortName', sortOrder: 'Ascending' }
};

/**
 * Reads an `AuthenticationResult` into what gets stored. `AuthenticateByName`
 * and `AuthenticateWithQuickConnect` both return this shape, so the two routes
 * end at the same credential.
 */
async function loginResult(
	response: Response,
	deviceId: string,
	fallbackUsername: string
): Promise<{ credential: StoredCredential; remoteUserId: string }> {
	const payload = (await response.json().catch(() => null)) as {
		AccessToken?: string;
		User?: { Id?: string; Name?: string };
	} | null;
	if (!payload?.AccessToken || !payload.User?.Id) {
		throw new UpstreamError('Jellyfin did not return an access token', 502, 'protocol');
	}
	// The account row is keyed on this name, so an empty one is refused rather
	// than stored.
	const username = payload.User.Name || fallbackUsername;
	if (!username) {
		throw new UpstreamError('Jellyfin did not name the signed-in user', 502, 'protocol');
	}

	return {
		credential: {
			kind: 'jellyfin',
			username,
			token: payload.AccessToken,
			userId: payload.User.Id,
			deviceId
		},
		remoteUserId: payload.User.Id
	};
}

/**
 * How long a Quick Connect availability answer is reused. The sign-in page asks
 * on every render, and anybody can load it without signing in, so asking the
 * music server each time would let a visitor drive requests at it by reloading.
 */
const QUICK_CONNECT_CACHE_MS = 60_000;
const QUICK_CONNECT_PROBE_MS = 3_000;
let quickConnectCache: { enabled: boolean; at: number } | null = null;
let quickConnectProbe: Promise<boolean> | null = null;

async function probeQuickConnect(): Promise<boolean> {
	let enabled = false;
	try {
		// The sign-in page waits on this answer. The shared upstream timeout is
		// 20 seconds by default, which is how long the page would take to render
		// with the music server down.
		const response = await upstreamFetch(upstreamUrl(base(), '/QuickConnect/Enabled'), {
			headers: { accept: 'application/json' },
			signal: AbortSignal.timeout(QUICK_CONNECT_PROBE_MS)
		});
		enabled = response.ok && (await response.json().catch(() => false)) === true;
	} catch {
		// An unreachable server offers nothing. The failure is cached with the
		// rest so that a server that is down is not asked again on every render.
	}
	quickConnectCache = { enabled, at: Date.now() };
	return enabled;
}

/**
 * Jellyfin's Quick Connect, against the 10.10 API.
 *
 * The anonymous calls carry the same `MediaBrowser` header as a password
 * sign-in, without a token. Jellyfin records the device named in it when the
 * request is initiated and issues the eventual token to that device, so the
 * caller passes one device id through every step.
 */
const quickConnect: QuickConnect = {
	async enabled() {
		const cached = quickConnectCache;
		if (cached && Date.now() - cached.at < QUICK_CONNECT_CACHE_MS) return cached.enabled;
		// Renders that arrive while a probe is out wait for it rather than each
		// sending their own.
		quickConnectProbe ??= probeQuickConnect().finally(() => {
			quickConnectProbe = null;
		});
		return quickConnectProbe;
	},

	async initiate(deviceId) {
		const response = await upstreamFetch(upstreamUrl(base(), '/QuickConnect/Initiate'), {
			method: 'POST',
			headers: { authorization: authHeader(deviceId), accept: 'application/json' }
		});
		// 401 is Jellyfin saying Quick Connect is off. The cached answer is dropped
		// so the sign-in page stops offering it on the next render.
		if (response.status === 401) {
			quickConnectCache = null;
			throw new UpstreamError('Quick Connect is turned off on this server', 401, 'unavailable');
		}
		if (!response.ok) throw new UpstreamError(`Jellyfin returned HTTP ${response.status}`, 502);

		const payload = (await response.json().catch(() => null)) as {
			Secret?: string;
			Code?: string;
		} | null;
		if (!payload?.Secret || !payload.Code) {
			throw new UpstreamError('Jellyfin did not return a Quick Connect code', 502, 'protocol');
		}
		return { secret: payload.Secret, code: payload.Code };
	},

	async state(secret, deviceId) {
		const response = await upstreamFetch(upstreamUrl(base(), '/QuickConnect/Connect', { secret }), {
			headers: { authorization: authHeader(deviceId), accept: 'application/json' }
		});
		// 404 is an unknown secret, which is what an expired one becomes. 401 is
		// Quick Connect having been turned off since the request started.
		if (response.status === 404 || response.status === 401) return 'expired';
		if (!response.ok) throw new UpstreamError(`Jellyfin returned HTTP ${response.status}`, 502);

		const payload = (await response.json().catch(() => null)) as { Authenticated?: boolean } | null;
		if (!payload) {
			throw new UpstreamError('Jellyfin returned a response that was not JSON', 502, 'protocol');
		}
		return payload.Authenticated === true ? 'authorized' : 'waiting';
	},

	async authenticate(secret, deviceId) {
		const response = await upstreamFetch(upstreamUrl(base(), '/Users/AuthenticateWithQuickConnect'), {
			method: 'POST',
			headers: {
				authorization: authHeader(deviceId),
				'content-type': 'application/json',
				accept: 'application/json'
			},
			body: JSON.stringify({ Secret: secret })
		});
		// Jellyfin refuses a secret that is unknown, expired or not yet approved
		// with a 4xx. None of those is a wrong password, so none of them is `auth`.
		if (response.status >= 400 && response.status < 500) {
			throw new UpstreamError('The Quick Connect request is no longer valid', 400, 'protocol');
		}
		if (!response.ok) throw new UpstreamError(`Jellyfin returned HTTP ${response.status}`, 502);

		// Nobody typed a name on this route, so there is no fallback for it.
		return loginResult(response, deviceId, '');
	}
};

export const jellyfinBackend: MediaBackend = {
	kind: 'jellyfin',

	async login(username, password) {
		const deviceId = randomUUID();
		const response = await upstreamFetch(upstreamUrl(base(), '/Users/AuthenticateByName'), {
			method: 'POST',
			headers: {
				authorization: authHeader(deviceId),
				'content-type': 'application/json',
				accept: 'application/json'
			},
			body: JSON.stringify({ Username: username, Pw: password })
		});

		if (response.status === 401) {
			throw new UpstreamError('Invalid username or password', 401, 'auth');
		}
		if (!response.ok) {
			throw new UpstreamError(`Jellyfin returned HTTP ${response.status}`, 502);
		}

		return loginResult(response, deviceId, username);
	},

	quickConnect,

	async verify(cred) {
		try {
			await call(cred, `/Users/${seg(creds(cred).userId)}`);
			return true;
		} catch {
			return false;
		}
	},

	/**
	 * Jellyfin states this on the user record, which `verify` above already
	 * fetches, so reading it costs one request and no special permission.
	 */
	async isAdmin(cred) {
		try {
			const user = await call<{ Policy?: { IsAdministrator?: boolean } }>(
				cred,
				`/Users/${seg(creds(cred).userId)}`
			);
			const role = user?.Policy?.IsAdministrator;
			return typeof role === 'boolean' ? role : null;
		} catch {
			return null;
		}
	},

	async getAlbums(cred, query) {
		const { userId } = creds(cred);
		const sort = SORT_BY[query.sort];
		const body = await call<ItemsResponse>(cred, '/Items', {
			userId,
			IncludeItemTypes: 'MusicAlbum',
			Recursive: 'true',
			Fields: ITEM_FIELDS,
			SortBy: sort.sortBy,
			SortOrder: sort.sortOrder,
			Limit: query.limit,
			StartIndex: query.offset,
			Filters: query.sort === 'starred' ? 'IsFavorite' : undefined
		});
		return (body.Items ?? []).map(toAlbum);
	},

	async getGenres(cred): Promise<Genre[]> {
		const { userId } = creds(cred);
		const body = await call<ItemsResponse>(cred, '/MusicGenres', {
			userId,
			SortBy: 'SortName',
			SortOrder: 'Ascending',
			Fields: 'ItemCounts',
			Recursive: 'true'
		});
		return (body.Items ?? [])
			.filter((item) => item.Id && item.Name && (item.AlbumCount ?? 1) > 0)
			.map((item) => ({
				id: item.Id,
				name: item.Name ?? '',
				albumCount: item.AlbumCount ?? null,
				songCount: item.SongCount ?? null
			}));
	},

	async getGenreAlbums(cred, genreId, limit, offset) {
		const { userId } = creds(cred);
		const body = await call<ItemsResponse>(cred, '/Items', {
			userId,
			GenreIds: genreIdOf(genreId),
			IncludeItemTypes: 'MusicAlbum',
			Recursive: 'true',
			Fields: ITEM_FIELDS,
			SortBy: 'SortName',
			SortOrder: 'Ascending',
			Limit: limit,
			StartIndex: offset
		});
		return (body.Items ?? []).map(toAlbum);
	},

	async getGenreSongs(cred, genreId, limit) {
		const { userId } = creds(cred);
		const body = await call<ItemsResponse>(cred, '/Items', {
			userId,
			GenreIds: genreIdOf(genreId),
			IncludeItemTypes: 'Audio',
			Recursive: 'true',
			Fields: SONG_FIELDS,
			SortBy: 'Random',
			Limit: Math.min(limit, 500)
		});
		return (body.Items ?? []).map(toSong);
	},

	async getAlbum(cred, id): Promise<AlbumDetail> {
		const { userId } = creds(cred);
		const [album, tracks] = await Promise.all([
			call<JellyfinItem>(cred, `/Items/${seg(id)}`, { userId, Fields: ITEM_FIELDS }),
			call<ItemsResponse>(cred, '/Items', {
				userId,
				ParentId: id,
				IncludeItemTypes: 'Audio',
				Recursive: 'true',
				Fields: SONG_FIELDS,
				SortBy: 'ParentIndexNumber,IndexNumber,SortName',
				SortOrder: 'Ascending'
			})
		]);
		return { ...toAlbum(album), songs: (tracks.Items ?? []).map(toSong) };
	},

	/**
	 * Every album artist, from two `/Items` queries rather than from
	 * `/Artists/AlbumArtists`.
	 *
	 * Measured on Jellyfin 12.1.0 with 5000 album artists, each warmed and run
	 * five times: `/Artists/AlbumArtists` took 9.8 to 11.2s per request whatever
	 * `Limit` was, 100 or 500 or 2000 or none, and whichever parameters were
	 * dropped, so paging it would pay that once per page. `/Items` answered
	 * every `MusicArtist` in 0.28s and every `MusicAlbum` in 0.30 to 0.33s.
	 *
	 * The artist query alone also returns artists that only appear on tracks
	 * (a guest on one song, each name on a compilation), which the album-artist
	 * endpoint leaves out: 23 extra in the measurement above. They are removed
	 * by keeping only the artists some album names as an album artist, and the
	 * same pass counts each one's albums, which Jellyfin does not report on an
	 * artist.
	 *
	 * This replaced a single request with `Limit: 2000`, which left every album
	 * artist after the 2000th by sort name off the artists page.
	 */
	async getArtists(cred) {
		const { userId } = creds(cred);
		const [artists, albums] = await Promise.all([
			call<ItemsResponse>(cred, '/Items', {
				userId,
				IncludeItemTypes: 'MusicArtist',
				Recursive: 'true',
				Fields: ITEM_FIELDS,
				SortBy: 'SortName',
				SortOrder: 'Ascending',
				EnableTotalRecordCount: 'false'
			}),
			call<ItemsResponse>(cred, '/Items', {
				userId,
				IncludeItemTypes: 'MusicAlbum',
				Recursive: 'true',
				EnableImages: 'false',
				EnableUserData: 'false',
				EnableTotalRecordCount: 'false'
			})
		]);

		const albumCounts = new Map<string, number>();
		for (const album of albums.Items ?? []) {
			for (const artist of album.AlbumArtists ?? []) {
				albumCounts.set(artist.Id, (albumCounts.get(artist.Id) ?? 0) + 1);
			}
		}
		return (artists.Items ?? [])
			.filter((item) => albumCounts.has(item.Id))
			.map((item) => ({ ...toArtist(item), albumCount: albumCounts.get(item.Id) ?? null }));
	},

	async getArtist(cred, id): Promise<ArtistDetail> {
		const { userId } = creds(cred);
		const [artist, albums, top] = await Promise.all([
			call<JellyfinItem>(cred, `/Items/${seg(id)}`, { userId, Fields: ITEM_FIELDS }),
			call<ItemsResponse>(cred, '/Items', {
				userId,
				AlbumArtistIds: id,
				IncludeItemTypes: 'MusicAlbum',
				Recursive: 'true',
				Fields: ITEM_FIELDS,
				SortBy: 'ProductionYear,SortName',
				SortOrder: 'Descending'
			}),
			call<ItemsResponse>(cred, '/Items', {
				userId,
				ArtistIds: id,
				IncludeItemTypes: 'Audio',
				Recursive: 'true',
				Fields: SONG_FIELDS,
				SortBy: 'PlayCount',
				SortOrder: 'Descending',
				Limit: 10
			})
		]);
		return {
			...toArtist(artist),
			albums: (albums.Items ?? []).map(toAlbum),
			biography: artist.Overview?.trim() || null,
			topSongs: (top.Items ?? []).map(toSong)
		};
	},

	async getArtistAlbums(cred, artistId): Promise<Album[]> {
		const { userId } = creds(cred);
		const body = await call<ItemsResponse>(cred, '/Items', {
			userId,
			AlbumArtistIds: artistId,
			IncludeItemTypes: 'MusicAlbum',
			Recursive: 'true',
			Fields: ITEM_FIELDS,
			SortBy: 'ProductionYear,SortName',
			SortOrder: 'Descending'
		});
		return (body.Items ?? []).map(toAlbum);
	},

	async getSimilarArtists(cred, artistId, limit): Promise<Artist[]> {
		const { userId } = creds(cred);
		const body = await call<ItemsResponse>(cred, `/Artists/${seg(artistId)}/Similar`, {
			userId,
			Fields: ITEM_FIELDS,
			limit
		});
		return (body.Items ?? []).map(toArtist);
	},

	async getSimilarAlbums(cred, albumId, artistId, limit): Promise<Album[]> {
		// Jellyfin computes this from its own metadata (genres, tags, people), so
		// unlike the Subsonic path it needs no external service.
		const { userId } = creds(cred);
		const body = await call<ItemsResponse>(cred, `/Albums/${seg(albumId)}/Similar`, {
			userId,
			Fields: ITEM_FIELDS,
			// The endpoint takes this, and the album page shows the artist's own
			// catalogue in a section above the shelf.
			excludeArtistIds: artistId ?? undefined,
			limit
		});
		// The seed album comes back in its own similar list, and the exclusion
		// above is checked again here rather than trusted: it is a query
		// parameter, and a server that ignores it would put the artist's records
		// on the page twice.
		return (body.Items ?? [])
			.filter((item) => item.Id !== albumId)
			.map(toAlbum)
			.filter((album) => artistId === null || album.artistId !== artistId);
	},

	async getPlaylists(cred) {
		const { userId } = creds(cred);
		const body = await call<ItemsResponse>(cred, '/Items', {
			userId,
			IncludeItemTypes: 'Playlist',
			Recursive: 'true',
			Fields: ITEM_FIELDS,
			SortBy: 'SortName',
			SortOrder: 'Ascending'
		});
		// Jellyfin playlists can hold video too; the music player only shows audio ones.
		return (body.Items ?? []).map(toPlaylist);
	},

	async getPlaylist(cred, id): Promise<PlaylistDetail> {
		const { userId } = creds(cred);
		const [playlist, items] = await Promise.all([
			call<JellyfinItem>(cred, `/Items/${seg(id)}`, { userId, Fields: ITEM_FIELDS }),
			call<ItemsResponse>(cred, `/Playlists/${seg(id)}/Items`, {
				userId,
				Fields: SONG_FIELDS
			})
		]);
		return { ...toPlaylist(playlist), songs: (items.Items ?? []).map(toSong) };
	},

	async getSongs(cred, ids) {
		if (ids.length === 0) return [];
		const { userId } = creds(cred);
		const body = await call<ItemsResponse>(cred, '/Items', {
			userId,
			Ids: ids.join(','),
			Fields: SONG_FIELDS
		});
		const byId = new Map((body.Items ?? []).map((item) => [item.Id, toSong(item)]));
		// Preserve the caller's ordering — queue restoration depends on it.
		return ids.map((id) => byId.get(id)).filter((song): song is Song => song !== undefined);
	},

	async getRandomSongs(cred, limit) {
		const { userId } = creds(cred);
		const body = await call<ItemsResponse>(cred, '/Items', {
			userId,
			IncludeItemTypes: 'Audio',
			Recursive: 'true',
			Fields: SONG_FIELDS,
			SortBy: 'Random',
			Limit: limit
		});
		return (body.Items ?? []).map(toSong);
	},

	/**
	 * Every favourite, of each kind.
	 *
	 * This was limited to 200 of each, which left the rest off the favourites
	 * page and out of "play favourites". Measured on Jellyfin 12.1.0: 2500
	 * favourite songs took 2.2s and 5.5MB uncapped, 1.5s without
	 * `MediaSources`, which the track list's quality badge reads. The result is
	 * held for 30 seconds per account (`listings.ts`), and the home page
	 * streams its eight rather than waiting for them.
	 */
	async getStarred(cred): Promise<SearchResults> {
		const { userId } = creds(cred);
		const fetchFavourites = (types: string, fields: string) =>
			call<ItemsResponse>(cred, '/Items', {
				userId,
				IncludeItemTypes: types,
				Recursive: 'true',
				Filters: 'IsFavorite',
				Fields: fields,
				SortBy: 'SortName',
				EnableTotalRecordCount: 'false'
			});
		const [songs, albums, artists] = await Promise.all([
			fetchFavourites('Audio', SONG_FIELDS),
			fetchFavourites('MusicAlbum', ITEM_FIELDS),
			fetchFavourites('MusicArtist', ITEM_FIELDS)
		]);
		return {
			songs: (songs.Items ?? []).map(toSong),
			albums: (albums.Items ?? []).map(toAlbum),
			artists: (artists.Items ?? []).map(toArtist)
		};
	},

	async search(cred, query, limit): Promise<SearchResults> {
		const { userId } = creds(cred);
		const search = (types: string, fields: string) =>
			call<ItemsResponse>(cred, '/Items', {
				userId,
				searchTerm: query,
				IncludeItemTypes: types,
				Recursive: 'true',
				Fields: fields,
				Limit: limit
			});
		const [songs, albums, artists] = await Promise.all([
			search('Audio', SONG_FIELDS),
			search('MusicAlbum', ITEM_FIELDS),
			search('MusicArtist', ITEM_FIELDS)
		]);
		return {
			songs: (songs.Items ?? []).map(toSong),
			albums: (albums.Items ?? []).map(toAlbum),
			artists: (artists.Items ?? []).map(toArtist)
		};
	},

	async setStarred(cred, id, _kind: StarKind, starred) {
		const { userId } = creds(cred);
		await post(
			cred,
			`/Users/${seg(userId)}/FavoriteItems/${seg(id)}`,
			undefined,
			{},
			starred ? 'POST' : 'DELETE'
		);
	},

	async getLyrics(cred, song): Promise<Lyrics | null> {
		// Jellyfin returns ticks, the same 100-nanosecond unit it uses everywhere
		// else, and omits Start entirely for unsynced lyrics.
		const body = await call<{
			Lyrics?: { Start?: number; Text?: string }[];
			Metadata?: { Artist?: string; Title?: string };
		}>(cred, `/Audio/${seg(song.id)}/Lyrics`).catch(() => null);

		const raw = body?.Lyrics ?? [];
		if (raw.length === 0) return null;

		const lines: LyricLine[] = raw.map((line) => ({
			timeMs: typeof line.Start === 'number' ? Math.round(line.Start / 10_000) : null,
			text: line.Text ?? ''
		}));

		return {
			synced: lines.every((line) => line.timeMs !== null),
			lines,
			artist: body?.Metadata?.Artist ?? song.artist,
			title: body?.Metadata?.Title ?? song.title
		};
	},

	async createPlaylist(cred, name, songIds) {
		const { userId } = creds(cred);
		const response = await upstreamFetch(upstreamUrl(base(), '/Playlists'), {
			method: 'POST',
			headers: { ...headersFor(cred), 'content-type': 'application/json' },
			body: JSON.stringify({ Name: name, Ids: songIds, UserId: userId, MediaType: 'Audio' })
		});
		if (!response.ok) throw new UpstreamError(`Jellyfin returned HTTP ${response.status}`, 502);
		const payload = (await response.json().catch(() => null)) as { Id?: string } | null;
		if (!payload?.Id) {
			throw new UpstreamError('Jellyfin did not return the new playlist', 502, 'protocol');
		}
		return payload.Id;
	},

	async renamePlaylist(cred, id, name) {
		await post(cred, `/Playlists/${seg(id)}`, { Name: name });
	},

	async addToPlaylist(cred, id, songIds) {
		if (songIds.length === 0) return;
		const { userId } = creds(cred);
		await post(cred, `/Playlists/${seg(id)}/Items`, undefined, {
			ids: songIds.join(','),
			userId
		});
	},

	async removeFromPlaylist(cred, id, indices) {
		if (indices.length === 0) return;
		const { userId } = creds(cred);

		// Jellyfin removes by an opaque per-entry id rather than by position, and
		// that id only exists on the playlist listing — so the caller's indices are
		// resolved against a fresh read of the playlist.
		const items = await call<ItemsResponse>(cred, `/Playlists/${seg(id)}/Items`, {
			userId
		});
		const entries = items.Items ?? [];
		const entryIds = indices
			.map((index) => entries[index]?.PlaylistItemId)
			.filter((entryId): entryId is string => typeof entryId === 'string');

		if (entryIds.length === 0) {
			throw new UpstreamError('Those playlist entries no longer exist', 404, 'not_found');
		}

		await post(
			cred,
			`/Playlists/${seg(id)}/Items`,
			undefined,
			{ entryIds: entryIds.join(',') },
			'DELETE'
		);
	},

	async deletePlaylist(cred, id) {
		/*
		 * Jellyfin has no playlist-scoped delete: `DELETE /Items/{id}` removes
		 * whatever that id is. Handed an album or a track id by a caller — and the
		 * id comes straight off the wire — it would delete that from the library,
		 * files included, for every user of the server, from a button labelled
		 * "delete playlist". Subsonic's `deletePlaylist.view` cannot do this, so
		 * the check belongs here rather than in the route.
		 */
		const item = await call<JellyfinItem>(cred, `/Items/${seg(id)}`, {
			userId: creds(cred).userId
		});
		if (item?.Type !== 'Playlist') {
			throw new UpstreamError('That is not a playlist.', 400, 'protocol');
		}
		await post(cred, `/Items/${seg(id)}`, undefined, {}, 'DELETE');
	},

	async reportPlayback(cred, report: PlaybackReport) {
		const { userId } = creds(cred);
		const positionTicks = Math.round(report.position * TICKS_PER_SECOND);
		const payload = {
			ItemId: report.songId,
			PositionTicks: positionTicks,
			IsPaused: false,
			PlayMethod: 'DirectPlay',
			UserId: userId
		};
		const path =
			report.event === 'start'
				? '/Sessions/Playing'
				: report.event === 'progress'
					? '/Sessions/Playing/Progress'
					: '/Sessions/Playing/Stopped';
		await post(cred, path, payload);
	},

	async openStream(cred, songId, req: StreamRequest, transcode): Promise<UpstreamResponse> {
		// `static=true` is Jellyfin's "give me the file on disk" switch: no
		// remuxing, no transcoding, no sample-rate conversion.
		//
		// Transcoding goes through `/universal` rather than through `stream` with
		// `static=false`. That endpoint is the one built to be handed a codec and
		// a ceiling and to work out the rest, and it is what Jellyfin's own
		// clients use; `stream` expects a profile negotiated through PlaybackInfo
		// first. The container is named as well as the codec: asked for a codec
		// alone, Jellyfin picks a container for it, and the pairing it picks is
		// not always one a browser will play.
		const { userId, deviceId } = creds(cred);
		const url = transcode
			? upstreamUrl(base(), `/Audio/${seg(songId)}/universal`, {
					UserId: userId,
					DeviceId: deviceId,
					AudioCodec: transcode.codec,
					Container: TRANSCODE_CONTAINERS[transcode.codec],
					TranscodingContainer: TRANSCODE_CONTAINERS[transcode.codec],
					TranscodingProtocol: 'http',
					MaxStreamingBitrate: transcode.bitrateKbps * 1000
				})
			: upstreamUrl(base(), `/Audio/${seg(songId)}/stream`, {
					static: 'true'
				});
		const response = await upstreamFetch(url, {
			method: req.method ?? 'GET',
			headers: { ...headersFor(cred), ...forwardRequestHeaders(req) },
			signal: req.signal
		});
		return { status: response.status, headers: response.headers, body: response.body };
	},

	async openCover(cred, coverId, size, req): Promise<UpstreamResponse> {
		const [itemId, tag] = coverId.split(':');
		const url = upstreamUrl(base(), `/Items/${seg(itemId)}/Images/Primary`, {
			maxWidth: size,
			maxHeight: size,
			quality: 90,
			tag: tag || undefined
		});
		const response = await upstreamFetch(url, {
			method: req.method ?? 'GET',
			headers: { ...headersFor(cred), ...forwardRequestHeaders(req) },
			signal: req.signal
		});
		return { status: response.status, headers: response.headers, body: response.body };
	}
};
