import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { config } from '$lib/server/config';
import { report } from '$lib/server/remote';

/** Titles and names are shown, not stored; 300 characters is past any real one. */
const MAX_TEXT = 300;

const text = (value: unknown): string | null =>
	typeof value === 'string' && value.length > 0 ? value.slice(0, MAX_TEXT) : null;
const seconds = (value: unknown): number =>
	typeof value === 'number' && Number.isFinite(value) ? Math.min(Math.max(0, value), 86_400) : 0;

/**
 * What this browser is playing, for the account's other browsers to show.
 * `peer` is the id its own stream was given; a report for a stream another
 * session opened is refused.
 */
export const POST: RequestHandler = async ({ locals, request }) => {
	const session = locals.session;
	if (!session) error(401, 'Not signed in');
	if (!config().remoteControl) error(404, 'Not found');

	const body = (await request.json().catch(() => null)) as { peer?: unknown; state?: unknown } | null;
	if (!body || typeof body.peer !== 'string' || body.peer.length === 0 || body.peer.length >= 256) {
		error(400, 'peer is required');
	}

	let state = null;
	if (body.state !== null) {
		const raw = (typeof body.state === 'object' ? body.state : null) as Record<string, unknown> | null;
		const songId = text(raw?.songId);
		if (!raw || !songId || songId.length >= 256) error(400, 'state needs a songId');
		const coverArt = text(raw.coverArt);
		state = {
			songId,
			title: text(raw.title) ?? 'Unknown title',
			artist: text(raw.artist),
			coverArt: coverArt && coverArt.length < 256 ? coverArt : null,
			position: seconds(raw.position),
			duration: seconds(raw.duration),
			playing: raw.playing === true,
			volume: typeof raw.volume === 'number' && raw.volume >= 0 && raw.volume <= 1 ? raw.volume : 1
		};
	}

	if (!report(session.account.id, session.handle, body.peer, state)) error(404, 'No such stream for this browser');
	return json({ ok: true });
};
