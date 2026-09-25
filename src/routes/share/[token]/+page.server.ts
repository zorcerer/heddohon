import type { PageServerLoad } from './$types';
import { config } from '$lib/server/config';
import { shareAccess, sharedSong } from '$lib/server/shares';
import { log } from '$lib/server/log';

/**
 * Opens a shared link, for anyone who has it.
 *
 * `/share` is a public route, so this runs with or without a session, and
 * everything the page shows is fetched with the sharer's credential.
 *
 * What goes to the browser is chosen field by field. The song's id, its album,
 * artist and cover ids are left out: they are handles into the sharer's
 * library, and the page reaches the audio and the cover through this link's
 * own routes instead. The sharer's username is sent only to a visitor who is
 * signed in here. Shown to anyone with the link, it would hand out a username
 * the sign-in page accepts.
 */
/**
 * Library text is written by whoever can edit the library, and this page is
 * served to anyone with a link. A 4 MB title made a 12 MB page, since the
 * title is written three times; 300 characters is longer than any real one.
 */
function clip(text: string | null): string | null {
	return text === null ? null : text.slice(0, 300);
}

export const load: PageServerLoad = async ({ locals, params, setHeaders }) => {
	const cfg = config();

	// A link is a bearer token in a URL. Nothing about this page is for a crawler
	// or a cache, and the hook already sends `private, no-store`.
	setHeaders({ 'x-robots-tag': 'noindex, nofollow' });

	const base = { appName: cfg.appName };
	if (!cfg.sharing) return { ...base, state: 'disabled' as const };
	const access = await shareAccess(params.token);
	if (!access) return { ...base, state: 'gone' as const };

	const { share, credential } = access;
	const song = await sharedSong(share, credential);
	if (!song) return { ...base, state: 'unavailable' as const };

	log.info('share-opened', {
		share: share.id,
		viewer: locals.session ? (locals.session.account.id === share.sharerAccountId ? 'owner' : 'account') : 'anonymous'
	});

	return {
		...base,
		state: 'ready' as const,
		sharedBy: locals.session ? share.sharedBy : null,
		ownLink: locals.session?.account.id === share.sharerAccountId,
		expiresAt: share.expiresAt,
		// Relative to the page, which is the only place the token is written.
		media: `/share/${params.token}`,
		song: {
			title: clip(song.title) ?? 'Unknown title',
			artist: clip(song.artist),
			album: clip(song.album),
			year: song.year,
			duration: song.duration,
			hasCover: Boolean(song.coverArt),
			quality: song.quality
		}
	};
};
