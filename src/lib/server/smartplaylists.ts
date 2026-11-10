/**
 * Smart playlists through one interface, whichever music server holds them.
 *
 * Navidrome keeps the rules and fills the playlist itself; this passes the
 * editor's model (`lib/smartrules.ts`) to it in its own format. Jellyfin has no
 * smart playlists (#237), so on Jellyfin Heddohon keeps the rules in
 * `smart_playlists`, works the songs out from the library read with the
 * account's own credential, and writes them into a real Jellyfin playlist,
 * which other Jellyfin apps see as an ordinary one. A song the account cannot
 * read is never in the listing, so it is never written.
 */
import type { AuthenticatedSession } from './auth';
import { backendFor, UpstreamError } from './backends';
import type { MediaBackend, StoredCredential } from './backends/types';
import { store } from './db';
import { log } from './log';
import {
	checkRules,
	evaluateRules,
	fromCriteria,
	RULE_FIELDS_BY_BACKEND,
	SORT_FIELDS_BY_BACKEND,
	toCriteria,
	type RuleField,
	type SmartRules,
	type SortField
} from '#lib/smartrules.ts';
import type { Song } from '#lib/types.ts';

/**
 * How old a Jellyfin smart playlist's songs may be when its page opens before
 * they are worked out again. Each evaluation reads the whole library, a page of
 * 1000 tracks per request, so it is not done on every open: Navidrome refreshes
 * its own on access too, but from its database rather than over the network.
 */
const REFRESH_MS = 15 * 60_000;

export interface SmartAccess {
	/** The fields a rule and a sort may use on this server, for the editor and `checkRules`. */
	readonly fields: readonly RuleField[];
	readonly sorts: readonly SortField[];
	/**
	 * Whether Heddohon writes the songs itself. Such a playlist takes no edits to
	 * its songs by hand: the next evaluation would put them back.
	 */
	readonly heldHere: boolean;
	/** The ids of the account's smart playlists, or null where the server has none. */
	ids(): Promise<Set<string> | null>;
	/** One playlist's rules (null where they use more than the editor edits), or null for one made by hand. */
	rules(id: string): Promise<{ rules: SmartRules | null; fromFile: boolean } | null>;
	create(name: string, rules: SmartRules): Promise<string>;
	setRules(id: string, rules: SmartRules): Promise<void>;
	/** Works the songs out again if they are older than `REFRESH_MS`. A no-op on Navidrome. */
	refresh(id: string): Promise<void>;
	/** Drops the rules of a playlist that was deleted. A no-op on Navidrome, which deletes its own. */
	forget(id: string): Promise<void>;
}

/** The account's smart playlists, or null where its server can keep none. */
export function smartFor(session: AuthenticatedSession): SmartAccess | null {
	const kind = session.account.backend;
	const backend = backendFor(kind);
	const credential = session.credential;
	const fields = RULE_FIELDS_BY_BACKEND[kind];
	const sorts = SORT_FIELDS_BY_BACKEND[kind];

	const upstream = backend.smartPlaylists;
	if (upstream) {
		return {
			fields,
			sorts,
			heldHere: false,
			ids: () => upstream.ids(credential),
			async rules(id) {
				const held = await upstream.rules(credential, id);
				return held ? { rules: fromCriteria(held.criteria), fromFile: held.fromFile } : null;
			},
			create: (name, rules) => upstream.create(credential, name, toCriteria(rules)),
			setRules: (id, rules) => upstream.setRules(credential, id, toCriteria(rules)),
			refresh: async () => {},
			forget: async () => {}
		};
	}
	if (!backend.replacePlaylistSongs) return null;

	const accountId = session.account.id;
	return {
		fields,
		sorts,
		heldHere: true,
		async ids() {
			const rows = await (await store()).all<{ playlist_id: string }>(
				'SELECT playlist_id FROM smart_playlists WHERE account_id = ?',
				accountId
			);
			return new Set(rows.map((row) => row.playlist_id));
		},
		async rules(id) {
			const row = await (await store()).get<{ rules: string }>(
				'SELECT rules FROM smart_playlists WHERE account_id = ? AND playlist_id = ?',
				accountId,
				id
			);
			if (!row) return null;
			// Checked again on the way out, as on the way in: a row written by an
			// older build, or by hand, reads as rules the editor cannot edit.
			const checked = checkRules(parseJson(row.rules), fields);
			return { rules: 'rules' in checked ? checked.rules : null, fromFile: false };
		},
		async create(name, rules) {
			const id = await backend.createPlaylist(credential, name, []);
			const now = Date.now();
			await (await store()).run(
				`INSERT INTO smart_playlists (account_id, playlist_id, rules, written, evaluated_at, created_at, updated_at)
				 VALUES (?, ?, ?, NULL, NULL, ?, ?)`,
				accountId,
				id,
				JSON.stringify(rules),
				now,
				now
			);
			await evaluate(backend, accountId, credential, id, rules);
			return id;
		},
		async setRules(id, rules) {
			const changed = await (await store()).run(
				'UPDATE smart_playlists SET rules = ?, updated_at = ? WHERE account_id = ? AND playlist_id = ?',
				JSON.stringify(rules),
				Date.now(),
				accountId,
				id
			);
			if (changed.changes === 0) throw new UpstreamError('That playlist has no rules', 404, 'not_found');
			await evaluate(backend, accountId, credential, id, rules);
		},
		async refresh(id) {
			const row = await (await store()).get<{ rules: string; evaluated_at: number | null }>(
				'SELECT rules, evaluated_at FROM smart_playlists WHERE account_id = ? AND playlist_id = ?',
				accountId,
				id
			);
			if (!row || (row.evaluated_at !== null && Date.now() - row.evaluated_at < REFRESH_MS)) return;
			const checked = checkRules(parseJson(row.rules), fields);
			if (!('rules' in checked)) return;
			await evaluate(backend, accountId, credential, id, checked.rules);
		},
		async forget(id) {
			await (await store()).run('DELETE FROM smart_playlists WHERE account_id = ? AND playlist_id = ?', accountId, id);
		}
	};
}

