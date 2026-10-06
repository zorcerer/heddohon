import type {
	Album,
	AlbumDetail,
	AlbumQuery,
	Artist,
	ArtistDetail,
	BackendKind,
	Folder,
	Genre,
	Playlist,
	PlaylistDetail,
	Lyrics,
	SearchResults,
	Song,
	MixSeed,
	StarKind
} from '$lib/types';
import type { LastfmStart, ScrobblerLinks, ScrobblerService } from './navidrome';

/**
 * The secret material for one account, stored sealed in the database.
 *
 * Subsonic hashes the password with a per-request salt, so the plaintext has
 * to be recoverable. Jellyfin issues an access token, which is kept, and the
 * password is discarded when login succeeds.
 */
export type StoredCredential =
	| { kind: 'subsonic'; username: string; password: string }
	| { kind: 'jellyfin'; username: string; token: string; userId: string; deviceId: string };

export interface StreamRequest {
	/** Raw `Range` request header, forwarded verbatim so seeking works. */
	range?: string | null;
	/** Conditional request headers, forwarded so the browser cache stays useful. */
	ifNoneMatch?: string | null;
	ifModifiedSince?: string | null;
	method?: 'GET' | 'HEAD';
	signal?: AbortSignal;
	/** The body is read to its end here (`transcodes.ts`), so no estimated length is asked for. */
	whole?: boolean;
}

/**
 * What the music server is asked to produce instead of the file itself. Null,
 * the ordinary case, is the original bytes.
 */
export interface TranscodeRequest {
	codec: 'mp3' | 'opus' | 'aac';
	bitrateKbps: number;
}

export interface UpstreamResponse {
	status: number;
	headers: Headers;
	body: ReadableStream<Uint8Array> | null;
}

/** One entry of a playlist moved, and what the caller saw before moving it. */
/** A station as the music server lists it. `streamUrl` is whatever its administrator typed. */
export interface RadioStationSource {
	id: string;
	name: string;
	streamUrl: string;
	homePageUrl: string | null;
}

interface PlaylistMove {
	from: number;
	to: number;
	/** The song the caller saw at `from`. */
	songId: string;
	/** How many entries the caller saw. */
	count: number;
}

export interface PlaybackReport {
	songId: string;
	/** Seconds into the track. */
	position: number;
	event: 'start' | 'progress' | 'stop';
	/** Only meaningful for `stop`: whether the play should count as a scrobble. */
	completed?: boolean;
}

/**
 * Where a Quick Connect request stands upstream. `expired` covers every way
 * the secret stops being usable: the 10-minute window ran out, the server
 * restarted, or Quick Connect was turned off while it was pending.
 */
export type QuickConnectState = 'waiting' | 'authorized' | 'expired';

/**
 * Sign-in by a code the user approves from a device already signed in to the
 * music server. Only Jellyfin offers it, so the member is optional.
 *
 * `secret` is what the server exchanges for a token, so it is a credential
 * while the request is pending and stays on this server. The browser is shown
 * `code`. `deviceId` is chosen by the caller and must be the same on every
 * call for one request: the server issues the token to the device that asked.
 */
export interface QuickConnect {
	/** Whether the server has Quick Connect turned on. False on any failure. */
	enabled(): Promise<boolean>;
	initiate(deviceId: string): Promise<{ secret: string; code: string }>;
	state(secret: string, deviceId: string): Promise<QuickConnectState>;
	/** Exchanges an authorized secret for the same result `login` returns. */
	authenticate(
		secret: string,
		deviceId: string
	): Promise<{ credential: StoredCredential; remoteUserId: string | null }>;
}

/**
 * Linking the account to Last.fm and ListenBrainz on the music server, which
 * then scrobbles to them itself. Only Navidrome offers it, through its own
 * API, so the member is optional. On the Subsonic backend `status` answers
 * null for a server that is not Navidrome. See `backends/navidrome.ts`.
 */
interface Scrobblers {
	status(cred: StoredCredential): Promise<ScrobblerLinks | null>;
	/** False when ListenBrainz says the token is not valid. */
	linkListenBrainz(cred: StoredCredential, token: string): Promise<boolean>;
	unlink(cred: StoredCredential, service: ScrobblerService): Promise<void>;
	/** Null when the server has Last.fm turned off. */
	startLastfm(cred: StoredCredential): Promise<LastfmStart | null>;
	/** False when the music server refuses the token last.fm returned. */
	finishLastfm(linkToken: string, token: string): Promise<boolean>;
}

