import type { PageServerLoad } from './$types';
import { library } from '$lib/server/library';
import { log, reason } from '$lib/server/log';
import { fromCriteria, type SmartRules } from '$lib/smartrules';

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
	const { playlist, smart } = await library(event, async ({ backend, credential }) => {
		const playlist = await backend.getPlaylist(credential, event.params.id);
		// A playlist whose songs can be changed has no rules: only one the
		// server fills itself is asked about.
		let smart: SmartInfo | null = null;
		if (!playlist.tracksEditable && backend.smartPlaylists) {
			const held = await backend.smartPlaylists.rules(credential, playlist.id).catch((err) => {
				log.warn('section-failed', { section: 'smart-playlist-rules', detail: reason(err) });
				return null;
			});
			if (held) smart = { rules: fromCriteria(held.criteria), fromFile: held.fromFile };
		}
		return { playlist, smart };
	});
	return { playlist, smart };
};
