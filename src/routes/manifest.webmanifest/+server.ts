import type { RequestHandler } from './$types';
import { config } from '$lib/server/config';

/**
 * The web app manifest, which is what lets a browser install Heddohon as an
 * app: its own window, its own icon, and no address bar.
 *
 * A route rather than a file in `static/`, so that the name is the
 * deployment's `HEDDOHON_APP_NAME` and not always "Heddohon".
 *
 * It is on the public list in `hooks.server.ts`. Browsers fetch a manifest
 * without cookies unless the link asks otherwise, so behind the session gate
 * every fetch was answered with the redirect to the sign-in page. It carries
 * the name and nothing about any account.
 *
 * The colours are the dark theme's ground (`--bg-base`), which is also what
 * `app.html` puts in `theme-color`: the splash screen and the title bar are
 * painted before the page has said which theme the account uses.
 */
export const GET: RequestHandler = () => {
	const { appName } = config();
	const manifest = {
		id: '/',
		name: appName,
		short_name: appName,
		description: 'High-resolution music player for your own library.',
		start_url: '/',
		scope: '/',
		display: 'standalone',
		orientation: 'any',
		background_color: '#0b0c0f',
		theme_color: '#0b0c0f',
		categories: ['music', 'entertainment'],
		icons: [
			{ src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
			{ src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
			{ src: '/icons/maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
			{ src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
			{ src: '/favicon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }
		],
		// The long-press menu on the home-screen icon.
		shortcuts: [
			{ name: 'Albums', url: '/albums', icons: [{ src: '/icons/icon-192.png', sizes: '192x192' }] },
			{ name: 'Search', url: '/search', icons: [{ src: '/icons/icon-192.png', sizes: '192x192' }] },
			{ name: 'Favourites', url: '/favourites', icons: [{ src: '/icons/icon-192.png', sizes: '192x192' }] }
		]
	};
	return new Response(JSON.stringify(manifest), {
		headers: {
			'content-type': 'application/manifest+json',
			// Changes only with the configuration, which takes a restart.
			'cache-control': 'public, max-age=3600'
		}
	});
};
