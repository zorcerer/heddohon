import { isRedirect, redirect, type Handle, type HandleServerError } from '@sveltejs/kit';
import { version } from '$app/environment';
import { resolveSession } from '$lib/server/auth';
import { getSettings, DEFAULT_SETTINGS } from '$lib/server/settings';
import { ConfigError, config } from '$lib/server/config';
import {
	isEnabled,
	log,
	logLevel,
	nameRequestUser,
	newRequestId,
	reason,
	withRequest
} from '$lib/server/log';

/** Routes reachable without a session. Everything else requires one. */
const PUBLIC_ROUTES = ['/login', '/healthz'];

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function isPublic(pathname: string): boolean {
	return PUBLIC_ROUTES.some((route) => pathname === route || pathname.startsWith(`${route}/`));
}

/**
 * Applied to every response, including the ones that return before `resolve`.
 * Those early exits — the config 500, the CSRF 403, the 401 — used to ship bare,
 * which is exactly the set an attacker probes first.
 *
 * HSTS is set unconditionally rather than only on https. The app is always
 * behind a TLS-terminating proxy in the deployment it is written for, and the
 * header is ignored by browsers over plain http, so the only thing a condition
 * would add is a way to get it wrong.
 */
function harden(headers: Headers): void {
	headers.set('x-content-type-options', 'nosniff');
	headers.set('referrer-policy', 'same-origin');
	headers.set('x-frame-options', 'SAMEORIGIN');
	headers.set('strict-transport-security', 'max-age=31536000; includeSubDomains');
	headers.set('permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=()');
	headers.set('cross-origin-opener-policy', 'same-origin');
	headers.set('cross-origin-resource-policy', 'same-origin');

	// Every response here is either a signed-in user's own data or an error. The
	// media routes set their own `private, max-age=...` and keep it; everything
	// else had no caching header at all, which leaves a shared proxy or CDN free
	// to apply heuristic caching to a page carrying one account's username,
	// library and playlists and hand it to the next requester.
	if (!headers.has('cache-control')) headers.set('cache-control', 'private, no-store');

	// The session cookie is what distinguishes one user's copy from another's.
	// Without this, two accounts sharing a browser profile read each other's
	// cached covers and streams by URL.
	headers.set('vary', headers.has('vary') ? `${headers.get('vary')}, Cookie` : 'Cookie');
}

function sealed(body: string, status: number, contentType: string): Response {
	const response = new Response(body, {
		status,
		headers: { 'content-type': contentType, 'cache-control': 'no-store' }
	});
	harden(response.headers);
	return response;
}

/**
 * What is running, printed once.
 *
 * On the first request rather than at module load: the module is evaluated
 * during the build as well, where there is no configuration to describe and
 * nobody to read it.
 */
let announced = false;

function announce(): void {
	if (announced) return;
	announced = true;
	try {
		const cfg = config();
		log.info('started', {
			build: version,
			node: process.versions.node,
			logLevel: logLevel(),
			data: cfg.dataDir,
			covers: cfg.coverCacheBytes > 0 ? `${Math.round(cfg.coverCacheBytes / 1024 / 1024)}MB` : 'off',
			sessionHours: cfg.sessionMaxHours,
			cookieSecure: String(cfg.cookieSecure),
			// The upstream host is the one thing kept off the wire; this is the
			// operator's own log, and a deployment pointed at the wrong music
			// server is the first thing they need to see.
			upstreams: cfg.upstreams.map((up) => `${up.kind}=${new URL(up.url).host}`).join(',') || 'none'
		});
	} catch (err) {
		log.error('started-misconfigured', { detail: reason(err) });
	}
}

/**
 * What counts as slow enough to stand out at the default level. This is the
 * time to a response object rather than to the last byte, so a track that
 * streams for four minutes is not slow; a page that took four seconds to build
 * is. `HEDDOHON_LOG_SLOW_MS=0` switches the distinction off.
 */
