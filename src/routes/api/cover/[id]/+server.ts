import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { nearestCoverSize, proxyMedia, streamRequestFrom } from '$lib/server/proxy';
import { collectCover, coverScope, readCover, writeCover } from '$lib/server/covercache';


/**
 * The headers a cached cover is served with. They match what the proxy sends,
 * or a cover would be inert from upstream and scriptable from disk.
 */
function cachedHeaders(contentType: string, etag: string): Headers {
	return new Headers({
		'content-type': contentType,
		etag,
		'cache-control': 'private, max-age=86400, stale-while-revalidate=604800',
		'content-security-policy': "default-src 'none'; sandbox",
		'content-disposition': 'inline',
		'x-content-type-options': 'nosniff',
		'accept-ranges': 'bytes'
	});
}

const handler: RequestHandler = async (event) => {
	const session = event.locals.session;
	if (!session) error(401, 'Not signed in');
	const size = nearestCoverSize(event.url.searchParams.get('size'));
	const id = event.params.id;
	// A cached cover skips the music server, so its permission check does not
	// run on a hit. The scope stands in for it: on Jellyfin the key carries the
	// viewer, so a hit is this account's own earlier fetch.
	const scope = coverScope(session.account);

	const hit = await readCover(scope, id, size);
	if (hit) {
		const headers = cachedHeaders(hit.contentType, hit.etag);
		// Without this a browser revalidating after its max-age would be sent the
		// whole cover again, where the proxy would have relayed a 304.
		if (event.request.headers.get('if-none-match') === hit.etag) {
			return new Response(null, { status: 304, headers });
		}
		return new Response(event.request.method === 'HEAD' ? null : new Uint8Array(hit.body), {
			status: 200,
			headers
		});
	}

	const req = streamRequestFrom(event);
	const response = await proxyMedia(event, 'cover', (media) =>
		media.openCover(session.credential, id, size, req)
	);

	/*
	 * Cached on the way past.
	 *
	 * The body is split as it arrives: one half goes to the browser, the other
	 * is collected and written once complete, so a client that disconnects
	 * leaves no half-written file. Read whole before the first byte was sent,
	 * an uncached cover was held for its whole transfer from the music server.
	 * Only a plain 200 is kept: a 206 is a fragment and a 304 has no body.
	 *
	 * Both halves are read to the end. A clone left one unread, and an unread
	 * body holds the upstream connection open until it is collected. A client
	 * that goes away cancels only its own half, and the cover is still stored.
	 */
	if (response.status === 200 && event.request.method === 'GET' && response.body) {
		const type = response.headers.get('content-type') ?? '';
		const [toClient, toCache] = response.body.tee();
		void collectCover(toCache).then((body) => {
			if (body) return writeCover(scope, id, size, type, body);
		});
		return new Response(toClient, { status: 200, headers: response.headers });
	}

	return response;
};

export const GET = handler;
export const HEAD = handler;
