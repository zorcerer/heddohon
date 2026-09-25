import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { nearestCoverSize, proxyMedia, streamRequestFrom } from '$lib/server/proxy';
import { MAX_ENTRY_BYTES, coverScope, readCover, writeCover } from '$lib/server/covercache';


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
	const size = nearestCoverSize(event.url.searchParams.get('size'));
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
	 * The body is split in two as it arrives: one half goes to the browser and
	 * the other is collected here and written once it is complete, so a buffer
	 * cannot leave a half-written file behind if the client disconnects. The
	 * cover used to be read whole before the first byte was sent, which held
	 * every cover not yet cached for the length of its transfer from the music
	 * server. Only a plain 200 is kept; a 206 is a fragment and a 304 has no
	 * body.
	 *
	 * Both halves are read to the end. A clone left one unread, and an unread
	 * body holds the upstream connection open until it is collected. A client
	 * that goes away cancels only its own half; this one still finishes, and
	 * the cover is still stored.
	 */
	if (response.status === 200 && event.request.method === 'GET' && response.body) {
		const type = response.headers.get('content-type') ?? '';
		const [toClient, toCache] = response.body.tee();
		void collect(toCache).then((body) => {
			if (body) return writeCover(scope, id, size, type, body);
		});
		return new Response(toClient, { status: 200, headers: response.headers });
	}

	return response;
};

/**
 * Reads a stream to the end into one buffer, or gives up with null past
 * `MAX_ENTRY_BYTES` (which `writeCover` would refuse) or on a failed read.
 */
async function collect(stream: ReadableStream<Uint8Array>): Promise<Buffer | null> {
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) return Buffer.concat(chunks, total);
			total += value.byteLength;
			if (total > MAX_ENTRY_BYTES) {
				await reader.cancel();
				return null;
			}
			chunks.push(value);
		}
	} catch {
		return null;
	}
}

export const GET = handler;
export const HEAD = handler;
