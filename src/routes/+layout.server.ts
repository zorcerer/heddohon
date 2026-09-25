import type { LayoutServerLoad } from './$types';
import { config } from '$lib/server/config';
import { DEFAULT_SETTINGS } from '$lib/server/settings';
import { APP_VERSION } from '$lib/server/version';

export const load: LayoutServerLoad = async ({ locals, url }) => {
	const cfg = config();
	const session = locals.session;

	return {
		appName: cfg.appName,
		appVersion: APP_VERSION,
		// Whether to offer sharing at all. The routes enforce it; this only
		// keeps the buttons from offering what the server will refuse.
		sharing: cfg.sharing,
		downloads: cfg.downloads,
		account: session?.account ?? null,
		// The upstream URL is never included — the browser only learns the label.
		serverLabel:
			cfg.upstreams.find((upstream) => upstream.kind === session?.account.backend)?.label ?? '',
		settings: locals.settings ?? DEFAULT_SETTINGS,
		sessionExpiresAt: session?.expiresAt ?? null,
		isLoginPage: url.pathname === '/login',
		// A shared link opens on a page of its own, drawn without the rail and
		// the player column, whether or not the visitor is signed in.
		isSharePage: url.pathname.startsWith('/share/')
	};
};
