/**
 * Media proxying.
 *
 * This is the heart of Heddohon's security posture. Feishin and Aonsoku hand
 * the browser a direct URL to the music server, which means the browser must be
 * able to reach it — so a Navidrome on 10.0.0.10 is unreachable the moment you
 * are off that network, and the upstream credential ends up in the client.
 *
 * Here every byte is fetched by the Node process instead. The browser only ever
 * talks to Heddohon, the upstream hostname never leaves the server, and the
 * credential never enters a page. The cost is that the server carries the
 * bandwidth; the benefit is that a single reverse-proxied hostname is all that
 * has to be exposed.
 */
import { error, type RequestEvent } from '@sveltejs/kit';
import { backendFor, UpstreamError } from './backends';
import { destroyAllSessions } from './auth';
import { relayHeaders } from './backends/http';
import type { UpstreamResponse } from './backends/types';
import { bytesOf, settled, transcodeFor, type Transcode } from './transcodes';

export type MediaKind = 'stream' | 'cover';

/**
 * The only top-level content types each endpoint may serve.
 *
 * The proxy relays the upstream's own `content-type`, which means the upstream
 * decides what the browser thinks it is being handed — from *our* origin.
 * Demonstrated before this existed: a cover declaring `text/html` was served as
 * HTML by Heddohon and its script ran with full same-origin access to the
 * signed-in API. That needs no compromise of the music server, only a file in
 * the library that it is willing to describe that way.
 *
 * Anything outside the list becomes an opaque download instead. A browser will
 * not render it, and the two things that would have been worth injecting —
 * markup and script — are exactly what falls outside.
 */
const ALLOWED_PREFIX: Record<MediaKind, string> = {
	stream: 'audio/',
	cover: 'image/'
};

/**
 * SVG is an image by content type and a scriptable document by behaviour, so
 * the prefix check above lets it through. This makes every media response inert
 * when it is navigated to directly: no scripts, no plugins, no same-origin
 * anything. It costs nothing for an `<img>` or an `<audio>`, which do not
 * execute the response either way.
 */
const MEDIA_CSP = "default-src 'none'; sandbox";

/** One media type, with nothing after it: no parameters, no second type. */
const MEDIA_ESSENCE = /^(audio|image)\/[a-z0-9][a-z0-9.+-]{0,62}$/;

const CACHE_CONTROL: Record<MediaKind, string> = {
	// Audio is large and immutable per id, but it is also private to the account,
	// so it may be cached by the browser and never by a shared proxy.
	stream: 'private, max-age=3600',
	cover: 'private, max-age=86400, stale-while-revalidate=604800'
};

/**
 * Allowed cover sizes, so the upstream cannot be asked to render arbitrary
 * dimensions. 1536 is here for the player panel's artwork at twice the density:
 * measured on a 2560x1440 display at devicePixelRatio 2, that panel draws its
 * cover into a box 1052x1700 device pixels, and the largest size below this one
 * would be stretched to fill it.
 */
const COVER_SIZES = [64, 96, 128, 192, 256, 384, 512, 768, 1024, 1536];

export function nearestCoverSize(requested: string | null): number {
	const value = Number(requested);
	if (!Number.isFinite(value)) return 256;
	return COVER_SIZES.reduce(
		(best, size) => (Math.abs(size - value) < Math.abs(best - value) ? size : best),
		COVER_SIZES[0]
	);
}

export async function proxyMedia(
	event: RequestEvent,
	kind: MediaKind,
	open: (backend: ReturnType<typeof backendFor>) => Promise<UpstreamResponse>,
	/** `estimatedLength`: the upstream's `Content-Length` is a guess (a transcode). */
	options: { estimatedLength?: boolean } = {}
): Promise<Response> {
	const session = event.locals.session;
	if (!session) error(401, 'Not signed in');

	return relay(event, kind, () => open(backendFor(session.account.backend)), async () => {
		// The stored credential no longer works upstream (password changed,
		// Jellyfin token revoked). Sessions built on it are worthless.
		await destroyAllSessions(session.account.id);
		error(401, 'The music server rejected your saved credentials. Please sign in again.');
	}, false, options);
}

