import type { PageServerLoad } from './$types';
import { forgottenAlbums } from '$lib/server/history';
import { libraryContext, librarySettled } from '$lib/server/library';
import { remembered } from '$lib/server/listings';
import { log, reason } from '$lib/server/log';
import { dailyMixes, summary } from '$lib/server/mixes';
import { newReleases } from '$lib/server/newreleases';
import { unseenFeatures } from '$lib/server/features';
import { ensureHandle, getProfile } from '$lib/server/listening';
import { profilesOn } from '$lib/server/profilepage';

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

	/*
	 * Streamed: made at the first visit of the day, which reads the music
	 * server a dozen times, and read from the database after that. See
	 * `mixes.ts`. A failure leaves the shelf out.
	 */
	const mixes = dailyMixes({ backend, credential, accountId })
		.then((made) => made.map(summary))
		.catch((err) => {
			log.warn('section-failed', { section: 'daily-mixes', detail: reason(err) });
			return [];
		});

	// Streamed: from MusicBrainz, for an account that turned the shelf on where
	// the server allows it. See `newreleases.ts`. A failure leaves the shelf out.
	const releases = locals.settings?.newReleases
		? newReleases({ backend, credential, accountId }).catch((err) => {
				log.warn('section-failed', { section: 'new-releases', detail: reason(err) });
				return [];
			})
		: Promise.resolve([]);

	/*
	 * Streamed: the optional features that are off and that this account has
	 * not been told of, for an administrator of the music server; see
	 * `features.ts`. The administrator is asked of the music server only when
	 * there is something to tell.
	 */
	const unseen = unseenFeatures(locals.settings?.featuresSeen ?? []);
	const featureNotice =
		unseen.length === 0
			? Promise.resolve([])
			: backend
					.isAdmin(credential)
					.then((admin) => (admin === true ? unseen.map(({ id, title }) => ({ id, title })) : []))
					.catch(() => []);

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

	// The account's own profile, for the picture in the masthead that leads to
	// its page; read from the database, with no call to the music server.
	// The row is made once, on the first visit, not written on every one. None
	// while profile pages are switched off.
	const profile = profilesOn() ? await getProfile(accountId) : null;
	if (profile) profile.handle ??= await ensureHandle(accountId);

	return {
		me: profile && { handle: profile.handle, name: profile.name ?? locals.session!.account.username, avatar: profile.avatarAt },
		recentlyAdded: shelves.recentlyAdded ?? [],
		mostPlayed: shelves.mostPlayed ?? [],
		recentlyPlayed: shelves.recentlyPlayed ?? [],
		favouriteSongs,
		mixes,
		newReleases: releases,
		featureNotice,
		rediscover: await rediscover,
		discover: shelves.discover ?? []
	};
};