/**
 * The ids of the playlists Heddohon fills for an account, from the table alone,
 * for callers with an account and no session (the MCP tools). Empty on
 * Navidrome, which fills its own and refuses edits to them itself.
 */
export async function heldSmartIds(accountId: string): Promise<Set<string>> {
	const rows = await (await store()).all<{ playlist_id: string }>(
		'SELECT playlist_id FROM smart_playlists WHERE account_id = ?',
		accountId
	);
	return new Set(rows.map((row) => row.playlist_id));
}

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

/**
 * Evaluations in progress, by account and playlist: a page opened twice while
 * one runs waits for it rather than reading the library a second time.
 */
const running = new Map<string, Promise<void>>();

function evaluate(backend: MediaBackend, accountId: string, credential: StoredCredential, id: string, rules: SmartRules): Promise<void> {
	const key = `${accountId}\u0000${id}`;
	const held = running.get(key);
	if (held) return held;
	const work = writeSongs(backend, accountId, credential, id, rules).finally(() => running.delete(key));
	running.set(key, work);
	return work;
}

/**
 * Reads the library, works out the songs and writes them upstream, unless they
 * are the songs written last time: then only the time is kept, and Jellyfin's
 * playlist (and its "changed" date) is left alone.
 */
async function writeSongs(
	backend: MediaBackend,
	accountId: string,
	credential: StoredCredential,
	id: string,
	rules: SmartRules
): Promise<void> {
	const library: Song[] = [];
	await backend.forEachSong(credential, (songs) => library.push(...songs));
	const songIds = evaluateRules(library, rules).map((song) => song.id);
	const written = JSON.stringify(songIds);

	const database = await store();
	const row = await database.get<{ written: string | null }>(
		'SELECT written FROM smart_playlists WHERE account_id = ? AND playlist_id = ?',
		accountId,
		id
	);
	if (!row) return;
	if (row.written !== written || rules.sort === 'random') {
		try {
			await backend.replacePlaylistSongs!(credential, id, songIds);
		} catch (err) {
			// A playlist deleted in another Jellyfin app takes its rules with it.
			if (err instanceof UpstreamError && err.kind === 'not_found') {
				await database.run('DELETE FROM smart_playlists WHERE account_id = ? AND playlist_id = ?', accountId, id);
				log.info('smart-playlist-gone', { playlist: id });
			}
			throw err;
		}
	}
	await database.run(
		'UPDATE smart_playlists SET written = ?, evaluated_at = ? WHERE account_id = ? AND playlist_id = ?',
		written,
		Date.now(),
		accountId,
		id
	);
	log.debug('smart-playlist-evaluated', { playlist: id, library: library.length, songs: songIds.length });
}
