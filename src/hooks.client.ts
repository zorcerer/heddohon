import type { ClientInit } from '@sveltejs/kit';
import { installer } from '$lib/client/install.svelte';

/**
 * Waits between attempts at a page's data, in milliseconds. About 5 seconds
 * in all, which covers the container being replaced by an image update
 * (1 to 3 seconds before the new server listens) and a phone changing cell.
 */
const DATA_RETRY_MS = [400, 1200, 3000];

/**
 * Asks again for a page's data when the request fails in transit.
 *
 * A client-side navigation fetches the page's `__data.json`. When that
 * request rejects or comes back with a status other than 2xx or 404,
 * SvelteKit gives up on the client-side navigation and loads the whole page
 * from the server instead. A full page load tears down the `<audio>`
 * elements, so a single dropped request during a page change stopped
 * playback. Measured in the browser suite: 5 aborted data requests in a row
 * turned one rail click into a full page load in Chromium and WebKit, with
 * both elements paused at 0.0 afterwards.
 *
 * SvelteKit reads `window.fetch` at the moment it loads the data, so wrapping
 * it here covers every navigation. Only GETs of `__data.json` are retried, and
 * only for a rejected request or a 502, 503 or 504. Once the attempts run
 * out, the last result goes to SvelteKit unchanged and it loads the page as
 * before.
 */
export const init: ClientInit = () => {
	// Before the first page renders; see `client/install.svelte.ts`.
	installer.listen();
	const fetch = window.fetch.bind(window);
	window.fetch = async (input, options) => {
		const url = input instanceof Request ? input.url : String(input);
		const method = options?.method ?? (input instanceof Request ? input.method : 'GET');
		if (method !== 'GET' || !new URL(url, location.href).pathname.endsWith('/__data.json')) {
			return fetch(input, options);
		}
		for (const wait of DATA_RETRY_MS) {
			try {
				const response = await fetch(url, options);
				if (![502, 503, 504].includes(response.status)) return response;
			} catch {
				// Rejected in transit; asked again after the wait.
			}
			await new Promise((resolve) => setTimeout(resolve, wait));
		}
		return fetch(url, options);
	};
};
