import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { backendFor, UpstreamError } from '$lib/server/backends';
import { getSettings } from '$lib/server/settings';
import { recordPlay } from '$lib/server/history';
import { coverBytes } from '$lib/server/coverfill';
import { announcePlay, announceStart, DISCORD_COVER_SIZE } from '$lib/server/integrations';
import { log, reason } from '$lib/server/log';

/**
 * Now-playing and scrobble reporting. The client does not wait on it: a music
 * server slow to accept a scrobble must not stall playback.
 */
export const POST: RequestHandler = async ({ locals, request }) => {
	const session = locals.session;
	if (!session) error(401, 'Not signed in');

	const body = (await request.json().catch(() => null)) as {
		songId?: unknown;
		event?: unknown;
		position?: unknown;
		completed?: unknown;
	} | null;

	// The bound every other id takes. Unbounded, a 200 KB id went to the music
	// server in a scrobble's query string.
	if (!body || typeof body.songId !== 'string' || body.songId.length === 0 || body.songId.length >= 256) {
		error(400, 'songId is required');
	}
	const event = body.event;
	if (event !== 'start' && event !== 'progress' && event !== 'stop') {
		error(400, 'event must be start, progress or stop');
	}

	const position = typeof body.position === 'number' && Number.isFinite(body.position)
		? Math.max(0, body.position)
		: 0;

	const settings = await getSettings(session.account.id);
	// One time for the play here and for its scrobble; see `at` in `PlaybackReport`.
	const at = Date.now();

	// A play past the scrobble threshold goes into the account's history
	// (`history.ts`) whether or not it is reported upstream, with the track as
	// the music server describes it, for the stats page: one lookup per play. A
	// failed lookup records the play without it, and a failed write is logged
	// and leaves the report alone.
	if (event === 'stop' && body.completed === true) {
		const songId = body.songId;
		const song = await backendFor(session.account.backend)
			.getSongs(session.credential, [songId])
			.then((songs) => songs[0] ?? null)
			.catch(() => null);
		await recordPlay(session.account.id, songId, { at, song, keepDays: settings.historyDays }).catch((err) =>
			log.warn('history-write-failed', { detail: reason(err) })
		);
		// To a Discord channel and ListenBrainz, where the account linked them,
		// under the same switch as the report to the music server.
		if (song && settings.reportPlayback) {
			void announcePlay(session.account, song, position, (coverId) =>
				coverBytes(session.account, session.credential, coverId, DISCORD_COVER_SIZE)
			);
		}
	}

	if (!settings.reportPlayback) {
		return json({ reported: false, reason: 'disabled_by_user' });
	}

	if (event === 'start') {
		const songId = body.songId;
		void announceStart(session.account, () =>
			backendFor(session.account.backend)
				.getSongs(session.credential, [songId])
				.then((songs) => songs[0] ?? null)
				.catch(() => null)
		);
	}

	try {
		await backendFor(session.account.backend).reportPlayback(session.credential, {
			songId: body.songId,
			event,
			position,
			completed: body.completed === true,
			at
		});
		return json({ reported: true });
	} catch (err) {
		// Scrobbling is best-effort; a failure here is not worth breaking the UI.
		if (err instanceof UpstreamError) return json({ reported: false, reason: err.message });
		throw err;
	}
};
