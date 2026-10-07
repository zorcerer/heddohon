import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { config } from '$lib/server/config';
import { library } from '$lib/server/library';
import { folderDetail } from '$lib/server/details';
import { paginate, readPageNumber } from '$lib/server/paging';
import type { FolderRef, Song } from '$lib/types';

type Entry = { folder: FolderRef } | { song: Song };

export const load: PageServerLoad = async (event) => {
	// Switched off for this deployment: the page is not there.
	if (!config().folders) error(404, 'Not found');
	const id = event.params.id ?? null;
	if (id !== null && (id.length === 0 || id.length >= 256)) error(404, 'That folder does not exist.');

	const folder = await library(event, (ctx) => folderDetail(ctx, id));

	/*
	 * Folders, then tracks, 100 to a page between them. A folder is read whole
	 * from the music server, and the top of a library can hold every artist, or
	 * a folder of unsorted files thousands of tracks. "Play" asks for the
	 * folder's tracks through `/api/tracks`, so it plays them all whatever page
	 * is showing.
	 */
	const entries: Entry[] = [
		...folder.folders.map((ref) => ({ folder: ref })),
		...folder.songs.map((song) => ({ song }))
	];
	const page = paginate(entries, readPageNumber(event.url.searchParams));

	return {
		folder: { id: folder.id, name: folder.name, parents: folder.parents },
		folderCount: folder.folders.length,
		songCount: folder.songs.length,
		folders: page.items.flatMap((entry) => ('folder' in entry ? [entry.folder] : [])),
		songs: page.items.flatMap((entry) => ('song' in entry ? [entry.song] : [])),
		page: { page: page.page, pageCount: page.pageCount, total: page.total, hasPrevious: page.hasPrevious, hasNext: page.hasNext }
	};
};
