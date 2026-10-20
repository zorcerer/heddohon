import type { PageServerLoad } from './$types';
import { library } from '$lib/server/library';
import { log, reason } from '$lib/server/log';
import type { Playlist, PlaylistSort } from '$lib/types';

const SORTS: PlaylistSort[] = [
	'recentlyUpdated',
	'recentlyAdded',
	'alphabetical',
	'trackCount',
	'duration'
];

/**
 * Sorted here: neither Subsonic's `getPlaylists` nor Jellyfin's playlist
 * listing takes a sort parameter, and both return the whole set. Both backends
 * then order identically.
 */
function sortPlaylists(playlists: Playlist[], sort: PlaylistSort): Playlist[] {
	const byName = (a: Playlist, b: Playlist) =>
		a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true });
	// Undated playlists sort last rather than being treated as epoch zero.
	const byDate = (a: number | null, b: number | null) => (b ?? -Infinity) - (a ?? -Infinity);

	const ordered = [...playlists];
	switch (sort) {
		case 'alphabetical':
			return ordered.sort(byName);
		case 'trackCount':
			return ordered.sort((a, b) => (b.songCount ?? 0) - (a.songCount ?? 0) || byName(a, b));
		case 'duration':
			return ordered.sort((a, b) => (b.duration ?? 0) - (a.duration ?? 0) || byName(a, b));
		case 'recentlyAdded':
			return ordered.sort((a, b) => byDate(a.createdAt, b.createdAt) || byName(a, b));
		default:
			return ordered.sort((a, b) => byDate(a.changedAt, b.changedAt) || byName(a, b));
	}
}

export const load: PageServerLoad = async (event) => {
	const requested = event.url.searchParams.get('sort');
	const sort = SORTS.includes(requested as PlaylistSort)
		? (requested as PlaylistSort)
		: 'recentlyUpdated';

	const [playlists, smart] = await library(event, ({ backend, credential }) =>
		Promise.all([
			backend.getPlaylists(credential),
			// Which are smart only marks them, and offers a new one: without it the
			// page still lists every playlist.
			backend.smartPlaylists?.ids(credential).catch((err) => {
				log.warn('section-failed', { section: 'smart-playlists', detail: reason(err) });
				return null;
			}) ?? null
		])
	);

	return {
		playlists: sortPlaylists(playlists, sort),
		sort,
		sorts: SORTS,
		smartIds: smart ? playlists.filter((playlist) => smart.has(playlist.id)).map((playlist) => playlist.id) : [],
		smartAvailable: smart !== null
	};
};
