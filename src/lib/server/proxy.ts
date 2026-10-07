/**
 * Media proxying.
 *
 * Every byte is fetched by this process. The browser talks only to Heddohon:
 * the upstream hostname stays on the server and the credential never enters a
 * page, where clients such as Feishin and Aonsoku give the browser a direct
 * URL to the music server. The server carries the bandwidth, and one
 * reverse-proxied hostname is all that is exposed.
 */
import { error, type RequestEvent } from '@sveltejs/kit';
import { backendFor, UpstreamError } from './backends';
import { destroyAllSessions } from './auth';
import { relayHeaders } from './backends/http';
import type { TranscodeRequest, UpstreamResponse } from './backends/types';
import { stableOgg } from './ogg';
import { bytesOf, settled, transcodeFor, type Transcode } from './transcodes';

export type MediaKind = 'stream' | 'cover';

/**
 * The only top-level content types each endpoint may serve.
 *
 * The upstream's `content-type` is relayed from this origin. A cover declared
 * `text/html` was served as HTML and its script ran with same-origin access to
 * the signed-in API, which takes only a file in the library the music server
 * describes that way. Anything outside the list becomes an opaque download.
 */
const ALLOWED_PREFIX: Record<MediaKind, string> = {
	stream: 'audio/',
	cover: 'image/'
};

/**
 * SVG passes the prefix check above and is a scriptable document. This makes
 * every media response inert when navigated to directly. An `<img>` or an
 * `<audio>` does not execute the response either way.
 */
export const MEDIA_CSP = "default-src 'none'; sandbox";

/** One media type, with nothing after it: no parameters, no second type. */
const MEDIA_ESSENCE = /^(audio|image)\/[a-z0-9][a-z0-9.+-]{0,62}$/;

const CACHE_CONTROL: Record<MediaKind, string> = {
	// Audio is private to the account: cached by the browser, never by a shared
	// proxy.
	stream: 'private, max-age=3600',
	cover: 'private, max-age=86400, stale-while-revalidate=604800'
};

/**
 * Allowed cover sizes, so the upstream cannot be asked for arbitrary
 * dimensions. 1536 is for the player panel at twice the density: on a
 * 2560x1440 display at devicePixelRatio 2 its cover box is 1052x1700 device
 * pixels.
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
	/**
	 * `transcode`: the body is a conversion. Its `Content-Length` is a guess,
	 * and an Ogg one is given fixed serials (`ogg.ts`), as the copy held in
	 * `transcodes.ts` is, so a range answered from either continues the other.
	 */
	options: { transcode?: boolean } = {}
): Promise<Response> {
	const session = event.locals.session;
	if (!session) error(401, 'Not signed in');

	return relay(event, kind, () => open(backendFor(session.account.backend)), async () => {
		// The stored credential no longer works upstream (password changed,
		// Jellyfin token revoked), and neither do the sessions built on it.
		await destroyAllSessions(session.account.id);
		error(401, 'The music server rejected your saved credentials. Please sign in again.');
	}, false, options);
}

/**
 * Media for a shared link, fetched with the sharer's credential.
 *
 * The caller has resolved the token and decides which song or cover is opened.
 * A rejected credential answers 404 and leaves the sharer's sessions alone:
 * the visitor is anonymous, and the sharer's next request reports it to them.
 */