const slowMs = (() => {
	const raw = Number(process.env.HEDDOHON_LOG_SLOW_MS);
	return Number.isFinite(raw) && raw >= 0 ? raw : 2000;
})();

/**
 * The per-request line, and what it costs.
 *
 * Writing one line for every request measured at 7 to 11 percent of throughput:
 * 636 to 709 requests per second on cached covers, 691 to 739 on the play-state
 * endpoint. A library page opens dozens of covers at once, so that is paid
 * dozens of times per page. It is worth having while working out why something
 * is slow and not worth having the rest of the time, so it lives at debug.
 *
 * Everything below it is arranged so that at the default level this wrapper
 * does almost nothing: no per-request context, no field object built, and a
 * `try` whose only job is to notice a failure.
 */
export const handle: Handle = async (input) => {
	announce();
	const { event } = input;
	const traced = isEnabled('debug');
	const timed = traced || slowMs > 0;
	const started = timed ? performance.now() : 0;

	const run = async (): Promise<Response> => {
		let status = 500;
		let failure: string | undefined;
		try {
			const response = await handleRequest(input);
			status = response.status;
			return response;
		} catch (err) {
			if (isRedirect(err)) status = err.status;
			else failure = reason(err);
			throw err;
		} finally {
			const ms = timed ? Math.round(performance.now() - started) : undefined;
			// A failure, a slow request, or a trace. Nothing else is written, and
			// nothing else is built.
			if (failure || status >= 500 || traced || (ms !== undefined && ms >= slowMs && slowMs > 0)) {
				const fields = {
					method: event.request.method,
					path: event.url.pathname,
					query: traced && event.url.search ? event.url.search : undefined,
					status,
					ms,
					error: failure
				};
				if (failure || status >= 500) log.error('request', fields);
				else if (ms !== undefined && slowMs > 0 && ms >= slowMs) log.warn('request-slow', fields);
				else log.debug('request', fields);
			}
		}
	};

	/*
	 * The request id exists to tie a line written inside a backend adapter to the
	 * request it belongs to, and those lines are all debug. Carrying an async
	 * context through every await of every request to label lines nobody is
	 * printing is a cost with no reader, so it is only established when they are.
	 */
	return traced ? withRequest({ id: newRequestId() }, run) : run();
};

