import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { report, togetherEnabled } from '$lib/server/together';

/** Titles and names are shown, not stored; 300 characters is past any real one. */
const MAX_TEXT = 300;

const text = (value: unknown): string | null =>
	typeof value === 'string' && value.length > 0 ? value.slice(0, MAX_TEXT) : null;
const seconds = (value: unknown): number =>
	typeof value === 'number' && Number.isFinite(value) ? Math.min(Math.max(0, value), 86_400) : 0;
const id = (value: unknown): string | null => (typeof value === 'string' && value.length > 0 && value.length < 256 ? value : null);

/**
 * What the host is playing, for its listeners. The track id is what their
 * audio route will serve, so it names a track the host's own account plays;
 * the rest is shown to them as it is sent, and bounded.
 */
export const POST: RequestHandler = async ({ locals, request }) => {
	const session = locals.session;
	if (!session) error(401, 'Not signed in');
	if (!togetherEnabled()) error(404, 'Not found');

	const body = (await request.json().catch(() => null)) as { state?: unknown } | null;
	if (!body) error(400, 'state is required');
	let state = null;
	if (body.state !== null) {
		const raw = (typeof body.state === 'object' ? body.state : null) as Record<string, unknown> | null;
		const songId = id(raw?.songId);
		if (!raw || !songId) error(400, 'state needs a songId');
		state = {
			songId,
			title: text(raw.title) ?? 'Unknown title',
			artist: text(raw.artist),
			album: text(raw.album),
			coverArt: id(raw.coverArt),
			duration: seconds(raw.duration),
			position: seconds(raw.position),
			playing: raw.playing === true
		};
	}
	if (!report(session, state)) error(404, 'This browser is not hosting');
	return json({ ok: true });
};
