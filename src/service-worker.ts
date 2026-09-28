/// <reference no-default-lib="true"/>
/// <reference lib="esnext" />
/// <reference lib="webworker" />
/// <reference types="@sveltejs/kit" />

/**
 * The offline page, and nothing else.
 *
 * An installed Heddohon opened with no connection, or with the server down,
 * showed the browser's own error page. This worker answers a failed page load
 * with `static/offline.html`, which waits for the server and reloads.
 *
 * It handles top-level page loads (GET navigations) and lets every other
 * request go to the network untouched: bundles, `/api/*`, streams, covers and
 * shared links never pass through `respondWith`, and nothing a page loads is
 * written to a cache. The one cache holds the offline page and its script,
 * so a sign-out cannot leave an account's data behind in it.
 *
 * A new build replaces the worker at once (`skipWaiting`). That is safe here,
 * since the worker serves none of the app's own files: a page open during the
 * swap keeps the bundles it loaded, and the next page load is answered by the
 * network as before.
 */
import { version } from '$service-worker';
import { MARKER, SECURITY_HEADERS, STATIC_HTML_CSP } from '$lib/headers';

const sw = self as unknown as ServiceWorkerGlobalScope;

const CACHE = `offline-${version}`;
const OFFLINE_PAGE = '/offline.html';
const PRECACHE = [OFFLINE_PAGE, '/offline.js'];

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
			// Starts the page request while the worker boots, so a page load waits
			// on the network alone rather than on the worker and then the network.
			await sw.registration.navigationPreload?.enable();
			await sw.clients.claim();
		})()
	);
});

/*
 * The offline page, with the headers any page of Heddohon's carries.
 *
 * It is shown at whatever address failed, `/settings` among them, and the
 * cached copy held only the headers the static file server sent when it was
 * cached. Answered as it was, it was the one document on the origin that could
 * be framed and that allowed the camera.
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
		// A 502 to 504 is either the proxy's page for a stopped Heddohon or
		// Heddohon's own error page for a music server that is down. Only the
		// first is this worker's to replace, and only Heddohon's carries MARKER.
		if (GATEWAY_FAILURES.has(response.status) && !response.headers.has(MARKER)) return offlinePage();
		return response;
	} catch {
		return offlinePage();
	}
}

sw.addEventListener('fetch', (event) => {
	const { request } = event;
	if (request.mode !== 'navigate' || request.method !== 'GET') return;
	if (new URL(request.url).origin !== sw.location.origin) return;
	event.respondWith(navigate(event));
});
