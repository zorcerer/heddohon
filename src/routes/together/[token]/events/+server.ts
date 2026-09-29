import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { listen, togetherEnabled } from '$lib/server/together';

/** See `routes/api/remote/events`: the same keepalive, for the same proxies. */
const KEEPALIVE_MS = 25_000;

/**
 * A listener's stream: what the host plays, how many are listening, the
 * reactions, and `ended`. Refused when the party has ended or is full.
 */
export const GET: RequestHandler = async ({ params, request }) => {
	if (!togetherEnabled()) error(404, 'Not found');
	const encoder = new TextEncoder();
	let leave: (() => void) | null = null;
	let keepalive: ReturnType<typeof setInterval> | null = null;
	const close = () => {
		if (keepalive) clearInterval(keepalive);
		keepalive = null;
		leave?.();
		leave = null;
	};

	let full = false;
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			const write = (text: string) => {
				try {
					controller.enqueue(encoder.encode(text));
				} catch {
					// Closed between the check and the write; `cancel` cleans up.
				}
			};
			const joined = listen(params.token, (event, data) => {
				write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
				// The party is over; the stream is too.
				if (event === 'ended') {
					close();
					try {
						controller.close();
					} catch {
						// Already closed.
					}
				}
			});
			if (!joined) {
				full = true;
				controller.close();
				return;
			}
			leave = joined.leave;
			keepalive = setInterval(() => write(': keepalive\n\n'), KEEPALIVE_MS);
		},
		cancel: close
	});
	request.signal.addEventListener('abort', close, { once: true });
	if (full) error(404, 'This listening session has ended or is full.');

	return new Response(body, {
		headers: {
			'content-type': 'text/event-stream; charset=utf-8',
			'cache-control': 'private, no-store',
			'x-accel-buffering': 'no'
		}
	});
};
