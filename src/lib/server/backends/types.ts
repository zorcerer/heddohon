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
 * The secret material for one account, as stored (sealed) in the database.
 *
 * Subsonic's authentication scheme hashes the password with a per-request salt,
 * so the plaintext password genuinely has to be recoverable — there is no token
 * to hold instead. Jellyfin issues an access token, and that is what we keep;
 * the password is discarded the moment login succeeds.
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
}

/**
 * What the music server should be asked to produce instead of the file itself.
 *
 * Null is the ordinary case and the reason the player exists: the original
 * bytes, untouched. A value here is the account having asked for something it
 * can actually afford to stream.
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

export interface PlaylistMove {
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
 * Where a Quick Connect request stands upstream.
 *
 * `expired` covers every way the secret stops being usable: the server's
 * 10-minute window ran out, the server restarted and forgot it, or an
 * administrator turned Quick Connect off while it was pending.
 */
export type QuickConnectState = 'waiting' | 'authorized' | 'expired';

/**
 * Sign-in by a code the user approves from a device already signed in to the
 * music server. Only Jellyfin offers it, so the member is optional.
 *
 * `secret` is what the server later exchanges for a token, and so is as good as
 * a credential while the request is pending. It stays on this server; the
 * browser is only shown `code`. `deviceId` is chosen by the caller and must be
 * the same on every call for one request, since the server records the device
 * that asked and issues the token to it.
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
 * API rather than Subsonic's, so the member is optional and present on the
 * Subsonic backend, where `status` answers null for a server that is not
 * Navidrome. `backends/navidrome.ts` has the details.
 */
export interface Scrobblers {
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
 * the caller passes the opened credential on every call, which keeps decrypted
 * secrets scoped to a single request rather than living in a long-lived client.
 */
export interface MediaBackend {
	readonly kind: BackendKind;

	/** Verifies the credentials upstream and returns what should be stored. */
	login(username: string, password: string): Promise<{ credential: StoredCredential; remoteUserId: string | null }>;

	/** Present only where the server supports Quick Connect. */
	readonly quickConnect?: QuickConnect;

	/** Present only where the server can link Last.fm and ListenBrainz. */
	readonly scrobblers?: Scrobblers;

	/** Cheap liveness/authorisation check for an existing credential. */
	verify(cred: StoredCredential): Promise<boolean>;

	/**
	 * Whether this account administers the music server, or null when the
	 * server does not say.
	 *
	 * Null is a normal answer rather than a failure: a Subsonic server need not
	 * implement `getUser`, and a server that does may refuse it. Nothing is
	 * gated on the result. It is read so the interface can state who a
	 * server-wide action reaches, and an unknown answer changes nothing about
	 * what an account may do.
	 */
	isAdmin(cred: StoredCredential): Promise<boolean | null>;

	getAlbums(cred: StoredCredential, query: AlbumQuery): Promise<Album[]>;
	getAlbum(cred: StoredCredential, id: string): Promise<AlbumDetail>;
	getArtists(cred: StoredCredential): Promise<Artist[]>;
	getArtist(cred: StoredCredential, id: string): Promise<ArtistDetail>;
	/**
	 * Every album credited to one artist.
	 *
	 * `getArtist` returns these too, along with a biography and a top-songs
	 * list that cost a request each on the Subsonic side. This is the same
	 * albums without those, for the album page, which wants the back catalogue
	 * and nothing else.
	 */
	getArtistAlbums(cred: StoredCredential, artistId: string): Promise<Album[]>;

	/**
	 * Albums the artist is on without being credited for them: a guest on one
	 * track, a song on a compilation. May include albums of the artist's own,
	 * which the caller leaves out (`details.ts`); a plain Subsonic server does
	 * not say who an album is by from its tracks.
	 */
	getAppearsOn(cred: StoredCredential, artistId: string, artistName: string): Promise<Album[]>;

	/**
	 * Artists the music server suggests alongside this one.
	 *
	 * Both servers answer this from their own metadata and neither computes it
	 * locally: Subsonic servers read `similarArtist` out of `getArtistInfo2`,
	 * which Navidrome fills from Last.fm and leaves empty when no Last.fm API
	 * key is configured. An empty array is therefore a normal answer, not a
	 * failure, and the page renders nothing rather than an empty shelf.
	 */
	getSimilarArtists(cred: StoredCredential, artistId: string, limit: number): Promise<Artist[]>;

