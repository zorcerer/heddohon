import type { PageServerLoad } from './$types';
import { library } from '#lib/server/library.ts';
import { log, reason } from '#lib/server/log.ts';
import type { SmartRules } from '#lib/smartrules.ts';
import { smartFor } from '#lib/server/smartplaylists.ts';

/**
 * What the page shows of a smart playlist's rules: the rules, or null where
 * they use more than the editor edits, and whether a file on the music
 * server defines them.
 */
interface SmartInfo {
	rules: SmartRules | null;
	fromFile: boolean;
}

export const load: PageServerLoad = async (event) => {
	const access = event.locals.session ? smartFor(event.locals.session) : null;
	const { playlist, smart } = await library(event, async ({ backend, credential }) => {
		// One Heddohon fills (Jellyfin) is worked out again first when its songs
		// are older than `REFRESH_MS`, so the page shows the new ones. A failure
		// leaves the songs written last time, which is still a playlist.
		if (access?.heldHere) {
			await access.refresh(event.params.id).catch((err) => {
				log.warn('section-failed', { section: 'smart-playlist-refresh', detail: reason(err) });
			});
		}
		const playlist = await backend.getPlaylist(credential, event.params.id);
		// A playlist whose songs can be changed has no rules: only one the
		// server fills itself is asked about, or one Heddohon fills.
		let smart: SmartInfo | null = null;
		if (access && (!playlist.tracksEditable || access.heldHere)) {
			smart = await access.rules(playlist.id).catch((err) => {
				log.warn('section-failed', { section: 'smart-playlist-rules', detail: reason(err) });
				return null;
			});
		}
		// Its songs come from the rules: an edit by hand would be put back.
		return { playlist: smart && access?.heldHere ? { ...playlist, tracksEditable: false } : playlist, smart };
	});
	return { playlist, smart, smartFields: access?.fields ?? [], smartSorts: access?.sorts ?? [] };
};
