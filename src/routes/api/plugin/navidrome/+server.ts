import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { UpstreamError } from '$lib/server/backends';
import { config } from '$lib/server/config';
import { log } from '$lib/server/log';
import {
	MAX_HISTORY_PAGE,
	MAX_PLAYS,
	PLAYBACK_STATES,
	pluginAuthorized,
	playTime,
	takeHistory,
	takePlayback,
	takePlays,
	wanted,
	type PluginPlay,
	type PluginPlayback
} from '$lib/server/plugin';

/** The version of the messages the plugin sends; `protocol` in `plugin/navidrome/main.go`. */
const PROTOCOL = 1;

const refuse = (status: number, code: string) => json({ error: code }, { status });

const isId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length < 256;

/**
 * What the Heddohon plugin for Navidrome posts; see `lib/server/plugin.ts`.
 *
 * The route is outside the session gate (`PUBLIC_ROUTES`) and takes the
 * plugin's token in place of a session. The origin check in `hooks.server.ts`
 * applies to it as to every write, and the plugin sends the header.
 *
 * A message is `{ v, type }` and, by type:
 *   `plays`    `plays: [{ username, songId, at }]`, as they happen
 *   `poll`     nothing more
 *   `history`  `username`, `plays: [{ songId, at }]`, `more`, `failed`
 *   `playback` `username`, `songId`, `state`, `positionMs`, `player`, `playerName`:
 *              what an app is playing now, as Navidrome reports it
 * with `at` in Unix seconds. Every answer is `{ wanted: [{ username, from }] }`.
 */
export const POST: RequestHandler = async ({ request }) => {
	const cfg = config();
	// Off, the route answers as one that does not exist.
	if (cfg.navidromePluginToken === null || !cfg.upstreams.some((up) => up.kind === 'subsonic')) {
		return refuse(404, 'not_found');
	}
	if (!pluginAuthorized(request.headers.get('authorization'))) {
		log.warn('plugin-refused', {});
		return refuse(401, 'not_authenticated');
	}

	const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
	if (!body || typeof body !== 'object') return refuse(400, 'invalid_message');
	if (body.v !== PROTOCOL) return refuse(400, 'unsupported_version');

	if (body.type === 'plays') {
		if (!Array.isArray(body.plays) || body.plays.length > MAX_PLAYS) return refuse(400, 'invalid_message');
		const plays: PluginPlay[] = [];
		for (const raw of body.plays as Record<string, unknown>[]) {
			const at = playTime(raw?.at);
			if (!raw || !isId(raw.username) || !isId(raw.songId) || at === null) return refuse(400, 'invalid_message');
			plays.push({ username: raw.username, songId: raw.songId, at });
		}
		try {
			const recorded = await takePlays(plays);
			log.debug('plugin-plays', { sent: plays.length, recorded });
		} catch (err) {
			// The music server did not answer the lookup. The plugin keeps the
			// play and sends it again.
			if (err instanceof UpstreamError) return refuse(503, 'upstream_unavailable');
			throw err;
		}
	} else if (body.type === 'history') {
		const failed = body.failed === true;
		const list = body.plays ?? [];
		if (!isId(body.username) || !Array.isArray(list) || list.length > MAX_HISTORY_PAGE) {
			return refuse(400, 'invalid_message');
		}
		const plays: { songId: string; at: number }[] = [];
		for (const raw of list as Record<string, unknown>[]) {
			const at = playTime(raw?.at);
			if (!raw || !isId(raw.songId) || at === null) return refuse(400, 'invalid_message');
			plays.push({ songId: raw.songId, at });
		}
		await takeHistory({ username: body.username, plays, more: body.more === true, failed });
	} else if (body.type === 'playback') {
		const state = PLAYBACK_STATES.find((known) => known === body.state);
		const position = body.positionMs ?? 0;
		const name = body.playerName ?? null;
		if (
			!isId(body.username) ||
			!isId(body.songId) ||
			!isId(body.player) ||
			!state ||
			typeof position !== 'number' ||
			!Number.isFinite(position) ||
			position < 0 ||
			(name !== null && typeof name !== 'string')
		) {
			return refuse(400, 'invalid_message');
		}
		const report: PluginPlayback = {
			username: body.username,
			songId: body.songId,
			state,
			// A day at most, as a browser's own report is held to.
			position: Math.min(position / 1000, 86_400),
			player: body.player,
			// Cut before it is cleaned: `cleanName` keeps 32 characters of it.
			playerName: name === null ? null : name.slice(0, 300)
		};
		await takePlayback(report);
	} else if (body.type !== 'poll') {
		return refuse(400, 'invalid_message');
	}

	return json({ wanted: wanted() });
};
