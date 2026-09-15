import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { backendFor, UpstreamError } from '$lib/server/backends';
import { getSettings } from '$lib/server/settings';

/**
 * Now-playing and scrobble reporting. Deliberately fire-and-forget from the
 * client's point of view: a music server that is slow to accept a scrobble must
 * never stall playback.
 */
export const POST: RequestHandler = async ({ locals, request }) => {
	const session = locals.session;
	if (!session) error(401, 'Not signed in');

	if (!getSettings(session.account.id).reportPlayback) {
		return json({ reported: false, reason: 'disabled_by_user' });
	}

	const body = (await request.json().catch(() => null)) as {
		songId?: unknown;
		event?: unknown;
		position?: unknown;
		completed?: unknown;
	} | null;

	if (!body || typeof body.songId !== 'string') error(400, 'songId is required');
	const event = body.event;
	if (event !== 'start' && event !== 'progress' && event !== 'stop') {
		error(400, 'event must be start, progress or stop');
	}

	const position = typeof body.position === 'number' && Number.isFinite(body.position)
		? Math.max(0, body.position)
		: 0;

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
