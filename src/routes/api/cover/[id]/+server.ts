import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { proxyMedia, streamRequestFrom } from '$lib/server/proxy';
import { coverScope, readCover, writeCover } from '$lib/server/covercache';

/**
 * Allowed cover sizes, so the upstream cannot be asked to render arbitrary
 * dimensions. 1536 is here for the player panel's artwork at twice the density:
 * measured on a 2560x1440 display at devicePixelRatio 2, that panel draws its
 * cover into a box 1052x1700 device pixels, and the largest size below this one
 * would be stretched to fill it.
 */
const SIZES = [64, 96, 128, 192, 256, 384, 512, 768, 1024, 1536];

function nearestSize(requested: string | null): number {
	const value = Number(requested);
	if (!Number.isFinite(value)) return 256;
	return SIZES.reduce((best, size) => (Math.abs(size - value) < Math.abs(best - value) ? size : best), SIZES[0]);
}

/**
 * The headers a cached cover is served with.
 *
 * They have to match what the proxy sends, or a cover would be inert when it
 * came from upstream and scriptable when it came from disk. The list is short
 * enough to state twice, and stating it here is safer than exporting the
 * proxy's internals for one caller.
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
	const size = nearestSize(event.url.searchParams.get('size'));
	const id = event.params.id;
	// A cached cover skips the music server entirely, so the upstream's own
	// permission check never runs on a hit. The scope is what stands in for it:
	// on Jellyfin the key carries the viewer, so a hit can only ever be this
	// account's own earlier fetch.
	const scope = coverScope(session.account);

	const hit = await readCover(scope, id, size);
	if (hit) {
		const headers = cachedHeaders(hit.contentType, hit.etag);
		// Without this a browser revalidating after the day its max-age allows
		// would be sent the whole cover again, where the proxy would have relayed
		// the music server's 304.
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
	 * Cache on the way past.
	 *
	 * The body is read into memory rather than written to disk as it streams: a
	 * cover is small, MAX_ENTRY_BYTES caps what is held, and a buffer cannot
	 * leave a half-written file behind if the client disconnects. Only a plain
	 * 200 is kept; a 206 is a fragment and a 304 has no body.
	 *
	 * The stream is consumed here rather than cloned. A clone leaves the
	 * original body unread, and an unread body holds the upstream connection
	 * open until it is collected.
	 */
	if (response.status === 200 && event.request.method === 'GET') {
		const type = response.headers.get('content-type') ?? '';
		const body = Buffer.from(await response.arrayBuffer());
		void writeCover(scope, id, size, type, body);
		return new Response(new Uint8Array(body), { status: 200, headers: response.headers });
	}

	return response;
};

export const GET = handler;
export const HEAD = handler;
