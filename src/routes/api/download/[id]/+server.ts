import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { backendFor, UpstreamError } from '$lib/server/backends';
import { config } from '$lib/server/config';
import { proxyMedia, streamRequestFrom } from '$lib/server/proxy';
import type { Song } from '$lib/types';

/**
 * The original file, as a download.
 *
 * The same bytes `/api/stream` sends, with the account's credential, never
 * transcoded, and with `Content-Disposition: attachment` and a name built from
 * the tags. Ranges are relayed, so a browser can resume an interrupted one.
 *
 * `HEDDOHON_DOWNLOADS=false` removes the button and this route. It is not a
 * copy protection: a signed-in browser is sent the same file to play it.
 */
const handler: RequestHandler = async (event) => {
	const session = event.locals.session;
	if (!session) error(401, 'Not signed in');
	if (!config().downloads) error(404, 'Not found');
	const id = event.params.id;
	if (id.length === 0 || id.length >= 256) error(404, 'Not found');

	const backend = backendFor(session.account.backend);
	let song: Song | undefined;
	try {
		[song] = await backend.getSongs(session.credential, [id]);
	} catch (err) {
		if (!(err instanceof UpstreamError)) throw err;
		error(err.kind === 'not_found' ? 404 : 502, 'Not found');
	}
	if (!song) error(404, 'Not found');

	const req = streamRequestFrom(event);
	const response = await proxyMedia(event, 'stream', (media) =>
		media.openStream(session.credential, id, req, null)
	);
	if (response.status === 200 || response.status === 206) {
		response.headers.set('content-disposition', attachment(song));
	}
	return response;
};

/**
 * `attachment` with the name twice: a plain ASCII one for old clients, and
 * the UTF-8 one RFC 6266 defines, which every current browser prefers. Both
 * are built from tags, which anyone who can edit the library writes, so
 * anything that could end the header or name a path is removed first.
 */
function attachment(song: Song): string {
	const base = [song.artist, song.title]
		.filter(Boolean)
		.join(' - ')
		// Path separators, the characters Windows refuses, quotes and every
		// control character, including CR and LF.
		.replace(/[\\/:*?"<>|\p{C}]/gu, '')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, 150) || 'track';
	const format = song.quality.format?.toLowerCase() ?? '';
	const extension = /^[a-z0-9]{1,5}$/.test(format) ? format : 'audio';
	const name = `${base}.${extension}`;
	const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/[%;]/g, '_');
	return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

export const GET = handler;
export const HEAD = handler;
