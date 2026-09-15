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

const CACHE_CONTROL: Record<MediaKind, string> = {
	// Audio is large and immutable per id, but it is also private to the account,
	// so it may be cached by the browser and never by a shared proxy.
	stream: 'private, max-age=3600',
	cover: 'private, max-age=86400, stale-while-revalidate=604800'
};

export async function proxyMedia(
	event: RequestEvent,
	kind: MediaKind,
	open: (backend: ReturnType<typeof backendFor>) => Promise<UpstreamResponse>
): Promise<Response> {
	const session = event.locals.session;
	if (!session) error(401, 'Not signed in');

	let upstream: UpstreamResponse;
	try {
		upstream = await open(backendFor(session.account.backend));
	} catch (err) {
		if (err instanceof UpstreamError) {
			if (err.kind === 'auth') {
				// The stored credential no longer works upstream (password changed,
				// Jellyfin token revoked). Sessions built on it are worthless.
				destroyAllSessions(session.account.id);
				error(401, 'The music server rejected your saved credentials. Please sign in again.');
			}
			error(err.status === 404 ? 404 : 502, err.message);
		}
		throw err;
	}

	if (upstream.status === 401 || upstream.status === 403) {
		destroyAllSessions(session.account.id);
		error(401, 'The music server rejected your saved credentials. Please sign in again.');
	}
	if (upstream.status === 404) error(404, 'Not found');
	if (upstream.status >= 400) error(502, `Music server returned HTTP ${upstream.status}`);

	const declared = upstream.headers.get('content-type') ?? '';
	const safeType = declared.toLowerCase().startsWith(ALLOWED_PREFIX[kind])
		? declared
		: 'application/octet-stream';

	const headers = relayHeaders(upstream.headers, {
		'cache-control': CACHE_CONTROL[kind],
		// Range support is what makes seeking work. Navidrome and Jellyfin both
		// advertise it; assert it for the rare server that forgets.
		'accept-ranges': upstream.headers.get('accept-ranges') ?? 'bytes',
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

	return new Response(event.request.method === 'HEAD' ? null : upstream.body, {
		status: upstream.status,
		headers
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
