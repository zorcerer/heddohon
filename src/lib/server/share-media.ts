/**
 * The audio and covers of a shared link: what `/share/<token>/stream[/<n>]`
 * and `/share/<token>/cover[/<n>]` answer with.
 *
 * `n`, a track's position in the album or playlist, is the only thing a
 * request names. It is looked up in the item as the sharer's account sees it
 * on this request, so it cannot reach outside the item, and a track taken out
 * of the album stops playing. A song link, and the routes without a position,
 * are position 0.
 */
import { error, type RequestEvent } from '@sveltejs/kit';
import { backendFor } from './backends';
import { nearestCoverSize, proxySharedMedia, streamRequestFrom } from './proxy';
import { holdShareStream, MAX_SHARED_TRACKS, shareAccess, sharedItem, sharedSong } from './shares';

/**
 * A position as a path segment: digits, no leading zero, below the track cap.
 * Anything else is a 404 before the token is looked at.
 */
export function positionOf(segment: string | undefined): number {
	if (segment === undefined) return 0;
	if (!/^(0|[1-9]\d{0,3})$/.test(segment)) error(404, 'Not found');
	const position = Number(segment);
	if (position >= MAX_SHARED_TRACKS) error(404, 'Not found');
	return position;
}

/*
 * Three things stop a stream. The token is resolved on every request. A stream
 * in progress is registered against the link, and withdrawing the link aborts
 * it. The link's expiry is checked as each chunk passes. The file is sent as
 * stored: transcoding follows an account's settings, and the visitor may have
 * no account.
 *
 * The track is looked up with the sharer's credential on every request.
 * Subsonic's `stream.view` and Jellyfin's audio route do not apply library
 * permissions, so without the lookup a song the sharer can no longer see went
 * on playing.
 */
export async function streamShared(event: RequestEvent, position: number): Promise<Response> {
	const token = event.params.token ?? '';
	const access = await shareAccess(token);
	if (!access) error(404, 'Not found');
	const { share, credential } = access;

	// Registered before the track is looked up. Registered after, a link
	// withdrawn during the lookup (seconds, for a long playlist) was missed by
	// the withdrawal and the track played in full.
	const controller = new AbortController();
	const release = holdShareStream(share.id, controller);
	event.request.signal.addEventListener('abort', release, { once: true });

	let song;
	try {
		song = await sharedSong(share, credential, position);
	} catch (err) {
		release();
		throw err;
	}
	if (!song || controller.signal.aborted) {
		release();
		error(404, 'Not found');
	}

	const req = {
		...streamRequestFrom(event),
		signal: AbortSignal.any([event.request.signal, controller.signal])
	};

	let response: Response;
	try {
		response = await proxySharedMedia(event, 'stream', () =>
			backendFor(share.backend).openStream(credential, song.id, req, null)
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
}

/*
 * The cover id comes from the item as the sharer's account sees it now, never
 * from the request. The cover cache is bypassed: it is for signed-in accounts,
 * and an anonymous visitor does not fill it.
 *
 * Without a position it is the item's own cover, with one that track's.
 */
export async function coverShared(event: RequestEvent, position: number | null): Promise<Response> {
	const token = event.params.token ?? '';
	const access = await shareAccess(token);
	if (!access) error(404, 'Not found');
	const { share, credential } = access;

	const item = await sharedItem(share, credential);
	const coverId =
		position === null ? (item?.coverArt ?? item?.tracks[0]?.coverArt) : item?.tracks[position]?.coverArt;
	if (!coverId) error(404, 'Not found');

	const size = nearestCoverSize(event.url.searchParams.get('size'));
	const req = streamRequestFrom(event);
	return proxySharedMedia(event, 'cover', () => backendFor(share.backend).openCover(credential, coverId, size, req));
}
