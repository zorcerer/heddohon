import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { backendFor, UpstreamError } from '$lib/server/backends';
import { getSettings } from '$lib/server/settings';
import { recordPlay } from '$lib/server/history';
import { log, reason } from '$lib/server/log';

/**
 * Now-playing and scrobble reporting. Deliberately fire-and-forget from the
 * client's point of view: a music server that is slow to accept a scrobble must
 * never stall playback.
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
	// server in the query string of a scrobble.
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

	// A play past the scrobble threshold goes into the account's history
	// (`history.ts`) whether or not it is reported upstream, with the track as
	// the music server describes it for the stats page: one lookup a play. A
	// failed lookup records the play without it, and a failed write is logged
	// and does not touch the report.
	if (event === 'stop' && body.completed === true) {
		const songId = body.songId;
		const song = await backendFor(session.account.backend)
			.getSongs(session.credential, [songId])
			.then((songs) => songs[0] ?? null)
			.catch(() => null);
		await recordPlay(session.account.id, songId, { song, keepDays: settings.historyDays }).catch((err) =>
			log.warn('history-write-failed', { detail: reason(err) })
		);
	}

	if (!settings.reportPlayback) {
		return json({ reported: false, reason: 'disabled_by_user' });
	}

	try {
		await backendFor(session.account.backend).reportPlayback(session.credential, {
			songId: body.songId,
			event,
			position,
			completed: body.completed === true
		});
		return json({ reported: true });
	} catch (err) {
		// Scrobbling is best-effort; a failure here is not worth breaking the UI.
		if (err instanceof UpstreamError) return json({ reported: false, reason: err.message });
		throw err;
	}
};
