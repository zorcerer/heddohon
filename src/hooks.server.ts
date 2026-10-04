import { isRedirect, redirect, type Handle, type HandleServerError, type RequestEvent } from '@sveltejs/kit';
import { version } from '$app/environment';
import { resolveSession } from '$lib/server/auth';
import { getSettings, DEFAULT_SETTINGS, THEME_GROUND } from '$lib/server/settings';
import { ConfigError, config } from '$lib/server/config';
import { FALLBACK_HTML_CSP, SECURITY_HEADERS } from '$lib/headers';
import {
	isEnabled,
	log,
	logLevel,
	nameRequestUser,
	newRequestId,
	reason,
	redact,
	withRequest
} from '$lib/server/log';
import { logKeepDays } from '$lib/server/logfile';
import { keepCoversFilled } from '$lib/server/coverfill';

/**
 * Routes reachable without a session.
 *
 * Every route under `/share` resolves the token itself, serves the one song
 * the link names and accepts no write. See `lib/server/shares.ts`.
 */
const PUBLIC_ROUTES = ['/login', '/healthz', '/share', '/cast', '/together', '/manifest.webmanifest', '/.well-known/assetlinks.json'];

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function isPublic(pathname: string): boolean {
	return PUBLIC_ROUTES.some((route) => pathname === route || pathname.startsWith(`${route}/`));
}

/**
 * Applied to every response, including those that return before `resolve`
 * (the config 500, the CSRF 403, the 401). The list and its reasons are in
 * `lib/headers.ts`.
 */
function harden(headers: Headers): void {
	for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value);

	if (headers.get('content-type')?.startsWith('text/html') && !headers.has('content-security-policy')) {
		headers.set('content-security-policy', FALLBACK_HTML_CSP);
	}

	// The media routes set their own `private, max-age=...`. Anything else
	// carries one account's data, and with no caching header a shared proxy or
	// CDN may cache it heuristically and serve it to the next requester.
	if (!headers.has('cache-control')) headers.set('cache-control', 'private, no-store');

	// Without this, two accounts in one browser profile read each other's
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
 * The gate's own redirects, with the hardening headers. A thrown `redirect()`
 * is answered by SvelteKit outside this handle, without them.
 */
function sealedRedirect(event: RequestEvent, location: string): Response {
	// A client-side navigation asks for `__data.json`, and SvelteKit turns a
	// thrown redirect into the JSON its router follows. A bare 303 there would
	// give the router the login page's HTML.
	if (event.isDataRequest) redirect(303, location);
	const response = new Response(null, { status: 303, headers: { location } });
	harden(response.headers);
	return response;
}

/**
 * What is running, printed once, on the first request. The module is also
 * evaluated during the build, where there is no configuration.
 */
let announced = false;

function announce(): void {
	if (announced) return;
	announced = true;
	try {
		const cfg = config();
		keepCoversFilled();
		log.info('started', {
			build: version,
			node: process.versions.node,
			logLevel: logLevel(),
			logFiles: logKeepDays() > 0 ? `${logKeepDays()}d` : 'off',
			data: cfg.dataDir,
			covers: cfg.coverCacheBytes > 0 ? `${Math.round(cfg.coverCacheBytes / 1024 / 1024)}MB` : 'off',
			sharing: cfg.sharing ? 'on' : 'off',
			remoteControl: cfg.remoteControl ? 'on' : 'off',
			database: cfg.database.kind === 'postgres' ? `postgres=${cfg.database.label}` : 'sqlite',
			sessionHours: cfg.sessionMaxHours,
			cookieSecure: String(cfg.cookieSecure),
			// The upstream host is kept off the wire, not out of the operator's
			// log: a deployment pointed at the wrong music server shows here.
			upstreams: cfg.upstreams.map((up) => `${up.kind}=${new URL(up.url).host}`).join(',') || 'none'
		});
	} catch (err) {
		log.error('started-misconfigured', { detail: reason(err) });
	}
}

/**
 * The threshold for a `request-slow` line at the default level, measured to
 * the response object and not to the last byte, so a four-minute stream is not
 * slow. `HEDDOHON_LOG_SLOW_MS=0` switches it off.
 */
const slowMs = (() => {
	const raw = Number(process.env.HEDDOHON_LOG_SLOW_MS);
	return Number.isFinite(raw) && raw >= 0 ? raw : 2000;
})();