	/**
	 * Albums to suggest alongside this one.
	 *
	 * Subsonic has no album-to-album similarity endpoint at all:
	 * `getSimilarSongs2` is keyed on an artist id and returns tracks, which
	 * this groups back into albums. Passing `artistId` in saves the adapter a
	 * round trip to look it up.
	 *
	 * Neither the album itself nor anything else by `artistId` is returned.
	 * Both servers offer the artist's own records here, and the album page
	 * already shows that catalogue in a section of its own, directly above.
	 */
	getSimilarAlbums(
		cred: StoredCredential,
		albumId: string,
		artistId: string | null,
		limit: number
	): Promise<Album[]>;

	/**
	 * Up to `limit` songs the music server considers like a song, an album or
	 * an artist: an instant mix. Empty when it has none, which on Navidrome is
	 * every item unless an external agent (Last.fm and others) is configured.
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
	 * A folder of the library as it is on disk, or the top with `id` null.
	 *
	 * Subsonic: `getMusicFolders` for the libraries, `getIndexes` for the first
	 * level of one, `getMusicDirectory` below that. Navidrome 0.55 and later
	 * answer these from the folders on disk; earlier versions make up a tree of
	 * artists and albums. Jellyfin: the music libraries from `/UserViews`, then
	 * `/Items?ParentId=`, which lists what a library holds as it is on disk
	 * (plain folders, and a folder of tracks as its album).
	 *
	 * An id that is not a folder is `not_found`.
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
	 * with 0. Present only where the server keeps ratings: Subsonic's
	 * `setRating`, which Navidrome implements. Jellyfin keeps a like or a
	 * dislike per item and no scale, so the member is absent there and
	 * `rating` is null on everything it returns.
	 */
	setRating?(cred: StoredCredential, id: string, rating: number): Promise<void>;

	/**
	 * The internet radio stations the server keeps, each with the address of
	 * its stream. Present only where the server has such a list: Subsonic's
	 * `getInternetRadioStations`. Jellyfin has none, so the member is absent
	 * there and the Radio page is not offered.
	 */
	getRadioStations?(cred: StoredCredential): Promise<RadioStationSource[]>;

	/** Lyrics for one track, or null when the server has none. */
	getLyrics(cred: StoredCredential, song: Song): Promise<Lyrics | null>;

	/** Creates a playlist, optionally seeded with tracks. Returns the new id. */
	createPlaylist(cred: StoredCredential, name: string, songIds: string[]): Promise<string>;
	renamePlaylist(cred: StoredCredential, id: string, name: string): Promise<void>;
	addToPlaylist(cred: StoredCredential, id: string, songIds: string[]): Promise<void>;
	/**
	 * Removes entries by their position in the playlist, not by song id.
	 *
	 * Position is the only identity both servers agree on: Subsonic removes by
	 * zero-based index, Jellyfin by an opaque per-entry id. Song id would be
	 * ambiguous anyway — the same track can legitimately appear twice.
	 */
	removeFromPlaylist(cred: StoredCredential, id: string, indices: number[]): Promise<void>;
	/**
	 * Moves the entry at position `from` to position `to`, the rest keeping
	 * their order. `songId` and `count` are what the caller saw: the song at
	 * `from` and the number of entries. If the playlist no longer matches
	 * (changed in another player since the page loaded), nothing is written
	 * and an `UpstreamError` of kind `conflict` is thrown, so an edit made
	 * elsewhere is not overwritten.
	 */
	movePlaylistEntry(cred: StoredCredential, id: string, move: PlaylistMove): Promise<void>;
	deletePlaylist(cred: StoredCredential, id: string): Promise<void>;
	reportPlayback(cred: StoredCredential, report: PlaybackReport): Promise<void>;

	/**
	 * Every song the account has played, each with the time of its last play,
	 * for a one-time import into the history (`history.ts`).
	 *
	 * Neither server keeps a log of plays: each keeps a count and the last
	 * date per song, so earlier plays have no time to import. Jellyfin: songs
	 * with `Filters=IsPlayed` and `UserData.LastPlayedDate`, a page at a time.
	 * Subsonic: every song through `search3` with an empty query, which
	 * Navidrome answers with the whole library for syncing clients, keeping
	 * those with OpenSubsonic's `played`. A server that answers the empty
	 * query with nothing, or leaves `played` out, returns an empty list.
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
