import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { backendFor, UpstreamError } from '$lib/server/backends';
import { destroyAllSessions } from '$lib/server/auth';
import { MAX_IMPORT_TRACKS, matchTracks, type WantedTrack } from '$lib/server/playlistfiles';

/** Characters kept of a title, an artist or an album from a file. */
const MAX_TEXT = 300;

function text(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	const trimmed = value.trim().slice(0, MAX_TEXT);
	return trimmed || null;
}

/**
 * Looks for the tracks of a playlist file in the library: the body is
 * `{ tracks: [{ title, artist?, album?, duration? }] }`, which the browser
 * read from the file, and the answer is a match for each, in order. Nothing
 * is written. See `matchTracks`.
 */
export const POST: RequestHandler = async ({ locals, request }) => {
	const session = locals.session;
	if (!session) error(401, 'Not signed in');

	const body = (await request.json().catch(() => null)) as { tracks?: unknown } | null;
	if (!Array.isArray(body?.tracks) || body.tracks.length === 0) error(400, 'tracks must be a list of tracks');
	if (body.tracks.length > MAX_IMPORT_TRACKS) error(400, `at most ${MAX_IMPORT_TRACKS} tracks at once`);
	const tracks: WantedTrack[] = body.tracks.map((raw) => {
		const track = (raw ?? {}) as Record<string, unknown>;
		const title = text(track.title);
		if (!title) error(400, 'every track needs a title');
		const duration = typeof track.duration === 'number' && Number.isFinite(track.duration) && track.duration > 0 && track.duration < 86_400
			? track.duration
			: null;
		return { title, artist: text(track.artist), album: text(track.album), duration };
	});

	try {
		const matches = await matchTracks(backendFor(session.account.backend), session.credential, tracks, request.signal);
		return json({ matches });
	} catch (err) {
		if (err instanceof UpstreamError) {
			if (err.kind === 'auth') {
				await destroyAllSessions(session.account.id);
				error(401, 'Your music server credentials are no longer valid. Sign in again.');
			}
			error(502, err.message);
		}
		throw err;
	}
};