export async function proxySharedMedia(
	event: RequestEvent,
	kind: MediaKind,
	open: () => Promise<UpstreamResponse>
): Promise<Response> {
	const response = await relay(event, kind, open, () => error(404, 'Not found'), true);
	// Shorter than an account's own media, so a withdrawn link stops working in
	// the browser that played it.
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
	 * Refuse a body of the wrong type instead of relaying it as a download. For
	 * shared links: a Subsonic server answers `stream.view` under a rejected
	 * credential with its error envelope as a 200, which an anonymous visitor
	 * should not be handed.
	 */
	strict = false,
	options: { transcode?: boolean } = {}
): Promise<Response> {
	let upstream: UpstreamResponse;
	try {
		upstream = await open();
	} catch (err) {
		if (err instanceof UpstreamError) {
			if (err.kind === 'auth') await rejected();
			// The upstream's wording ("Could not reach the music server: fetch
			// failed") is for the log, not for a shared link's visitor.
			if (strict) error(err.status === 404 ? 404 : 502, err.status === 404 ? 'Not found' : 'Unavailable');
			error(err.status === 404 ? 404 : 502, err.message);
		}
		throw err;
	}

	if (upstream.status === 401 || upstream.status === 403) await rejected();
	if (upstream.status === 404) error(404, 'Not found');
	if (upstream.status >= 400) error(502, strict ? 'Unavailable' : `Music server returned HTTP ${upstream.status}`);

	/*
	 * Reduced to one bare `type/subtype`, checked and sent on in that form. A
	 * prefix test on the raw value passed `image/png, text/html`, which is what
	 * fetch makes of two `content-type` headers, and a browser takes the last
	 * type in the list.
	 */
	const essence = (upstream.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
	const allowed = MEDIA_ESSENCE.test(essence) && essence.startsWith(ALLOWED_PREFIX[kind]);
	if (strict && !allowed && upstream.status !== 304 && upstream.status !== 204) {
		await upstream.body?.cancel().catch(() => undefined);
		await rejected();
	}
	const safeType = allowed ? essence : 'application/octet-stream';
	// Whole bodies only: a 206 starts mid-page. The stream route asks for an
	// Opus transcode without a range for that reason.
	if (options.transcode && safeType === 'audio/ogg' && upstream.status === 200 && upstream.body) {
		upstream = { ...upstream, body: upstream.body.pipeThrough(stableOgg()) };
	}

	const headers = relayHeaders(upstream.headers, {
		'cache-control': CACHE_CONTROL[kind],
		'x-content-type-options': 'nosniff',
		'content-type': safeType,
		'content-security-policy': MEDIA_CSP,
		// A relayed filename is a place to hide a second extension.
		'content-disposition': 'inline'
	});

	// 204/304 must not carry a body.
	if (upstream.status === 304 || upstream.status === 204) {
		return new Response(null, { status: upstream.status, headers });
	}

	const range = parseRange(event.request.headers.get('range'));
	if (upstream.status === 200 && range) {
		return rangeIgnored(event, upstream, headers, range, options.transcode === true);
	}

	// Seeking needs range support: stated when the upstream answered a range
	// with a range.
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
 * Navidrome ignores `Range` while a transcode is running. Against Navidrome
 * 0.64.1 on 2026-09-25, `bytes=1500000-` asked of a transcode in progress came
 * back 200 from the first byte, with an estimated `Content-Length` 2.4 percent
 * too long. This proxy added `Accept-Ranges: bytes`, so iOS Safari asked for
 * the next part, was given the start of the song and played it as the
 * continuation: the song started over while the clock carried on.
 *
 * - From byte 0: relayed as a 200 without a claim of range support, and
 *   without the length when it is an estimate, so the browser reads one
 *   continuous stream.
 * - From further in: the bytes asked for are sent as a 206, by reading past
 *   the start of the upstream body. Without an upstream length there is no
 *   valid `Content-Range`, and the answer is 416.
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
 * The request sent upstream for a transcode relayed as it comes. Opus is asked
 * for whole, whatever range the browser wants: its pages are rewritten as they
 * pass (`ogg.ts`), from the first one, and `rangeIgnored` cuts the range out
 * of the answer.
 */
export function relayRequestFor<T extends { range: string | null }>(req: T, transcode: TranscodeRequest | null): T {
	return transcode?.codec === 'opus' ? { ...req, range: null } : req;
}

/**
 * A transcode, answered from one whole read of it held in `transcodes.ts`, so
 * a range gets exactly those bytes and a dropped stream resumes where it
 * stopped.
 *
 * Until the read is whole, a request from byte 0 gets the transcode as it
 * arrives: a 200 without a length or a claim of ranges, marked not to be kept
 * by the browser, since a later request for a position must be answered from
 * here and not from the browser's copy. A range from further in waits for the
 * read to finish, which takes seconds (see `transcodes.ts`). Once whole, every
 * request gets exact ranges and the real length.
 *
 * A range with an end waits for the read too. Apple's player (Safari, every
 * browser on an iPhone or iPad, an AirPlay receiver) opens a track by asking
 * for `bytes=0-1` and takes the length from the answer. Given a 200 without a
 * length, it plays the track as a live broadcast. On an iPad on 2026-10-07,
 * MP3 and Opus opened that way glitched and went silent, and the volume
 * slider did not move the level. Chromium and Firefox open a track with
 * `bytes=0-`.
 *
 * `fallback` answers for a transcode too large to hold.
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
			return { body: essence === 'audio/ogg' ? upstream.body.pipeThrough(stableOgg()) : upstream.body, type: essence };
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

	// Past the limits in `transcodes.ts`: relayed as it comes.
	if (!entry) return fallback();

	const range = parseRange(event.request.headers.get('range'));
	// `whole` in the address is the player opening a track at a position, which
	// a stream without ranges cannot give it (`#srcOf` in the player). It
	// changes when the answer is sent, not what is sent.
	const wanted = event.url.searchParams.has('whole') || (range !== null && (range.start > 0 || range.end !== null));
	if (!entry.done && wanted) await settled(entry, 30_000);
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
