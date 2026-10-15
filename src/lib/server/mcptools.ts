/**
 * What an AI assistant can do through the MCP endpoint (`routes/api/mcp`):
 * read the library, the favourites, the playlists and this server's history
 * of the account, and, with a token that allows it (`mcp.ts`), make and
 * change playlists, favourites and ratings.
 *
 * Every call goes to the music server under the account's own credential, as
 * a page does (invariant 10), through the same caches as the pages, and a
 * write drops what the matching API route drops. Nothing here plays audio or
 * reaches another account.
 *
 * Arguments are checked by type and bound here, as an API route checks its
 * body. An argument that is wrong comes back as a failed call the assistant
 * reads, which is how the protocol asks for it.
 */
import type { Album, AlbumDetail, AlbumSort, Artist, ArtistDetail, Playlist, PlaylistDetail, Song, StarKind } from '$lib/types';
import type { LibraryContext } from './library';
import { albumDetail, artistDetail, forgetDetails } from './details';
import { forgetListings, remembered } from './listings';
import { forgetSharedItems } from './shares';
import { dailyMixes } from './mixes';
import { listeningStats, periodStart, recentPlays, STATS_PERIODS, type StatsPeriod } from './history';

/** A call's arguments that are not what the tool takes. The message is for the assistant. */
export class ToolInputError extends Error {}

type Args = Record<string, unknown>;

/** A JSON Schema, as the protocol carries one. */
type Schema = Record<string, unknown>;

export interface Tool {
	name: string;
	title: string;
	description: string;
	inputSchema: Schema;
	/** Whether it changes anything on the music server. A token without writes is not offered it. */
	writes: boolean;
	/** Whether the same call made again leaves the same state. Every read does. */
	idempotent?: boolean;
	/** Whether it removes something that cannot be had back. */
	destructive?: boolean;
	/** Present where the music server can do it. */
	offered?: (ctx: LibraryContext) => boolean;
	run(ctx: LibraryContext, args: Args): Promise<unknown>;
}

/* ── Arguments ─────────────────────────────────────────────────────────────── */

/** Ids are strings of 1 to 255 characters, as everywhere else (`SECURITY.md`, Input bounds). */
const MAX_ID = 255;
/** Songs in one playlist write, as `/api/playlists` takes. */
const MAX_SONGS = 1000;
/** A playlist's name, as `/api/playlists` takes. */
const MAX_PLAYLIST_NAME = 200;
/** Past any title; the music server is not sent more, as `/api/search`. */
const MAX_QUERY = 200;

function text(args: Args, key: string, max: number, min = 1): string {
	const value = args[key];
	if (typeof value !== 'string') throw new ToolInputError(`${key} is required, as a string`);
	const trimmed = value.trim();
	if (trimmed.length < min || trimmed.length > max) {
		throw new ToolInputError(`${key} must be ${min} to ${max} characters`);
	}
	return trimmed;
}

const id = (args: Args, key = 'id') => text(args, key, MAX_ID);

function whole(args: Args, key: string, fallback: number, min: number, max: number): number {
	const value = args[key] ?? fallback;
	if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
		throw new ToolInputError(`${key} must be a whole number from ${min} to ${max}`);
	}
	return value;
}

function oneOf<T extends string>(args: Args, key: string, allowed: readonly T[], fallback?: T): T {
	const value = args[key] ?? fallback;
	if (!allowed.includes(value as T)) throw new ToolInputError(`${key} must be one of ${allowed.join(', ')}`);
	return value as T;
}

function flag(args: Args, key: string): boolean {
	const value = args[key];
	if (typeof value !== 'boolean') throw new ToolInputError(`${key} is required, as true or false`);
	return value;
}

function songIds(args: Args, key: string, required: boolean): string[] {
	const value = args[key] ?? [];
	if (!Array.isArray(value) || !value.every((item) => typeof item === 'string' && item.length > 0 && item.length <= MAX_ID)) {
		throw new ToolInputError(`${key} must be a list of song ids`);
	}
	if (value.length > MAX_SONGS) throw new ToolInputError(`${key} takes at most ${MAX_SONGS} songs at once`);
	if (required && value.length === 0) throw new ToolInputError(`${key} must hold at least one song id`);
	return value as string[];
}