/**
 * The per-request line is written at debug only.
 *
 * One line per request cost 7 to 11 percent of throughput: 636 to 709 requests
 * per second on cached covers, 691 to 739 on the play-state endpoint. At the
 * default level this wrapper builds no per-request context and no field
 * object.
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
			// A failure, a slow request, or a trace. Nothing else is built.
			if (failure || status >= 500 || traced || (ms !== undefined && ms >= slowMs && slowMs > 0)) {
				const fields = {
					method: event.request.method,
					path: redact(event.url.pathname),
					query: traced && event.url.search ? redact(event.url.search) : undefined,
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

	// The request id ties a backend adapter's lines to their request, and those
	// lines are all debug, so the async context is set up only when tracing.
	return traced ? withRequest({ id: newRequestId() }, run) : run();
};

const handleRequest: Handle = async ({ event, resolve }) => {
	// A misconfigured deployment fails here, before a login form that could
	// never work.
	try {
		config();
	} catch (err) {
		// Fail closed on anything that is not a ConfigError.
		if (!(err instanceof ConfigError)) throw err;

		if (event.url.pathname === '/healthz') {
			// The probe must work on a broken deployment: it reports
			// `misconfigured` and fails the container's HEALTHCHECK. The CSRF
			// check and session resolution below call config() themselves and
			// would rethrow past the route's handler, so the probe would answer a
			// generic 500 with a stack trace every interval. It goes straight to
			// the route, hardened like every other response.
			const response = await resolve(event);
			harden(response.headers);
			return response;
		}

		// The detail stays in the log: it names the variable and its value, which
		// is usually the internal music-server address.
		log.error('config-invalid', { detail: err.message, path: redact(event.url.pathname) });
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
	 * SvelteKit's CSRF check covers only the content types an HTML form can
	 * post, and every state-changing call here is JSON.
	 *
	 * Every mutating request is checked, with no path condition. A check on
	 * `event.url.pathname.startsWith('/api/')` was bypassed: SvelteKit matches
	 * routes on the percent-decoded path while `event.url` keeps the raw one,
	 * so `POST /%61pi/settings` with `Origin: https://evil.example` returned 200
	 * and the write landed.
	 *
	 * A missing Origin is rejected too. Browsers send it on every non-GET/HEAD
	 * request.
	 */
	if (MUTATING_METHODS.has(event.request.method)) {
		const origin = event.request.headers.get('origin');
		if (origin !== event.url.origin) {
			// Either a deployment whose ORIGIN does not match the address it is
			// served on (the same origin every time), or a cross-origin write
			// attempt.
			log.warn('cross-origin-blocked', {
				method: event.request.method,
				path: redact(event.url.pathname),
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

	// Every id in a path, before anything is looked up with it. SECURITY.md
	// holds ids under 256 characters, and only the download route checked.
	if (Object.values(event.params).some((value) => value !== undefined && value.length >= 256)) {
		return sealed('Not found', 404, 'text/plain; charset=utf-8');
	}

	const session = await resolveSession(event);
	event.locals.session = session;
	event.locals.settings = session ? await getSettings(session.account.id) : null;
	if (session) nameRequestUser(session.account.username);

	if (!session && !isPublic(event.url.pathname)) {
		// API and media endpoints get a 401. A redirect would give an <audio>
		// element or a fetch() the login page's HTML with a 200.
		const isApi =
			event.url.pathname.startsWith('/api/') ||
			event.request.headers.get('accept')?.includes('application/json');
		if (isApi) {
			log.debug('unauthenticated', { path: redact(event.url.pathname), as: 'api' });
			return sealed(JSON.stringify({ error: 'not_authenticated' }), 401, 'application/json');
		}
		log.debug('unauthenticated', { path: redact(event.url.pathname), as: 'page' });
		const next = event.url.pathname + event.url.search;
		return sealedRedirect(event, `/login?next=${encodeURIComponent(next)}`);
	}

	if (session && event.url.pathname === '/login') {
		return sealedRedirect(event, '/');
	}

	const response = await resolve(event, {
		// The theme is known on the server, so the first byte of HTML carries the
		// right palette.
		transformPageChunk: ({ html }) =>
			html
				.replace('data-theme="dark"', `data-theme="${event.locals.settings?.theme ?? DEFAULT_SETTINGS.theme}"`)
				// The bars a phone paints around the page take the theme's ground
				// too. The manifest is fetched without a cookie, so it is asked for
				// by theme.
				.replace(
					'name="theme-color" content="#0b0c0f"',
					`name="theme-color" content="${THEME_GROUND[event.locals.settings?.theme ?? DEFAULT_SETTINGS.theme]}"`
				)
				.replace(
					'href="/manifest.webmanifest"',
					(event.locals.settings?.theme ?? DEFAULT_SETTINGS.theme) === 'light'
						? 'href="/manifest.webmanifest?theme=light"'
						: 'href="/manifest.webmanifest"'
				)
				// The scale and the font likewise: applied after hydration, they
				// would resize the page in front of the reader.
				.replace('data-scale="100"', `data-scale="${event.locals.settings?.uiScale ?? DEFAULT_SETTINGS.uiScale}"`)
				.replace('data-font="manrope"', `data-font="${event.locals.settings?.font ?? DEFAULT_SETTINGS.font}"`)
	});

	harden(response.headers);
	// A cast address is fetched cross-origin by a receiver (a Chromecast's
	// receiver app) without a cookie; see `cast.ts`. The token in the path is
	// the authority. Matched by route, not by a path prefix.
	if (event.route.id === '/cast/[token]' && response.ok) {
		response.headers.set('cross-origin-resource-policy', 'cross-origin');
		response.headers.set('access-control-allow-origin', '*');
		response.headers.set('access-control-expose-headers', 'content-length, content-range, accept-ranges');
	}
	return response;
};

export const handleError: HandleServerError = ({ error, status, event }) => {
	// The stack behind a 5xx. A 400 for a malformed escape or a 405 for a POST
	// to a page is the client's doing, and `/share` gives those to anyone, so
	// at error level an anonymous visitor could write stack traces into the log
	// at will.
	if (status >= 500) {
		log.error('unhandled', { path: redact(event.url.pathname), detail: reason(error) });
		console.error(redact(error instanceof Error ? (error.stack ?? error.message) : String(error)));
	} else if (status !== 404) {
		log.debug('rejected', { path: redact(event.url.pathname), status, detail: reason(error) });
	}
	return {
		message:
			status === 404
				? 'That page does not exist.'
				: 'Something went wrong talking to the music server.',
		// Development only. In production it reached the error page verbatim: a
		// SQLite error names the data path, a fetch failure names the upstream.
		detail: !import.meta.env.PROD && error instanceof Error ? error.message : undefined
	};
};
