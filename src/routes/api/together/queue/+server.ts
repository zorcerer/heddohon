import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { MAX_UPCOMING, QUEUE_SHOWN, reportQueue, togetherEnabled, type UpcomingReport } from '$lib/server/together';

/** As in `state`: shown, not stored. */
const MAX_TEXT = 300;

const text = (value: unknown): string | null =>
	typeof value === 'string' && value.length > 0 ? value.slice(0, MAX_TEXT) : null;

/**
 * What is up next in the host's queue, for its listeners, and the highest
 * addition this browser has put in it. Every track's id is read, to find the
 * additions among them; the titles of the first 50 are kept, which is as far
 * as the listeners are shown. The answer says which of the tracks are
 * additions, and whose.
 */
export const POST: RequestHandler = async ({ locals, request }) => {
	const session = locals.session;
	if (!session) error(401, 'Not signed in');
	if (!togetherEnabled()) error(404, 'Not found');

	const body = (await request.json().catch(() => null)) as { applied?: unknown; upcoming?: unknown } | null;
	if (!body || !Array.isArray(body.upcoming) || body.upcoming.length > MAX_UPCOMING) error(400, 'upcoming must be an array of at most 1000');
	const applied = typeof body.applied === 'number' && Number.isSafeInteger(body.applied) && body.applied >= 0 ? body.applied : 0;
	const upcoming: UpcomingReport[] = body.upcoming.map((raw: unknown, i: number) => {
		const track = (typeof raw === 'object' ? raw : null) as Record<string, unknown> | null;
		const songId = track?.songId;
		if (typeof songId !== 'string' || songId.length === 0 || songId.length > 255) error(400, 'each track needs a songId');
		const shown = i < QUEUE_SHOWN;
		return { songId, title: (shown ? text(track?.title) : null) ?? 'Unknown title', artist: shown ? text(track?.artist) : null };
	});
	const added = reportQueue(session, applied, upcoming);
	if (!added) error(404, 'This browser is not hosting');
	return json({ added });
};