/* ── What is sent back ─────────────────────────────────────────────────────── */

/*
 * Each item as the fields an assistant reasons with, with every empty one left
 * out. A song from Navidrome 0.64.2 (the test rig's) was 546 bytes of JSON as
 * `/api/search` sends it, cover ids, ReplayGain and nulls among them, and is
 * 259 like this.
 */

/** The object without its null, undefined and false members. */
function lean(value: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(Object.entries(value).filter(([, member]) => member !== null && member !== undefined && member !== false));
}

const iso = (at: number | null) => (at === null ? null : new Date(at).toISOString());

/** "flac 24-bit 96kHz", "mp3 320kbps". */
function quality(song: Song): string | null {
	const { format, bitDepth, sampleRateHz, bitrateKbps, lossless } = song.quality;
	const parts = [
		format?.toLowerCase(),
		bitDepth ? `${bitDepth}-bit` : null,
		sampleRateHz ? `${sampleRateHz / 1000}kHz` : null,
		!lossless && bitrateKbps ? `${bitrateKbps}kbps` : null
	].filter(Boolean);
	return parts.length ? parts.join(' ') : null;
}

function song(item: Song): Record<string, unknown> {
	return lean({
		id: item.id,
		title: item.title,
		artist: item.artist,
		artistId: item.artistId,
		albumArtist: item.albumArtist !== item.artist ? item.albumArtist : null,
		album: item.album,
		albumId: item.albumId,
		disc: item.disc,
		track: item.track,
		year: item.year,
		genre: item.genre,
		seconds: item.duration || null,
		quality: quality(item),
		favourite: item.starred,
		rating: item.rating || null,
		plays: item.playCount
	});
}

function album(item: Album): Record<string, unknown> {
	return lean({
		id: item.id,
		name: item.name,
		artist: item.artist,
		artistId: item.artistId,
		year: item.year,
		genre: item.genre,
		songs: item.songCount,
		seconds: item.duration,
		releaseTypes: item.releaseTypes?.length ? item.releaseTypes : null,
		favourite: item.starred,
		rating: item.rating || null
	});
}

const artist = (item: Artist) =>
	lean({ id: item.id, name: item.name, albums: item.albumCount, favourite: item.starred });

function playlist(item: Playlist): Record<string, unknown> {
	return lean({
		id: item.id,
		name: item.name,
		comment: item.comment || null,
		songs: item.songCount,
		seconds: item.duration,
		owner: item.owner,
		public: item.isPublic,
		// Whether this account may change it: another user's public playlist is listed too.
		readOnly: !item.editable,
		changed: iso(item.changedAt)
	});
}

const albumWithSongs = (item: AlbumDetail) => ({ ...album(item), tracks: item.songs.map(song) });

/** A biography from Last.fm carries a link in HTML at its end. */
const plain = (html: string | null) => (html ? html.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim() || null : null);

const artistWithAlbums = (item: ArtistDetail) => ({
	...artist(item),
	...lean({ biography: plain(item.biography) }),
	albumList: item.albums.map(album),
	topSongs: item.topSongs.map(song)
});

/** Each entry with its position, which `remove_from_playlist` takes. A song can be in a playlist twice. */
const playlistWithSongs = (item: PlaylistDetail) => ({
	...playlist(item),
	entries: item.songs.map((entry, position) => ({ position, ...song(entry) }))
});

/* ── The tools ─────────────────────────────────────────────────────────────── */

const ALBUM_SORTS: AlbumSort[] = ['recentlyAdded', 'recentlyPlayed', 'mostPlayed', 'alphabetical', 'byArtist', 'byYear', 'random', 'starred'];
const STAR_KINDS: StarKind[] = ['song', 'album', 'artist'];