/**
 * Everything the app can ask of a music server. Implementations are stateless:
 * the caller passes the opened credential on every call, so decrypted secrets
 * live for one request.
 */
export interface MediaBackend {
	readonly kind: BackendKind;

	/** Verifies the credentials upstream and returns what should be stored. */
	login(username: string, password: string): Promise<{ credential: StoredCredential; remoteUserId: string | null }>;

	/** Present only where the server supports Quick Connect. */
	readonly quickConnect?: QuickConnect;

	/** Present only where the server can link Last.fm and ListenBrainz. */
	readonly scrobblers?: Scrobblers;

	/**
	 * Whether this account administers the music server, or null when the
	 * server does not say: a Subsonic server need not implement `getUser`, or
	 * may refuse it. Caching every cover (`coverfill.ts`) needs `true`. Nothing
	 * else an account may do depends on it.
	 */
	isAdmin(cred: StoredCredential): Promise<boolean | null>;

	getAlbums(cred: StoredCredential, query: AlbumQuery): Promise<Album[]>;
	getAlbum(cred: StoredCredential, id: string): Promise<AlbumDetail>;
	getArtists(cred: StoredCredential): Promise<Artist[]>;
	getArtist(cred: StoredCredential, id: string): Promise<ArtistDetail>;
	/**
	 * Every album credited to one artist, for the album page. `getArtist`
	 * returns these too, with a biography and top songs that cost a request
	 * each on Subsonic.
	 */
	getArtistAlbums(cred: StoredCredential, artistId: string): Promise<Album[]>;

	/**
	 * Albums the artist is on without being credited for them: a guest on one
	 * track, a song on a compilation. May include the artist's own albums,
	 * which the caller leaves out (`details.ts`): a plain Subsonic server does
	 * not say who an album is by from its tracks.
	 */
	getAppearsOn(cred: StoredCredential, artistId: string, artistName: string): Promise<Album[]>;

	/**
	 * Artists the music server suggests alongside this one. Subsonic servers
	 * read `similarArtist` from `getArtistInfo2`, which Navidrome fills from
	 * Last.fm and leaves empty without a Last.fm API key, so an empty array is
	 * a normal answer.
	 */
	getSimilarArtists(cred: StoredCredential, artistId: string, limit: number): Promise<Artist[]>;

	/**
	 * Albums to suggest alongside this one, without the album itself or
	 * anything else by `artistId`: the album page shows that catalogue in its
	 * own section.
	 *
	 * Subsonic has no album similarity: `getSimilarSongs2` takes an artist id
	 * and returns tracks, which are grouped into albums. Passing `artistId`
	 * saves the adapter a lookup. `like` is the album's genre and year, from
	 * which Subsonic fills a shelf the similar tracks leave short.
	 */
	getSimilarAlbums(
		cred: StoredCredential,
		albumId: string,
		artistId: string | null,
		limit: number,
		like?: { genre: string | null; year: number | null }
	): Promise<Album[]>;

	/**
	 * Up to `limit` songs the music server considers like a song, an album or
	 * an artist: an instant mix. Empty when it has none, which on Navidrome is
	 * everything unless an external agent (Last.fm and others) is configured.
	 * A song's mix starts with the song itself.
	 */
	getInstantMix(cred: StoredCredential, kind: MixSeed, id: string, limit: number): Promise<Song[]>;

	/** Every genre with at least one album, sorted by name. */
	getGenres(cred: StoredCredential): Promise<Genre[]>;
	/** Albums in one genre, by name, a page at a time. */
	getGenreAlbums(cred: StoredCredential, genreId: string, limit: number, offset: number): Promise<Album[]>;
	/** Up to `limit` songs from one genre in random order, for playing it. */
	getGenreSongs(cred: StoredCredential, genreId: string, limit: number): Promise<Song[]>;

