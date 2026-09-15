import type { LayoutServerLoad } from './$types';
import { config } from '$lib/server/config';
import { DEFAULT_SETTINGS } from '$lib/server/settings';

export const load: LayoutServerLoad = async ({ locals, url }) => {
	const cfg = config();
	const session = locals.session;

	return {
		appName: cfg.appName,
		account: session?.account ?? null,
		// The upstream URL is never included — the browser only learns the label.
		serverLabel:
			cfg.upstreams.find((upstream) => upstream.kind === session?.account.backend)?.label ?? '',
		settings: locals.settings ?? DEFAULT_SETTINGS,
		sessionExpiresAt: session?.expiresAt ?? null,
		isLoginPage: url.pathname === '/login'
	};
};