/**
 * Media for a shared link, fetched with the sharer's credential.
 *
 * The caller has already resolved the token and decides which song or cover is
 * opened; nothing in the request names one. A rejected credential answers 404
 * and leaves the sharer's sessions alone: the visitor is anonymous, and the
 * sharer's own next request reports the rejection to the sharer.
 */
export async function proxySharedMedia(
	event: RequestEvent,
	kind: MediaKind,
	open: () => Promise<UpstreamResponse>
): Promise<Response> {
	const response = await relay(event, kind, open, () => error(404, 'Not found'), true);
	// Shorter than an account's own media: a withdrawn link should stop working
	// in the browser that played it, not an hour or a day later from its cache.
	response.headers.set('cache-control', SHARED_CACHE_CONTROL[kind]);
	return response;
}

const SHARED_CACHE_CONTROL: Record<MediaKind, string> = {
	stream: 'private, no-store',
	cover: 'private, max-age=300'
};

async function relay(
	event: RequestEvent,
	kind: MediaKind,
	open: () => Promise<UpstreamResponse>,
	rejected: () => Promise<never> | never,
	/**
	 * Refuse a body of the wrong type outright instead of relaying it as a
	 * download. For shared links: a Subsonic server answers `stream.view` with a
	 * credential it rejects by sending its error envelope as a 200, and that is
	 * not something to hand an anonymous visitor, even as an opaque file.
	 */
	strict = false,
	options: { estimatedLength?: boolean } = {}
): Promise<Response> {
	let upstream: UpstreamResponse;
	try {
		upstream = await open();
	} catch (err) {
		if (err instanceof UpstreamError) {
			if (err.kind === 'auth') await rejected();
			// A shared link's visitor may have no account, and the upstream's own
			// wording ("Could not reach the music server: fetch failed") is detail
			// for the log, not for them.
			if (strict) error(err.status === 404 ? 404 : 502, err.status === 404 ? 'Not found' : 'Unavailable');
			error(err.status === 404 ? 404 : 502, err.message);
		}
		throw err;
	}

	if (upstream.status === 401 || upstream.status === 403) await rejected();
	if (upstream.status === 404) error(404, 'Not found');
	if (upstream.status >= 400) error(502, strict ? 'Unavailable' : `Music server returned HTTP ${upstream.status}`);

	/*
	 * Reduced to one bare `type/subtype` and checked in that form, and only that
	 * form is sent on. A prefix test on the raw value passed `image/png,
	 * text/html`, which is what fetch makes of two `content-type` headers, and a
	 * browser reading that header takes the last type in the list.
	 */
	const essence = (upstream.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
	const allowed = MEDIA_ESSENCE.test(essence) && essence.startsWith(ALLOWED_PREFIX[kind]);
	if (strict && !allowed && upstream.status !== 304 && upstream.status !== 204) {
		await upstream.body?.cancel().catch(() => undefined);
		await rejected();
	}
	const safeType = allowed ? essence : 'application/octet-stream';

	const headers = relayHeaders(upstream.headers, {
		'cache-control': CACHE_CONTROL[kind],
		'x-content-type-options': 'nosniff',
		'content-type': safeType,
		'content-security-policy': MEDIA_CSP,
		// Nothing upstream has any business naming the file the browser saves, and
		// a relayed filename is a place to hide a second extension.
		'content-disposition': 'inline'
	});

	// 204/304 must not carry a body.
	if (upstream.status === 304 || upstream.status === 204) {
		return new Response(null, { status: upstream.status, headers });
	}

	const range = parseRange(event.request.headers.get('range'));
	if (upstream.status === 200 && range) {
		return rangeIgnored(event, upstream, headers, range, options.estimatedLength === true);
	}

	// Range support is what makes seeking work: say so when the upstream did,
	// or when it answered a range with a range.
	if (upstream.status === 206 && !headers.has('accept-ranges')) headers.set('accept-ranges', 'bytes');

	return new Response(event.request.method === 'HEAD' ? null : upstream.body, {
		status: upstream.status,
		headers
	});
}

/** The first byte and, when given, the last byte of a single `bytes=` range. */
function parseRange(value: string | null): { start: number; end: number | null } | null {
	const match = /^bytes=(\d+)-(\d*)$/.exec(value?.trim() ?? '');
	if (!match) return null;
	const start = Number(match[1]);
	const end = match[2] === '' ? null : Number(match[2]);
	if (!Number.isSafeInteger(start) || (end !== null && (!Number.isSafeInteger(end) || end < start))) return null;
	return { start, end };
}

/**
 * The browser asked for a range and the music server sent the whole thing
 * from byte 0.
 *
 * Navidrome does this while a transcode is still running: until it is
 * finished and cached, a `Range` header is ignored. Measured against
 * Navidrome 0.64.1 on 2026-09-25: `bytes=1500000-` asked of a transcode in
 * progress came back 200, from the first byte of the song, with an estimated
 * `Content-Length` 2.4 percent longer than what was sent. This proxy then
 * added `Accept-Ranges: bytes` on the upstream's behalf, so iOS Safari, which
 * reads media in ranges, asked for the next part of the file, was given the
 * start of the song, and played it as the continuation: the song started
 * over while the element's clock and the progress bar carried on.
 *
 * - From byte 0: the stream is relayed as a 200 without a claim of range
 *   support, and without the length when it is an estimate, so the browser
 *   reads it as one continuous stream and does not ask for a range of it.
 * - From further in: the bytes asked for are sent as a 206, by reading past
 *   the start of the upstream body. Only a browser that was told the file
 *   supports ranges asks this, and it has to get the bytes it asked for.
 *   Without an upstream length there is no valid `Content-Range`, and the
 *   answer is 416.
 */
function rangeIgnored(
	event: RequestEvent,
	upstream: UpstreamResponse,
	headers: Headers,
	range: { start: number; end: number | null },
	estimatedLength: boolean
): Response {
	headers.delete('accept-ranges');
	headers.delete('content-range');
	const head = event.request.method === 'HEAD';

	if (range.start === 0) {
		if (estimatedLength) headers.delete('content-length');
		return new Response(head ? null : upstream.body, { status: 200, headers });
	}

	const total = Number(upstream.headers.get('content-length'));
	if (!Number.isSafeInteger(total) || total <= 0 || range.start >= total) {
		void upstream.body?.cancel().catch(() => undefined);
		headers.delete('content-length');
		headers.set('content-range', `bytes */${Number.isSafeInteger(total) && total > 0 ? total : '*'}`);
		return new Response(null, { status: 416, headers });
	}

	const end = Math.min(range.end ?? total - 1, total - 1);
	headers.set('content-range', `bytes ${range.start}-${end}/${total}`);
	headers.set('content-length', String(end - range.start + 1));
	headers.set('accept-ranges', 'bytes');
	if (head || !upstream.body) {
		void upstream.body?.cancel().catch(() => undefined);
		return new Response(null, { status: 206, headers });
	}
	return new Response(slice(upstream.body, range.start, end), { status: 206, headers });
}

/** The bytes from `start` to `end` inclusive of a stream, cancelling the rest. */
function slice(body: ReadableStream<Uint8Array>, start: number, end: number): ReadableStream<Uint8Array> {
	const reader = body.getReader();
	let position = 0;
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) {
					controller.close();
					return;
				}
				const from = position;
				position += value.byteLength;
				if (position <= start) continue;
				const chunk = value.subarray(Math.max(0, start - from), Math.min(value.byteLength, end + 1 - from));
				if (chunk.byteLength > 0) controller.enqueue(chunk);
				if (position > end) {
					controller.close();
					await reader.cancel().catch(() => undefined);
				}
				return;
			}
		},
		cancel(reason) {
			return reader.cancel(reason);
		}
	});
}

