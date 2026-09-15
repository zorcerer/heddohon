import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { config } from '$lib/server/config';
import { activeSessionCount } from '$lib/server/auth';
import { getSettings, saveSettings } from '$lib/server/settings';
import { cacheStats, clearCache } from '$lib/server/covercache';
import { backendFor } from '$lib/server/backends';

export const load: PageServerLoad = async ({ locals }) => {
	const session = locals.session!;
	const cfg = config();

	return {
		coverCache: await cacheStats(),
		/*
		 * Read here rather than stored at sign-in: this is the only page that
		 * shows it, it costs one upstream request where a login costs none, and
		 * an account promoted on the music server this morning should not have to
		 * sign in again for the page to say so. Null where the server does not
		 * answer, which changes nothing about what the page allows.
		 */
		isAdmin: await backendFor(session.account.backend).isAdmin(session.credential),
		settings: getSettings(session.account.id),
		account: session.account,
		serverLabel:
			cfg.upstreams.find((upstream) => upstream.kind === session.account.backend)?.label ?? '',
		sessionExpiresAt: session.expiresAt,
		sessionMaxHours: cfg.sessionMaxHours,
		activeSessions: activeSessionCount(session.account.id)
	};
};

export const actions: Actions = {
	save: async ({ locals, request }) => {
		const session = locals.session;
		if (!session) return fail(401, { error: 'Not signed in' });

		const form = await request.formData();
		const bool = (name: string) => form.get(name) === 'on';

		const settings = saveSettings(session.account.id, {
			theme: form.get('theme'),
			transition: form.get('transition'),
			crossfadeSeconds: Number(form.get('crossfadeSeconds')),
			gridSize: form.get('gridSize'),
			uiScale: form.get('uiScale'),
			defaultAlbumSort: form.get('defaultAlbumSort'),
			normalizeVolume: bool('normalizeVolume'),
			reportPlayback: bool('reportPlayback'),
			showQualityBadge: bool('showQualityBadge'),
			preloadNext: bool('preloadNext'),
			transcode: bool('transcode'),
			transcodeCodec: form.get('transcodeCodec'),
			transcodeBitrateKbps: Number(form.get('transcodeBitrateKbps'))
		});

		return { saved: true, settings };
	},

	/**
	 * Empties the cover cache.
	 *
	 * Deliberately not per account: the cache holds the music server's artwork,
	 * which is the same bytes for everyone signed in to it, and a per-account
	 * copy of the same sleeve would be the thing this exists to avoid. Anyone
	 * with an account can clear it, and the cost of that is that the next
	 * request for each cover goes upstream again.
	 */
	clearCovers: async ({ locals }) => {
		if (!locals.session) return fail(401, { error: 'Not signed in' });
		await clearCache();
		return { cleared: true, coverCache: await cacheStats() };
	}
};
