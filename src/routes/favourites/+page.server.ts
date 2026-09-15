import type { PageServerLoad } from './$types';
import { library } from '$lib/server/library';
import { paginate, readPageNumber } from '$lib/server/paging';

const TABS = ['songs', 'albums', 'artists'] as const;
type Tab = (typeof TABS)[number];

export const load: PageServerLoad = async (event) => {
	const starred = await library(event, ({ backend, credential }) => backend.getStarred(credential));

	const requested = event.url.searchParams.get('tab');
	// Land on whichever tab actually has something in it, so an account with no
	// favourite tracks but plenty of albums does not open on an empty list.
	const fallback: Tab =
		starred.songs.length > 0
			? 'songs'
			: starred.albums.length > 0
				? 'albums'
				: 'artists';
	const tab: Tab = TABS.includes(requested as Tab) ? (requested as Tab) : fallback;

	const page = readPageNumber(event.url.searchParams);

	return {
		tab,
		tabs: TABS,
		counts: {
			songs: starred.songs.length,
			albums: starred.albums.length,
			artists: starred.artists.length
		},
		// Only the visible tab is paginated and sent; the other two would be dead
		// weight in the payload and in the DOM.
		songs: tab === 'songs' ? paginate(starred.songs, page) : null,
		albums: tab === 'albums' ? paginate(starred.albums, page) : null,
		artists: tab === 'artists' ? paginate(starred.artists, page) : null
	};
};
