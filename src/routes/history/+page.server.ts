import type { PageServerLoad } from './$types';
import { library } from '$lib/server/library';
import { recentPlays } from '$lib/server/history';
import { getSettings } from '$lib/server/settings';
import { PAGE_SIZE, readPageNumber } from '$lib/server/paging';
import type { Song } from '$lib/types';

export const load: PageServerLoad = async (event) => {
	const accountId = event.locals.session!.account.id;
	const requested = readPageNumber(event.url.searchParams);
	let { plays, total } = await recentPlays(accountId, PAGE_SIZE, (requested - 1) * PAGE_SIZE);
	const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
	// A page past the end, from a stale address or a cleared history, is the last page.
	const page = Math.min(requested, pageCount);
	if (page !== requested) ({ plays, total } = await recentPlays(accountId, PAGE_SIZE, (page - 1) * PAGE_SIZE));

	/*
	 * The tracks, each looked up once however often it was played. On Subsonic
	 * that is a call per track, 8 at a time, which is why a page is 100 plays.
	 * A track removed from the library since is left out.
	 */
	const ids = [...new Set(plays.map((play) => play.songId))];
	const songs = ids.length
		? await library(event, ({ backend, credential }) => backend.getSongs(credential, ids))
		: [];
	const byId = new Map(songs.map((song) => [song.id, song]));

	return {
		plays: plays.flatMap((play): { song: Song; playedAt: number }[] => {
			const song = byId.get(play.songId);
			return song ? [{ song, playedAt: play.playedAt }] : [];
		}),
		page: { page, pageCount, total, hasPrevious: page > 1, hasNext: page < pageCount },
		historyDays: (await getSettings(accountId)).historyDays
	};
};
