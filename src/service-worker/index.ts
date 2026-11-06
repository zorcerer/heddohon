/**
 * The offline page, and nothing else.
 *
 * An installed Heddohon opened with no connection, or with the server down,
 * showed the browser's error page. This worker answers a failed page load with
 * `static/offline.html`, which waits for the server and reloads.
 *
 * It handles top-level page loads (GET navigations), and the offline page's
 * own script. Bundles, `/api/*`, streams, covers and shared links never pass
 * through `respondWith`, and nothing a page loads is cached. The one cache
 * holds the offline page and its script, so a sign-out leaves no account data
 * in it.
 *
 * A new build replaces the worker at once (`skipWaiting`). The worker serves
 * none of the app's bundles, so a page open during the swap keeps the ones it
 * loaded.
 */
import { version } from '$app/env';
import { MARKER, SECURITY_HEADERS, STATIC_HTML_CSP } from '#lib/headers.ts';

const sw = self as unknown as ServiceWorkerGlobalScope;

const CACHE = `offline-${version}`;
const OFFLINE_PAGE = '/offline.html';
const OFFLINE_SCRIPT = '/offline.js';
const PRECACHE = [OFFLINE_PAGE, OFFLINE_SCRIPT];

/** Statuses a reverse proxy answers with when Heddohon behind it is down. */
const GATEWAY_FAILURES = new Set([502, 503, 504]);

sw.addEventListener('install', (event) => {
	event.waitUntil(
		(async () => {
			const cache = await caches.open(CACHE);
			await cache.addAll(PRECACHE);
			await sw.skipWaiting();
		})()
	);
});

sw.addEventListener('activate', (event) => {
	event.waitUntil(
		(async () => {
			for (const key of await caches.keys()) {
				if (key !== CACHE) await caches.delete(key);
			}
			// Starts the page request while the worker boots, so a page load does
			// not wait on the worker and then the network.
			await sw.registration.navigationPreload?.enable();
			await sw.clients.claim();
		})()
	);
});

/*
 * The offline page, with the headers any page of Heddohon's carries.
 *
 * It is shown at whatever address failed, `/settings` among them, and the
 * cached copy held only the headers the static file server sent. Answered as
 * cached, it was the one document on the origin that could be framed and that
 * allowed the camera.
 */
async function offlinePage(): Promise<Response> {
	const cached = await caches.match(OFFLINE_PAGE);
	const headers = new Headers(SECURITY_HEADERS);
	headers.delete(MARKER);
	headers.set('content-security-policy', STATIC_HTML_CSP);
	headers.set('content-type', 'text/html; charset=utf-8');
	headers.set('cache-control', 'no-store');
	return cached
		? new Response(await cached.arrayBuffer(), { status: 200, headers })
		: new Response('Heddohon cannot reach its server.', { status: 503, headers });
}

async function navigate(event: FetchEvent): Promise<Response> {
	try {
		const response = ((await event.preloadResponse) as Response | undefined) ?? (await fetch(event.request));
		// A 502 to 504 is the proxy's page for a stopped Heddohon or Heddohon's
		// own error page for a music server that is down. Only the first is
		// replaced, and only Heddohon's carries MARKER.
		if (GATEWAY_FAILURES.has(response.status) && !response.headers.has(MARKER)) return offlinePage();
		return response;
	} catch {
		return offlinePage();
	}
}

/*
 * The offline page's script, from the cache when the network fails. Without
 * it the page never asks again and never reloads. It used to come from the
 * browser's HTTP cache; adapter-node 6 serves static files without
 * `Last-Modified`, and Chromium then had no copy to use offline.
 */
async function offlineScript(request: Request): Promise<Response> {
	try {
		return await fetch(request);
	} catch {
		return (await caches.match(OFFLINE_SCRIPT)) ?? Response.error();
	}
}

sw.addEventListener('fetch', (event) => {
	const { request } = event;
	if (request.method !== 'GET') return;
	const url = new URL(request.url);
	if (url.origin !== sw.location.origin) return;
	if (request.mode === 'navigate') event.respondWith(navigate(event));
	else if (url.pathname === OFFLINE_SCRIPT) event.respondWith(offlineScript(request));
});
