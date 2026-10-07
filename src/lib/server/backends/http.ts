import { config } from '../config';
import { isEnabled, log, reason } from '../log';

export class UpstreamError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly kind: 'auth' | 'not_found' | 'unavailable' | 'protocol' | 'conflict' = 'unavailable'
	) {
		super(message);
		this.name = 'UpstreamError';
	}
}

/**
 * All upstream traffic goes through here, so every call has a timeout. Without
 * one, a music server that accepts a connection and stalls holds the request
 * handler open.
 */
export async function upstreamFetch(url: string, init: RequestInit = {}): Promise<Response> {
	const timeout = config().upstreamTimeoutMs;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(new Error('upstream timeout')), timeout);

	/*
	 * A caller's signal (the client disconnected) also aborts the fetch.
	 *
	 * The listener outlives the `await` below. `fetch` resolves when the
	 * headers arrive, and removing the listener there left a stream being read
	 * to its end after the browser had gone. `once` removes it after it fires.
	 */
	const external = init.signal;
	const onExternalAbort = () => controller.abort(external?.reason);
	if (external) {
		if (external.aborted) onExternalAbort();
		else external.addEventListener('abort', onExternalAbort, { once: true });
	}

	// The path without its query: a Subsonic request carries the username, salt
	// and token as query parameters, so the full URL is a credential.
	const started = performance.now();
	let path: string;
	try {
		path = new URL(url).pathname;
	} catch {
		path = '?';
	}

	try {
		const response = await fetchWithinOrigin(url, { ...init, signal: controller.signal }, path);
		// Time to headers, not to the last byte, which for a stream is minutes
		// later. A page opens dozens of covers, so the fields are built only when
		// the line is printed.
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
			// The client went away, as when somebody skips a track mid-load.
			log.debug('upstream-abandoned', { path, ms });
		} else {
			log.warn('upstream-unreachable', { path, ms, detail: reason(err) });
		}
		// The cause stays in the log line above. Node's text names the host and
		// port (`connect ECONNREFUSED 10.0.0.5:4533`), and this message reaches
		// the browser.
		throw new UpstreamError('Could not reach the music server', 502);
	} finally {
		// Only the timeout is cleared. It guards the wait for headers, and a
		// stream that is slow after them must not be cut.
		clearTimeout(timer);
	}
}

/** Largest JSON answer read from the music server. */
const MAX_JSON_BYTES = 64 * 1024 * 1024;

/**
 * A JSON body from the music server, read under a deadline and a size cap.
 *
 * `upstreamFetch` stops its timer at the headers, and `response.json()` after
 * that had neither: a server that trickled or never ended its body held the
 * request open and grew its buffer. The body gets its own `upstreamTimeoutMs`
 * and is refused past 64MB as it arrives, well above the answers that are not
 * paged (a whole artist index, a whole playlist).
 */
export async function readJson(response: Response): Promise<unknown> {
	const timeout = config().upstreamTimeoutMs;
	const path = response.url ? new URL(response.url).pathname : '?';
	const tooLarge = () => {
		log.warn('upstream-oversized', { path, limit: MAX_JSON_BYTES });
		return new UpstreamError('Music server sent a response over the size cap', 502, 'protocol');
	};
	const declared = Number(response.headers.get('content-length'));
	if (Number.isFinite(declared) && declared > MAX_JSON_BYTES) {
		await response.body?.cancel().catch(() => undefined);
		throw tooLarge();
	}
	if (!response.body) return JSON.parse('');

	const reader = response.body.getReader();
	let timedOut = false;
	// Cancelling settles a pending read as done, which the loop checks for.
	const timer = setTimeout(() => {
		timedOut = true;
		reader.cancel().catch(() => undefined);
	}, timeout);
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (timedOut) {
				log.warn('upstream-timeout', { path, phase: 'body', limit: timeout });
				throw new UpstreamError(`Music server did not finish answering within ${timeout}ms`, 504);
			}
			if (done) break;
			total += value.byteLength;
			if (total > MAX_JSON_BYTES) {
				await reader.cancel().catch(() => undefined);
				throw tooLarge();
			}
			chunks.push(value);
		}
	} finally {
		clearTimeout(timer);
	}
	return JSON.parse(new TextDecoder().decode(Buffer.concat(chunks)));
}