	/**
	 * A folder of the library as it is on disk, or the top with `id` null. An
	 * id that is not a folder is `not_found`.
	 *
	 * Subsonic: `getMusicFolders` for the libraries, `getIndexes` for the first
	 * level of one, `getMusicDirectory` below that. Navidrome 0.55 and later
	 * answer from the folders on disk, earlier versions make up a tree of
	 * artists and albums. Jellyfin: the music libraries from `/UserViews`, then
	 * `/Items?ParentId=` (plain folders, and a folder of tracks as its album).
	 */
	getFolder(cred: StoredCredential, id: string | null): Promise<Folder>;

	getPlaylists(cred: StoredCredential): Promise<Playlist[]>;
	getPlaylist(cred: StoredCredential, id: string): Promise<PlaylistDetail>;
	getSongs(cred: StoredCredential, ids: string[]): Promise<Song[]>;
	getRandomSongs(cred: StoredCredential, limit: number): Promise<Song[]>;
	getStarred(cred: StoredCredential): Promise<SearchResults>;
	search(cred: StoredCredential, query: string, limit: number): Promise<SearchResults>;

	setStarred(cred: StoredCredential, id: string, kind: StarKind, starred: boolean): Promise<void>;

	/**
	 * Sets the listener's rating of a song or an album, 1 to 5, or clears it
	 * with 0. Subsonic's `setRating`, which Navidrome implements. Jellyfin keeps
	 * a like or a dislike and no scale, so the member is absent there and
	 * `rating` is null on everything it returns.
	 */
	setRating?(cred: StoredCredential, id: string, rating: number): Promise<void>;

	/**
	 * The internet radio stations the server keeps, each with its stream's
	 * address: Subsonic's `getInternetRadioStations`. Jellyfin has none, so the
	 * member is absent there and the Radio page is not offered.
	 */
	getRadioStations?(cred: StoredCredential): Promise<RadioStationSource[]>;

	/** Lyrics for one track, or null when the server has none. */
	getLyrics(cred: StoredCredential, song: Song): Promise<Lyrics | null>;

	/** Creates a playlist, optionally seeded with tracks. Returns the new id. */
	createPlaylist(cred: StoredCredential, name: string, songIds: string[]): Promise<string>;
	renamePlaylist(cred: StoredCredential, id: string, name: string): Promise<void>;
	addToPlaylist(cred: StoredCredential, id: string, songIds: string[]): Promise<void>;
	/**
	 * Removes entries by their position in the playlist. Subsonic removes by
	 * zero-based index and Jellyfin by a per-entry id, and the same song can
	 * be in a playlist twice.
	 */
	removeFromPlaylist(cred: StoredCredential, id: string, indices: number[]): Promise<void>;
	/**
	 * Moves the entry at position `from` to position `to`, the rest keeping
	 * their order. `songId` and `count` are what the caller saw: the song at
	 * `from` and the number of entries. If the playlist no longer matches
	 * (changed in another player since the page loaded), nothing is written and
	 * an `UpstreamError` of kind `conflict` is thrown.
	 */
	movePlaylistEntry(cred: StoredCredential, id: string, move: PlaylistMove): Promise<void>;
	deletePlaylist(cred: StoredCredential, id: string): Promise<void>;
	reportPlayback(cred: StoredCredential, report: PlaybackReport): Promise<void>;

	/**
	 * Every song the account has played, each with the time of its last play,
	 * for a one-time import into the history (`history.ts`).
	 *
	 * Both servers keep a count and the last date per song, and no log.
	 * Jellyfin: songs with `Filters=IsPlayed` and `UserData.LastPlayedDate`, a
	 * page at a time. Subsonic: every song through `search3` with an empty
	 * query, which Navidrome answers with the whole library, keeping those with
	 * OpenSubsonic's `played`. A server that answers the empty query with
	 * nothing, or leaves `played` out, returns an empty list.
	 */
	getPlayedSongs(cred: StoredCredential): Promise<{ song: Song; playedAt: number }[]>;

	/** Byte-exact original file. Never transcoded. */
	openStream(
		cred: StoredCredential,
		songId: string,
		req: StreamRequest,
		transcode?: TranscodeRequest | null
	): Promise<UpstreamResponse>;
	openCover(cred: StoredCredential, coverId: string, size: number, req: StreamRequest): Promise<UpstreamResponse>;
}
