import type { RequestHandler } from './$types';
import { config } from '$lib/server/config';
import { THEME_GROUND } from '$lib/server/settings';

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
 * The colours are a theme's ground (`--bg-base`): the splash screen and the
 * bars of an installed app are painted in them before the page is read. The
 * manifest is fetched without a cookie, so it cannot know the account's
 * theme; the page asks for it by theme instead (`?theme=light`, written by
 * `hooks.server.ts`), and without that it is the dark theme's.
 */
export const GET: RequestHandler = ({ url }) => {
	const { appName } = config();
	const ground = THEME_GROUND[url.searchParams.get('theme') === 'light' ? 'light' : 'dark'];
	const manifest = {
		id: '/',
		name: appName,
		short_name: appName,
		description: 'High-resolution music player for your own library.',
		start_url: '/',
		scope: '/',
		display: 'standalone',
		orientation: 'any',
		background_color: ground,
		theme_color: ground,
		categories: ['music', 'entertainment'],
		// Names this manifest as its own related app, which is what lets a tab ask
		// the browser whether the app is installed (`getInstalledRelatedApps`), so
		// the install card is not shown beside an installed app.
		related_applications: [{ platform: 'webapp', url: `${url.origin}/manifest.webmanifest` }],
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
