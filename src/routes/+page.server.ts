import type { PageServerLoad } from './$types';
import { forgottenAlbums } from '$lib/server/history';
import { libraryContext, librarySettled } from '$lib/server/library';
import { remembered } from '$lib/server/listings';
import { log, reason } from '$lib/server/log';

/** Favourite songs shown on the home page. */
const FAVOURITES_SHOWN = 8;

/** Albums in the "Jump back in" column: its height beside the featured release. */
const RESUME_SHOWN = 6;

/** Albums on the "Rediscover" shelf. */
const REDISCOVER_SHOWN = 12;

/**
 * The home page is rendered on the server, so the first paint has album art
 * and titles in it. Each shelf loads independently: a failing endpoint leaves
 * one row out.
 */
export const load: PageServerLoad = async ({ locals }) => {
	const { backend, credential, accountId } = libraryContext(locals);

	/*
	 * Streamed, not awaited with the shelves above it.
	 *
	 * Neither server can be asked for eight favourites: Subsonic's
	 * `getStarred2` returns every one, and Jellyfin is asked for every one so
	 * the favourites page is not cut off. On Jellyfin 12.1.0, 2500 favourite
	 * songs took 2.2s against 0.15s for 200, and awaited here that held the
	 * page. The set is the one the favourites page reads, so opening one after
	 * the other asks the music server once.
	 */
	const favouriteSongs = remembered({ accountId, credential }, 'starred', () => backend.getStarred(credential))
		.then((starred) => starred.songs.slice(0, FAVOURITES_SHOWN))
		.catch((err) => {
			log.warn('section-failed', { section: 'starred', detail: reason(err) });
			return [];
		});

	// From this server's history, without an upstream call. A failed read leaves
	// the shelf out.
	const rediscover = forgottenAlbums(accountId, REDISCOVER_SHOWN).catch((err) => {
		log.warn('section-failed', { section: 'rediscover', detail: reason(err) });
		return [];
	});

	const shelves = await librarySettled({
		recentlyAdded: backend.getAlbums(credential, { sort: 'recentlyAdded', limit: 12, offset: 0 }),
		mostPlayed: backend.getAlbums(credential, { sort: 'mostPlayed', limit: 12, offset: 0 }),
		recentlyPlayed: backend.getAlbums(credential, { sort: 'recentlyPlayed', limit: RESUME_SHOWN, offset: 0 }),
		discover: backend.getRandomSongs(credential, 12)
	});

	return {
		recentlyAdded: shelves.recentlyAdded ?? [],
		mostPlayed: shelves.mostPlayed ?? [],
		recentlyPlayed: shelves.recentlyPlayed ?? [],
		favouriteSongs,
		rediscover: await rediscover,
		discover: shelves.discover ?? []
	};
};
