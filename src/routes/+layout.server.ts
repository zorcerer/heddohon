import type { LayoutServerLoad } from './$types';
import { backendFor } from '$lib/server/backends';
import { config } from '$lib/server/config';
import { radioEnabled } from '$lib/server/radio';
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
		remoteControl: cfg.remoteControl,
		// Listening together needs both; see `together.ts`.
		together: cfg.sharing && cfg.remoteControl,
		// Whether headphone corrections can be searched for; see `autoeq.ts`.
		autoeq: cfg.autoeqUrl !== null,
		// Whether the library can be browsed by folder; see `HEDDOHON_FOLDERS`.
		folders: cfg.folders,
		// Whether the music server keeps internet radio stations (Navidrome does) and they are offered here.
		radio: radioEnabled(session),
		// Whether the music server keeps star ratings. Navidrome does, Jellyfin
		// does not, and the stars are drawn only where a press can be saved.
		ratings: Boolean(session && backendFor(session.account.backend).setRating),
		account: session?.account ?? null,
		// The upstream URL is never included — the browser only learns the label.
		serverLabel:
			cfg.upstreams.find((upstream) => upstream.kind === session?.account.backend)?.label ?? '',
		settings: locals.settings ?? DEFAULT_SETTINGS,
		sessionExpiresAt: session?.expiresAt ?? null,
		isLoginPage: url.pathname === '/login',
		// A shared link opens on a page of its own, drawn without the rail and
		// the player column, whether or not the visitor is signed in.
		// A listen-together link too: its own page, for a visitor with no account.
		isSharePage: url.pathname.startsWith('/share/') || url.pathname.startsWith('/together/'),
		// The living-room screen is drawn without the rail and the player panel,
		// signed in and with the player running.
		isScreenPage: url.pathname === '/screen'
	};
};