const handleRequest: Handle = async ({ event, resolve }) => {
	// Fail loudly and early on a misconfigured deployment rather than showing a
	// login form that could never work.
	try {
		config();
	} catch (err) {
		// Anything that is not a ConfigError is not something this guard
		// understands, and carrying on would serve a page built on a broken
		// config. Fail closed.
		if (!(err instanceof ConfigError)) throw err;

		if (event.url.pathname === '/healthz') {
			// The probe is the one path that has to keep working on a broken
			// deployment: it is what reports `misconfigured` and turns the
			// container's HEALTHCHECK red. It cannot go through the rest of this
			// function to get there, though. Both the CSRF check and session
			// resolution call config() themselves, so the error would be rethrown
			// from inside them, past the route's own handler, and the probe would
			// answer 500 with the generic upstream message and write an unhandled
			// stack trace every HEALTHCHECK interval. Hand it straight to the route.
			return resolve(event);
		}

		// The detail stays in the log. It names the offending variable *and its
		// value*, and that value is usually the internal music-server address —
		// the one thing this whole proxy design exists to keep off the wire.
		log.error('config-invalid', { detail: err.message, path: event.url.pathname });
		return sealed(
			'Heddohon is not configured correctly. See the server log for which ' +
				'environment variable is at fault, and the README for the full list.',
			500,
			'text/plain; charset=utf-8'
		);
	}

	/*
	 * Cross-origin write protection.
	 *
	 * SvelteKit's built-in CSRF check only covers the content types an HTML form
	 * can post cross-origin. A JSON request is not one of those, so it never gets
	 * checked — and the JSON API is where every state-changing call lives,
	 * including deleting a playlist from the music server.
	 *
	 * This deliberately applies to *every* mutating request rather than to a path
	 * prefix, and that is the whole point. It used to read
	 * `event.url.pathname.startsWith('/api/')`, which was bypassable outright:
	 * SvelteKit matches routes against the percent-decoded path while `event.url`
	 * keeps the raw one, so `POST /%61pi/settings` reached the `/api/settings`
	 * handler without the prefix ever matching. Verified before the fix — that
	 * request returned 200 with `Origin: https://evil.example` and the write
	 * landed. Any normalisation-based gate has the same shape of hole in it, so
	 * there is no gate.
	 *
	 * A missing Origin is rejected too. Browsers send it on every non-GET/HEAD
	 * request, so nothing legitimate loses out; allowing it would have left the
	 * control in the caller's hands rather than ours.
	 */
	if (MUTATING_METHODS.has(event.request.method)) {
		const origin = event.request.headers.get('origin');
		if (origin !== event.url.origin) {
			// Worth a line of its own: a browser sends Origin on every mutating
			// request, so this is either a deployment whose ORIGIN does not match
			// the address it is served on, or a cross-origin write attempt. The
			// two are told apart by whether the same origin appears every time.
			log.warn('cross-origin-blocked', {
				method: event.request.method,
				path: event.url.pathname,
				origin: origin ?? null,
				expected: event.url.origin
			});
			return sealed(
				JSON.stringify({ error: 'cross_origin_forbidden' }),
				403,
				'application/json'
			);
		}
	}

	const session = resolveSession(event);
	event.locals.session = session;
	event.locals.settings = session ? getSettings(session.account.id) : null;
	if (session) nameRequestUser(session.account.username);

	if (!session && !isPublic(event.url.pathname)) {
		// API and media endpoints must fail loudly. Redirecting them to the login
		// page would hand an <audio> element or a fetch() a page of HTML with a
		// 200 on it, which is far harder to debug than a plain 401.
		const isApi =
			event.url.pathname.startsWith('/api/') ||
			event.request.headers.get('accept')?.includes('application/json');
		if (isApi) {
			log.debug('unauthenticated', { path: event.url.pathname, as: 'api' });
			return sealed(JSON.stringify({ error: 'not_authenticated' }), 401, 'application/json');
		}
		log.debug('unauthenticated', { path: event.url.pathname, as: 'page' });
		const next = event.url.pathname + event.url.search;
		redirect(303, `/login?next=${encodeURIComponent(next)}`);
	}

	if (session && event.url.pathname === '/login') {
		redirect(303, '/');
	}

	const response = await resolve(event, {
		// The theme is server-known, so the correct palette is in the very first
		// byte of HTML — no flash of the wrong theme on load.
		transformPageChunk: ({ html }) =>
			html
				.replace('data-theme="dark"', `data-theme="${event.locals.settings?.theme ?? DEFAULT_SETTINGS.theme}"`)
				// Same reason as the theme: the scale is known on the server, so it
				// is in the first byte rather than applied after hydration, which
				// would resize the whole page in front of the reader.
				.replace('data-scale="100"', `data-scale="${event.locals.settings?.uiScale ?? DEFAULT_SETTINGS.uiScale}"`)
	});

	harden(response.headers);
	return response;
};

export const handleError: HandleServerError = ({ error, status, event }) => {
	// The request line records the status; this is the stack behind it, which is
	// the one place a stack is worth the room it takes.
	if (status !== 404) {
		log.error('unhandled', { path: event.url.pathname, detail: reason(error) });
		console.error(error);
	}
	return {
		message:
			status === 404
				? 'That page does not exist.'
				: 'Something went wrong talking to the music server.',
		// Only in development. In production this reached the error page verbatim,
		// which turned any unhandled throw into free reconnaissance — a SQLite
		// error names the data path, a fetch failure names the upstream.
		detail: !import.meta.env.PROD && error instanceof Error ? error.message : undefined
	};
};