/** Redirects one upstream call may follow before it is treated as a failure. */
const MAX_REDIRECTS = 5;

/**
 * Whether a redirect from `from` to `to` stays on the configured music server:
 * the same origin, or the same host moving from http to https, as a reverse
 * proxy in front of Jellyfin does. https to http is refused: it would send a
 * Subsonic query string, which carries the account's token, in clear.
 */
function sameServer(from: URL, to: URL): boolean {
	if (to.origin === from.origin) return true;
	return from.protocol === 'http:' && to.protocol === 'https:' && to.hostname === from.hostname;
}

/**
 * `fetch`, following redirects only while they stay on the music server.
 *
 * With `redirect: 'follow'` a compromised or misconfigured music server could
 * aim Heddohon at the internal network, and a Jellyfin login body was replayed
 * to the target. Shared links made that reachable without an account.
 *
 * Followed by hand with fetch's method rules: 303 becomes a GET without a
 * body, as do 301 and 302 after a POST, and 307 and 308 keep both. Redirects
 * are followed at all since Jellyfin's `/Audio/{id}/universal` redirects
 * within the server.
 */
async function fetchWithinOrigin(url: string, init: RequestInit, path: string): Promise<Response> {
	const start = new URL(url);
	let current = start;
	let request: RequestInit = { ...init, redirect: 'manual' };

	for (let hop = 0; ; hop++) {
		const response = await fetch(current, request);
		const location = response.headers.get('location');
		if (response.status < 300 || response.status > 399 || response.status === 304 || !location) {
			return response;
		}
		await response.body?.cancel().catch(() => undefined);

		let target: URL;
		try {
			target = new URL(location, current);
		} catch {
			throw new Error('the music server sent a redirect that is not a URL');
		}
		if (!sameServer(start, target)) {
			log.warn('upstream-redirect-refused', { path, status: response.status, to: target.host });
			throw new Error('the music server redirected to another address');
		}
		if (hop + 1 >= MAX_REDIRECTS) throw new Error('the music server redirected too many times');

		const method = (request.method ?? 'GET').toUpperCase();
		if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST')) {
			const headers = new Headers(request.headers);
			headers.delete('content-type');
			headers.delete('content-length');
			request = { ...request, method: method === 'HEAD' ? 'HEAD' : 'GET', body: undefined, headers };
		}
		current = target;
	}
}

/**
 * Upstream calls one request may have in flight where it fans out.
 * `/api/songs` takes 1000 ids and Subsonic has no batch lookup, so an
 * unbounded `Promise.all` opened 1000 concurrent `getSong.view` calls.
 */
const UPSTREAM_FANOUT = 8;

/**
 * `Promise.all` over `items` with at most `limit` calls running. Results keep
 * the input order and the first rejection rejects the call. No further calls
 * start after a rejection, or after `signal` aborts: with the browser gone,
 * 300 albums at 200ms each ran on for seconds, eight connections at a time.
 */
export async function mapLimited<T, R>(
	items: readonly T[],
	fn: (item: T) => Promise<R>,
	limit = UPSTREAM_FANOUT,
	signal?: AbortSignal
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	let failed = false;
	const worker = async () => {
		while (!failed && !signal?.aborted && next < items.length) {
			const index = next++;
			try {
				results[index] = await fn(items[index]);
			} catch (err) {
				failed = true;
				throw err;
			}
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return results;
}

/**
 * Builds a URL from the operator-configured base and a fixed path. Ids go
 * through `URLSearchParams` or `encodeURIComponent`, never concatenated raw.
 */
export type UpstreamParams = Record<string, string | number | Array<string | number> | undefined>;

/**
 * Ids that must never reach a URL. `encodeURIComponent` does not escape `.`,
 * so an id of `..` survives into a path segment and `new URL()` resolves it
 * upward: `/Items/../x` becomes `/x`. That reaches another endpoint on the
 * operator's own server, with the caller's own credential.
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
			// Subsonic takes repeated keys for lists (`songId=a&songId=b`), so an
			// array appends.
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