const ID = { type: 'string', minLength: 1, maxLength: MAX_ID };
const SONG_IDS = { type: 'array', items: ID, maxItems: MAX_SONGS };
const object = (properties: Record<string, Schema>, required: string[] = []): Schema => ({
	type: 'object',
	properties,
	required,
	additionalProperties: false
});
const count = (fallback: number, max: number, what: string) => ({
	type: 'integer',
	minimum: 1,
	maximum: max,
	default: fallback,
	description: `How many ${what} to return, ${fallback} unless given.`
});
const OFFSET = { type: 'integer', minimum: 0, maximum: 100_000, default: 0, description: 'How many to skip, for the next page.' };

/** A page of a listing the music server returns whole. */
function page<T>(items: T[], offset: number, limit: number) {
	return { total: items.length, offset, items: items.slice(offset, offset + limit) };
}

export const TOOLS: Tool[] = [
	{
		name: 'search',
		title: 'Search the library',
		description: 'Finds songs, albums and artists whose names match the words given.',
		inputSchema: object({ query: { type: 'string', minLength: 2, maxLength: MAX_QUERY }, limit: count(20, 50, 'of each kind') }, ['query']),
		writes: false,
		async run({ backend, credential }, args) {
			const found = await backend.search(credential, text(args, 'query', MAX_QUERY, 2), whole(args, 'limit', 20, 1, 50));
			return { songs: found.songs.map(song), albums: found.albums.map(album), artists: found.artists.map(artist) };
		}
	},
	{
		name: 'list_albums',
		title: 'List albums',
		description:
			'Albums in the library in one order: recentlyAdded, recentlyPlayed, mostPlayed, alphabetical, byArtist, byYear, random or starred (favourites).',
		inputSchema: object({ sort: { type: 'string', enum: ALBUM_SORTS, default: 'recentlyAdded' }, limit: count(50, 200, 'albums'), offset: OFFSET }),
		writes: false,
		async run({ backend, credential }, args) {
			const sort = oneOf(args, 'sort', ALBUM_SORTS, 'recentlyAdded');
			const limit = whole(args, 'limit', 50, 1, 200);
			const offset = whole(args, 'offset', 0, 0, 100_000);
			return { sort, offset, albums: (await backend.getAlbums(credential, { sort, limit, offset })).map(album) };
		}
	},
	{
		name: 'get_album',
		title: 'Get an album',
		description: 'An album with its tracks in order.',
		inputSchema: object({ id: ID }, ['id']),
		writes: false,
		run: async (ctx, args) => albumWithSongs(await albumDetail(ctx, id(args)))
	},
	{
		name: 'list_artists',
		title: 'List artists',
		description: 'Artists in the library by name, optionally those whose name contains some text.',
		inputSchema: object({ contains: { type: 'string', maxLength: MAX_QUERY }, limit: count(200, 1000, 'artists'), offset: OFFSET }),
		writes: false,
		async run({ backend, credential, accountId }, args) {
			const contains = typeof args.contains === 'string' ? args.contains.trim().toLowerCase().slice(0, MAX_QUERY) : '';
			const all = await remembered({ accountId, credential }, 'artists', () => backend.getArtists(credential));
			const matching = contains ? all.filter((item) => item.name.toLowerCase().includes(contains)) : all;
			return page(matching.map(artist), whole(args, 'offset', 0, 0, 100_000), whole(args, 'limit', 200, 1, 1000));
		}
	},
	{
		name: 'get_artist',
		title: 'Get an artist',
		description: 'An artist with their albums, their most played songs and a biography where the music server has one.',
		inputSchema: object({ id: ID }, ['id']),
		writes: false,
		run: async (ctx, args) => artistWithAlbums(await artistDetail(ctx, id(args)))
	},
	{
		name: 'list_genres',
		title: 'List genres',
		description: 'Every genre with its number of albums and songs.',
		inputSchema: object({}),
		writes: false,
		async run({ backend, credential, accountId }) {
			const genres = await remembered({ accountId, credential }, 'genres', () => backend.getGenres(credential));
			return { genres: genres.map((genre) => lean({ id: genre.id, name: genre.name, albums: genre.albumCount, songs: genre.songCount })) };
		}
	},
	{
		name: 'list_genre_albums',
		title: 'List albums in a genre',
		description: 'Albums in one genre, by the genre id from list_genres.',
		inputSchema: object({ id: ID, limit: count(50, 200, 'albums'), offset: OFFSET }, ['id']),
		writes: false,
		async run({ backend, credential }, args) {
			const albums = await backend.getGenreAlbums(credential, id(args), whole(args, 'limit', 50, 1, 200), whole(args, 'offset', 0, 0, 100_000));
			return { albums: albums.map(album) };
		}
	},
	{
		name: 'get_similar_songs',
		title: 'Get similar songs',
		description:
			"Songs the music server considers like a song, an album or an artist (an instant mix). Often empty on Navidrome without Last.fm configured.",
		inputSchema: object({ kind: { type: 'string', enum: STAR_KINDS }, id: ID, limit: count(50, 100, 'songs') }, ['kind', 'id']),
		writes: false,
		async run({ backend, credential }, args) {
			const songs = await backend.getInstantMix(credential, oneOf(args, 'kind', STAR_KINDS), id(args), whole(args, 'limit', 50, 1, 100));
			return { songs: songs.map(song) };
		}
	},
	{
		name: 'get_random_songs',
		title: 'Get random songs',
		description: 'Songs picked at random from the whole library.',
		inputSchema: object({ limit: count(50, 100, 'songs') }),
		writes: false,
		async run({ backend, credential }, args) {
			return { songs: (await backend.getRandomSongs(credential, whole(args, 'limit', 50, 1, 100))).map(song) };
		}
	},
	{
		name: 'get_favourites',
		title: 'Get favourites',
		description: 'The songs, albums and artists marked as favourites.',
		inputSchema: object({}),
		writes: false,
		async run({ backend, credential, accountId }) {
			const starred = await remembered({ accountId, credential }, 'starred', () => backend.getStarred(credential));
			return { songs: starred.songs.map(song), albums: starred.albums.map(album), artists: starred.artists.map(artist) };
		}
	},
	{
		name: 'list_playlists',
		title: 'List playlists',
		description: 'Your playlists, and the public ones of other accounts, which are marked readOnly and cannot be changed.',
		inputSchema: object({}),
		writes: false,
		async run({ backend, credential }) {
			return { playlists: (await backend.getPlaylists(credential)).map(playlist) };
		}
	},
	{
		name: 'get_playlist',
		title: 'Get a playlist',
		description: 'A playlist with its entries in order. Each entry has its position, counted from 0.',
		inputSchema: object({ id: ID }, ['id']),
		writes: false,
		run: async ({ backend, credential }, args) => playlistWithSongs(await backend.getPlaylist(credential, id(args)))
	},
	{
		name: 'get_daily_mixes',
		title: "Get today's daily mixes",
		description:
			"Up to three mixes made today from the artists you have played most in the last 30 days and music like theirs you have not played in the last three days. The same all day; new ones tomorrow.",
		inputSchema: object({}),
		writes: false,
		async run(ctx) {
			const mixes = await dailyMixes(ctx);
			return { mixes: mixes.map((mix) => ({ n: mix.n, title: mix.title, from: mix.artists, songs: mix.songs.map(song) })) };
		}
	},
	{
		name: 'get_history',
		title: 'Get listening history',
		description: 'Songs played through this Heddohon server, newest first, with when each was played.',
		inputSchema: object({ limit: count(50, 100, 'plays'), offset: OFFSET }),
		writes: false,
		async run({ backend, credential, accountId }, args) {
			const { plays, total } = await recentPlays(accountId, whole(args, 'limit', 50, 1, 100), whole(args, 'offset', 0, 0, 100_000));
			// Each track looked up once however often it was played, as the history page does.
			const ids = [...new Set(plays.map((play) => play.songId))];
			const songs = new Map((ids.length ? await backend.getSongs(credential, ids) : []).map((item) => [item.id, item]));
			return {
				total,
				plays: plays.flatMap((play) => {
					const item = songs.get(play.songId);
					// A track removed from the library since is left out.
					return item ? [{ playedAt: iso(play.playedAt), ...song(item) }] : [];
				})
			};
		}
	},
	{
		name: 'get_listening_stats',
		title: 'Get listening statistics',
		description:
			'Totals and the most played artists, albums and tracks over the last 30 days (month), 90 days (quarter), this calendar year (year) or everything kept (all), from the plays recorded by this server.',
		inputSchema: object({ period: { type: 'string', enum: STATS_PERIODS, default: 'month' } }),
		writes: false,
		async run({ accountId }, args) {
			const period = oneOf<StatsPeriod>(args, 'period', STATS_PERIODS, 'month');
			const stats = await listeningStats(accountId, periodStart(period));
			// `hours` is for the charts, and the covers for the pages.
			const uncovered = (ranked: { coverArt: string | null }) => lean({ ...ranked, coverArt: null });
			return {
				period,
				plays: stats.plays,
				seconds: stats.seconds,
				tracks: stats.tracks,
				artists: stats.artists,
				topArtists: stats.topArtists.map(uncovered),
				topAlbums: stats.topAlbums.map(uncovered),
				topTracks: stats.topTracks.map(uncovered),
				newArtists: stats.newArtists.map(uncovered)
			};
		}
	},

	/* Writes. A token without them is not offered these. */
	{
		name: 'create_playlist',
		title: 'Create a playlist',
		description: 'Makes a playlist, optionally with songs in it from the start. Returns its id.',
		inputSchema: object({ name: { type: 'string', minLength: 1, maxLength: MAX_PLAYLIST_NAME }, songIds: SONG_IDS }, ['name']),
		writes: true,
		async run({ backend, credential }, args) {
			const name = text(args, 'name', MAX_PLAYLIST_NAME);
			const ids = songIds(args, 'songIds', false);
			return { id: await backend.createPlaylist(credential, name, ids), name, added: ids.length };
		}
	},
	{
		name: 'add_to_playlist',
		title: 'Add songs to a playlist',
		description: 'Adds songs to the end of a playlist, in the order given.',
		inputSchema: object({ id: ID, songIds: { ...SONG_IDS, minItems: 1 } }, ['id', 'songIds']),
		writes: true,
		async run({ backend, credential, accountId }, args) {
			const playlistId = id(args);
			const ids = songIds(args, 'songIds', true);
			await backend.addToPlaylist(credential, playlistId, ids);
			// A link to this playlist serves the edit on its next request.
			forgetSharedItems(accountId);
			return { id: playlistId, added: ids.length };
		}
	},
	{
		name: 'remove_from_playlist',
		title: 'Remove entries from a playlist',
		description: 'Removes entries by their position, counted from 0, as get_playlist lists them. Read the playlist first: positions change with every edit.',
		inputSchema: object(
			{ id: ID, positions: { type: 'array', items: { type: 'integer', minimum: 0, maximum: 99_999 }, minItems: 1, maxItems: MAX_SONGS } },
			['id', 'positions']
		),
		writes: true,
		async run({ backend, credential, accountId }, args) {
			const playlistId = id(args);
			const raw = args.positions;
			if (!Array.isArray(raw) || !raw.every((n) => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n < 100_000)) {
				throw new ToolInputError('positions must be a list of whole numbers from 0');
			}
			// Deduplicated and bounded as `/api/playlists/[id]/tracks` does.
			const positions = [...new Set(raw as number[])];
			if (positions.length === 0 || positions.length > MAX_SONGS) throw new ToolInputError(`positions must hold 1 to ${MAX_SONGS} positions`);
			await backend.removeFromPlaylist(credential, playlistId, positions);
			forgetSharedItems(accountId);
			return { id: playlistId, removed: positions.length };
		}
	},
	{
		name: 'rename_playlist',
		title: 'Rename a playlist',
		description: 'Gives a playlist a new name.',
		inputSchema: object({ id: ID, name: { type: 'string', minLength: 1, maxLength: MAX_PLAYLIST_NAME } }, ['id', 'name']),
		writes: true,
		idempotent: true,
		async run({ backend, credential, accountId }, args) {
			const playlistId = id(args);
			const name = text(args, 'name', MAX_PLAYLIST_NAME);
			await backend.renamePlaylist(credential, playlistId, name);
			forgetSharedItems(accountId);
			return { id: playlistId, name };
		}
	},
	{
		name: 'set_playlist_public',
		title: 'Make a playlist public or private',
		description:
			'Makes one of your own playlists visible to every account on the music server (public true), or to you alone (public false).',
		inputSchema: object({ id: ID, public: { type: 'boolean' } }, ['id', 'public']),
		writes: true,
		idempotent: true,
		async run({ backend, credential, accountId }, args) {
			const playlistId = id(args);
			const isPublic = flag(args, 'public');
			await backend.setPlaylistPublic(credential, playlistId, isPublic);
			forgetSharedItems(accountId);
			return { id: playlistId, public: isPublic };
		}
	},
	{
		name: 'delete_playlist',
		title: 'Delete a playlist',
		description: 'Deletes a playlist from the music server. It cannot be had back.',
		inputSchema: object({ id: ID }, ['id']),
		writes: true,
		idempotent: true,
		destructive: true,
		async run({ backend, credential, accountId }, args) {
			const playlistId = id(args);
			await backend.deletePlaylist(credential, playlistId);
			forgetSharedItems(accountId);
			return { id: playlistId, deleted: true };
		}
	},
	{
		name: 'set_favourite',
		title: 'Mark or unmark a favourite',
		description: 'Marks a song, an album or an artist as a favourite, or with favourite false takes the mark off.',
		inputSchema: object({ kind: { type: 'string', enum: STAR_KINDS }, id: ID, favourite: { type: 'boolean' } }, ['kind', 'id', 'favourite']),
		writes: true,
		idempotent: true,
		async run({ backend, credential, accountId }, args) {
			const itemId = id(args);
			const favourite = flag(args, 'favourite');
			await backend.setStarred(credential, itemId, oneOf(args, 'kind', STAR_KINDS), favourite);
			// As `/api/star`: the favourites listing and every detail carry the mark.
			forgetListings(accountId, 'starred');
			forgetDetails(accountId);
			return { id: itemId, favourite };
		}
	},
	{
		name: 'set_rating',
		title: 'Rate a song or an album',
		description: 'Rates a song or an album from 1 to 5 stars, or clears the rating with 0.',
		inputSchema: object({ id: ID, rating: { type: 'integer', minimum: 0, maximum: 5 } }, ['id', 'rating']),
		writes: true,
		idempotent: true,
		// Jellyfin keeps no scale; see `setRating` in `backends/types.ts`.
		offered: ({ backend }) => Boolean(backend.setRating),
		async run({ backend, credential, accountId }, args) {
			const itemId = id(args);
			const rating = whole(args, 'rating', -1, 0, 5);
			await backend.setRating!(credential, itemId, rating);
			// As `/api/rating`.
			forgetDetails(accountId);
			forgetListings(accountId, 'starred');
			return { id: itemId, rating };
		}
	}
];

/** The tools a token is offered on this account's music server. */
export function toolsFor(ctx: LibraryContext, writes: boolean): Tool[] {
	return TOOLS.filter((tool) => (writes || !tool.writes) && (tool.offered?.(ctx) ?? true));
}

/** As the protocol lists a tool. */
export function describe(tool: Tool) {
	return {
		name: tool.name,
		title: tool.title,
		description: tool.description,
		inputSchema: tool.inputSchema,
		annotations: {
			title: tool.title,
			readOnlyHint: !tool.writes,
			destructiveHint: tool.destructive ?? false,
			idempotentHint: tool.idempotent ?? !tool.writes,
			// The account's own music server, and nothing past it.
			openWorldHint: false
		}
	};
}
