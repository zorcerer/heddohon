import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { UpstreamError } from '#lib/server/backends/index.ts';
import { libraryContext, refusedCredential } from '#lib/server/library.ts';
import { presenceCoverPath } from '#lib/server/presencecover.ts';
import { externalLinks } from '#lib/server/suggestions.ts';

/** A release's page on MusicBrainz, and its id, which is a UUID. A release group's is not one. */
const RELEASE = /^https:\/\/musicbrainz\.org\/release\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i;

/** Ids are 1 to 255 characters, as everywhere else (`SECURITY.md`, Input bounds). */
const idOf = (value: string | null) => (value && value.length < 256 ? value : null);

/*
 * Where the desktop app's Discord activity takes its cover from (issue #358),
 * for the playing song's album and cover:
 *
 * - `cover`: a link to the cover on this server that Discord can fetch without
 *   a sign-in (`presencecover.ts`), where an administrator turned on
 *   `HEDDOHON_DISCORD_COVERS` and this account's cache holds the cover. Else null.
 * - `release`: the album's MusicBrainz release, for Cover Art Archive, or null.
 *   Read from the album's links, as its page shows them (`externalLinks`, held
 *   with the shelves), with the account's own login.
 *
 * The app tries them in that order, then shows the Heddohon icon.
 */
export const GET: RequestHandler = async ({ locals, url }) => {
	const session = locals.session;
	if (!session) error(401, 'Not signed in');
	const albumId = idOf(url.searchParams.get('album'));
	const coverId = idOf(url.searchParams.get('cover'));
	const cover = coverId ? await presenceCoverPath(session.account, coverId) : null;
	if (!albumId) return json({ cover, release: null });
	try {
		const links = await externalLinks(libraryContext(locals), 'album', albumId);
		const release = links.map((link) => RELEASE.exec(link.url)?.[1]).find(Boolean);
		return json({ cover, release: release?.toLowerCase() ?? null });
	} catch (err) {
		await refusedCredential(locals, err);
		if (err instanceof UpstreamError) error(err.status === 404 ? 404 : 502, err.message);
		throw err;
	}
};
