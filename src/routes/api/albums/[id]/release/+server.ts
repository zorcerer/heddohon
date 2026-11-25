import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { UpstreamError } from '#lib/server/backends/index.ts';
import { libraryContext, refusedCredential } from '#lib/server/library.ts';
import { externalLinks } from '#lib/server/suggestions.ts';

/** A release's page on MusicBrainz, and its id, which is a UUID. A release group's is not one. */
const RELEASE = /^https:\/\/musicbrainz\.org\/release\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i;

/*
 * The MusicBrainz release an album is, or `{ "release": null }`, for the
 * desktop app's Discord activity (issue #358): Discord shows the cover from
 * Cover Art Archive by that id, so nothing of this server is sent to it.
 *
 * Read from the album's links, as its page shows them (`externalLinks`, held
 * with the shelves): Navidrome's `getAlbumInfo2` from the tags, Jellyfin's
 * provider ids. Asked with the account's own login, like the page.
 */
export const GET: RequestHandler = async ({ locals, params }) => {
	if (!locals.session) error(401, 'Not signed in');
	const ctx = libraryContext(locals);
	try {
		const links = await externalLinks(ctx, 'album', params.id);
		const release = links.map((link) => RELEASE.exec(link.url)?.[1]).find(Boolean);
		return json({ release: release?.toLowerCase() ?? null });
	} catch (err) {
		await refusedCredential(locals, err);
		if (err instanceof UpstreamError) error(err.status === 404 ? 404 : 502, err.message);
		throw err;
	}
};
