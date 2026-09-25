import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { backendFor } from '$lib/server/backends';
import { proxySharedMedia, streamRequestFrom } from '$lib/server/proxy';
import { holdShareStream, shareAccess, sharedSong } from '$lib/server/shares';

/**
 * The shared song's audio, for anyone holding the link.
 *
 * Three things stop it. The token is resolved on every request. A stream in
 * progress is registered against the link, and withdrawing the link aborts
 * it. The link's expiry is checked as each chunk passes, so a stream that
 * outlives it stops there. The file is sent as it is stored: transcoding
 * follows an account's settings, and the visitor may have no account.
 *
 * The song is also looked up with the sharer's credential on every request,
 * as the page and the cover do. Subsonic's `stream.view` and Jellyfin's audio
 * route are not the endpoints that apply library permissions to a listing, so
 * without this a song the sharer can no longer see went on playing.
 */
const handler: RequestHandler = async (event) => {
	const access = await shareAccess(event.params.token);
	if (!access) error(404, 'Not found');
	const { share, credential } = access;
	if (!(await sharedSong(share, credential))) error(404, 'Not found');

	const controller = new AbortController();
	const release = holdShareStream(share.id, controller);
	event.request.signal.addEventListener('abort', release, { once: true });

	const req = {
		...streamRequestFrom(event),
		signal: AbortSignal.any([event.request.signal, controller.signal])
	};

	let response: Response;
	try {
		response = await proxySharedMedia(event, 'stream', () =>
			backendFor(share.backend).openStream(credential, share.songId, req, null)
		);
	} catch (err) {
		release();
		throw err;
	}
	if (!response.body) {
		release();
		return response;
	}

	const body = response.body.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, stream) {
				if (Date.now() >= share.expiresAt) {
					controller.abort(new Error('share expired'));
					stream.error(new Error('share expired'));
					return;
				}
				stream.enqueue(chunk);
			},
			flush: release
		}),
		{ signal: controller.signal }
	);
	return new Response(body, { status: response.status, headers: response.headers });
};

export const GET = handler;
export const HEAD = handler;
