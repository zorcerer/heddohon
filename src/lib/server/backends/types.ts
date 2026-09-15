import type {
	Album,
	AlbumDetail,
	AlbumQuery,
	Artist,
	ArtistDetail,
	BackendKind,
	Playlist,
	PlaylistDetail,
	Lyrics,
	SearchResults,
	Song,
	StarKind
} from '$lib/types';

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

export interface PlaybackReport {
	songId: string;
	/** Seconds into the track. */
	position: number;
	event: 'start' | 'progress' | 'stop';
	/** Only meaningful for `stop`: whether the play should count as a scrobble. */
	completed?: boolean;
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

	getPlaylists(cred: StoredCredential): Promise<Playlist[]>;
	getPlaylist(cred: StoredCredential, id: string): Promise<PlaylistDetail>;
	getSongs(cred: StoredCredential, ids: string[]): Promise<Song[]>;
	getRandomSongs(cred: StoredCredential, limit: number): Promise<Song[]>;
	getStarred(cred: StoredCredential): Promise<SearchResults>;
	search(cred: StoredCredential, query: string, limit: number): Promise<SearchResults>;

	setStarred(cred: StoredCredential, id: string, kind: StarKind, starred: boolean): Promise<void>;

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
	deletePlaylist(cred: StoredCredential, id: string): Promise<void>;
	reportPlayback(cred: StoredCredential, report: PlaybackReport): Promise<void>;

	/** Byte-exact original file. Never transcoded. */
	openStream(
		cred: StoredCredential,
		songId: string,
		req: StreamRequest,
		transcode?: TranscodeRequest | null
	): Promise<UpstreamResponse>;
	openCover(cred: StoredCredential, coverId: string, size: number, req: StreamRequest): Promise<UpstreamResponse>;
}
