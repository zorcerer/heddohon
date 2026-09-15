import { config } from '../config';
import { isEnabled, log, reason } from '../log';

export class UpstreamError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly kind: 'auth' | 'not_found' | 'unavailable' | 'protocol' = 'unavailable'
	) {
		super(message);
		this.name = 'UpstreamError';
	}
}

/**
 * All upstream traffic goes through here so every call gets a timeout. Without
 * one, a music server that accepts a connection and then stalls would pin a
 * request handler open indefinitely.
 */
export async function upstreamFetch(url: string, init: RequestInit = {}): Promise<Response> {
	const timeout = config().upstreamTimeoutMs;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(new Error('upstream timeout')), timeout);

	/*
	 * A caller-supplied signal (client disconnected) must also abort the fetch.
	 *
	 * This listener deliberately outlives the `await` below. `fetch` resolves as
	 * soon as the headers arrive, and for a stream that is when the interesting
	 * part starts: tearing the listener down there left a browser that walked
	 * away mid-track with its upstream connection still being read to the end,
	 * into nothing. `once` means it cleans itself up after firing, and the
	 * signal it is attached to lives no longer than the request.
	 */
	const external = init.signal;
	const onExternalAbort = () => controller.abort(external?.reason);
	if (external) {
		if (external.aborted) onExternalAbort();
		else external.addEventListener('abort', onExternalAbort, { once: true });
	}

	/*
	 * The path without its query.
	 *
	 * A Subsonic request carries the account's username, salt and token as query
	 * parameters, so the full URL is a credential. The path is the part that says
	 * what was asked for, and it is the same shape on both backends.
	 */
	const started = performance.now();
	let path: string;
	try {
		path = new URL(url).pathname;
	} catch {
		path = '?';
	}

	try {
		const response = await fetch(url, { ...init, signal: controller.signal, redirect: 'follow' });
		// Time to headers, not to the last byte: for a stream those are minutes
		// apart, and it is the wait before anything happens that is worth seeing.
		// A page opens dozens of covers, so the line is only built when one of
		// the two conditions that print it holds.
		if (response.status >= 500 || isEnabled('debug')) {
			const fields = {
				path,
				status: response.status,
				ms: Math.round(performance.now() - started),
				method: init.method ?? 'GET'
			};
			if (response.status >= 500) log.warn('upstream', fields);
			else log.debug('upstream', fields);
		}
		return response;
	} catch (err) {
		const ms = Math.round(performance.now() - started);
		if (controller.signal.aborted && !external?.aborted) {
			log.warn('upstream-timeout', { path, ms, limit: timeout });
			throw new UpstreamError(`Music server did not respond within ${timeout}ms`, 504);
		}
		if (external?.aborted) {
			// The client went away. Ordinary when somebody skips a track mid-load,
			// and not a fault of the music server.
			log.debug('upstream-abandoned', { path, ms });
		} else {
			log.warn('upstream-unreachable', { path, ms, detail: reason(err) });
		}
		throw new UpstreamError(
			`Could not reach the music server: ${err instanceof Error ? err.message : String(err)}`,
			502
		);
	} finally {
		// Only the timeout is stood down here. The timer guards the wait for
		// headers; once they are in, a slow-but-healthy stream must not be shot.
		clearTimeout(timer);
	}
}

/**
 * Builds a URL from the operator-configured base plus a fixed path. IDs are
 * always passed through `URLSearchParams` or `encodeURIComponent`, never
 * concatenated raw, so a hostile item id cannot escape the path.
 */
export type UpstreamParams = Record<string, string | number | Array<string | number> | undefined>;

/**
 * Ids that must never reach a URL.
 *
 * `encodeURIComponent` escapes `/` but not `.`, so an id of `..` survives into a
 * path segment intact and `new URL()` then resolves it upward — `/Items/../x`
 * becomes `/x`. It stays on the operator's own server with the caller's own
 * credential, so this is a wrong-endpoint bug rather than a way out, but the
 * claim that ids cannot escape their segment was simply not true.
 */
export function assertSafeId(id: string): string {
	if (id === '.' || id === '..' || id === '') {
		throw new UpstreamError('Not found', 404, 'not_found');
	}
	return id;
}

export function upstreamUrl(base: string, path: string, params?: UpstreamParams): string {
	const url = new URL(base + path);
	if (params) {
		for (const [key, value] of Object.entries(params)) {
			if (value === undefined) continue;
			// Subsonic takes repeated keys for lists — `songId=a&songId=b` — so an
			// array appends rather than overwriting.
			if (Array.isArray(value)) {
				for (const item of value) url.searchParams.append(key, String(item));
			} else {
				url.searchParams.set(key, String(value));
			}
		}
	}
	return url.toString();
}

/** Response headers that are safe and useful to relay to the browser. */
const RELAY_HEADERS = [
	'content-type',
	'content-length',
	'content-range',
	'accept-ranges',
	'etag',
	'last-modified',
	'content-disposition'
];

export function relayHeaders(source: Headers, extra?: Record<string, string>): Headers {
	const out = new Headers();
	for (const name of RELAY_HEADERS) {
		const value = source.get(name);
		if (value !== null) out.set(name, value);
	}
	for (const [key, value] of Object.entries(extra ?? {})) out.set(key, value);
	return out;
}

/** Forwards only the request headers that matter for ranged media delivery. */
export function forwardRequestHeaders(req: {
	range?: string | null;
	ifNoneMatch?: string | null;
	ifModifiedSince?: string | null;
}): Record<string, string> {
	const headers: Record<string, string> = {};
	if (req.range) headers['range'] = req.range;
	if (req.ifNoneMatch) headers['if-none-match'] = req.ifNoneMatch;
	if (req.ifModifiedSince) headers['if-modified-since'] = req.ifModifiedSince;
	return headers;
}