/** Reads the ranged-request headers a media proxy needs to forward. */
export function streamRequestFrom(event: RequestEvent) {
	return {
		range: event.request.headers.get('range'),
		ifNoneMatch: event.request.headers.get('if-none-match'),
		ifModifiedSince: event.request.headers.get('if-modified-since'),
		method: event.request.method === 'HEAD' ? ('HEAD' as const) : ('GET' as const),
		signal: event.request.signal
	};
}

/**
 * A transcode, answered from one whole read of it held in `transcodes.ts`,
 * so that a range asked of it gets exactly those bytes and a stream that
 * dropped can be picked up where it stopped.
 *
 * Until the read is whole, a request from byte 0 gets the transcode as it
 * arrives, as a 200 without a length or a claim of ranges, and marked not to
 * be kept by the browser: the player asks again for a position it could not
 * seek to, and the answer to that has to come from here, not from the
 * browser's copy of a stream without ranges. A range from further in waits
 * for the read to finish, which is seconds (see `transcodes.ts`). Once whole,
 * every request gets exact ranges and the real length.
 *
 * `fallback` answers instead for a transcode too large to hold.
 */
export async function proxyTranscode(
	event: RequestEvent,
	key: string,
	open: (backend: ReturnType<typeof backendFor>) => Promise<UpstreamResponse>,
	fallback: () => Promise<Response>
): Promise<Response> {
	const session = event.locals.session;
	if (!session) error(401, 'Not signed in');

	let entry: Transcode | null;
	try {
		entry = await transcodeFor(key, session.account.id, async () => {
			const upstream = await open(backendFor(session.account.backend));
			if (upstream.status === 401 || upstream.status === 403) {
				await upstream.body?.cancel().catch(() => undefined);
				await destroyAllSessions(session.account.id);
				error(401, 'The music server rejected your saved credentials. Please sign in again.');
			}
			if (upstream.status === 404) error(404, 'Not found');
			if (upstream.status >= 400) error(502, `Music server returned HTTP ${upstream.status}`);
			const essence = (upstream.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
			if (!upstream.body || !MEDIA_ESSENCE.test(essence) || !essence.startsWith(ALLOWED_PREFIX.stream)) {
				await upstream.body?.cancel().catch(() => undefined);
				error(502, 'The music server did not send audio');
			}
			return { body: upstream.body, type: essence };
		});
	} catch (err) {
		if (err instanceof UpstreamError) {
			if (err.kind === 'auth') {
				await destroyAllSessions(session.account.id);
				error(401, 'The music server rejected your saved credentials. Please sign in again.');
			}
			error(err.status === 404 ? 404 : 502, err.message);
		}
		throw err;
	}

	// Past the limits in `transcodes.ts`: relayed as it comes, as before.
	if (!entry) return fallback();

	const range = parseRange(event.request.headers.get('range'));
	if (!entry.done && range && range.start > 0) await settled(entry, 30_000);
	if (entry.failed === 'oversize') return fallback();

	const headers = new Headers({
		'cache-control': CACHE_CONTROL.stream,
		'x-content-type-options': 'nosniff',
		'content-type': entry.type,
		'content-security-policy': MEDIA_CSP,
		'content-disposition': 'inline'
	});
	const head = event.request.method === 'HEAD';

	if (!entry.done) {
		if (range && range.start > 0) {
			// Not whole after 30 seconds, or the read failed: nothing exact to send.
			headers.set('retry-after', '2');
			return new Response(null, { status: 503, headers });
		}
		headers.set('cache-control', 'private, no-store');
		return new Response(head ? null : bytesOf(entry, 0, null), { status: 200, headers });
	}

	const total = entry.size;
	headers.set('accept-ranges', 'bytes');
	if (!range) {
		headers.set('content-length', String(total));
		return new Response(head ? null : bytesOf(entry, 0, total - 1), { status: 200, headers });
	}
	if (range.start >= total) {
		headers.set('content-range', `bytes */${total}`);
		return new Response(null, { status: 416, headers });
	}
	const end = Math.min(range.end ?? total - 1, total - 1);
	headers.set('content-range', `bytes ${range.start}-${end}/${total}`);
	headers.set('content-length', String(end - range.start + 1));
	return new Response(head ? null : bytesOf(entry, range.start, end), { status: 206, headers });
}
