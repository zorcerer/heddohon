import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { config } from '$lib/server/config';
import { tiedToSession } from '$lib/server/auth';
import { deviceLabel } from '$lib/server/device';
import { join, leave } from '$lib/server/remote';

/**
 * A comment line this often keeps the stream open through a reverse proxy
 * that closes an idle connection (nginx's `proxy_read_timeout` is 60s by
 * default), and is also when `tiedToSession` checks the session's expiry.
 */
const KEEPALIVE_MS = 25_000;

/**
 * This browser's stream of what the account's other browsers are playing, and
 * of the commands they send it; see `remote.ts`. It ends with the session:
 * signing out, being signed out from Settings and the 72-hour expiry all cut it.
 */
export const GET: RequestHandler = async ({ locals, request }) => {
	const session = locals.session;
	if (!session) error(401, 'Not signed in');
	if (!config().remoteControl) error(404, 'Not found');

	const encoder = new TextEncoder();
	let peerId: string | null = null;
	let keepalive: ReturnType<typeof setInterval> | null = null;
	const close = () => {
		if (keepalive) clearInterval(keepalive);
		keepalive = null;
		if (peerId) leave(session.account.id, peerId);
		peerId = null;
	};

	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			const write = (text: string) => {
				try {
					controller.enqueue(encoder.encode(text));
				} catch {
					// Closed between the check and the write; `cancel` cleans up.
				}
			};
			const peer = join(session.account.id, session.handle, deviceLabel(request.headers.get('user-agent')), (event, data) =>
				write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
			);
			if (!peer) {
				// A browser reconnects after a closed stream, so it is told to wait
				// a minute rather than try again at once.
				write('retry: 60000\nevent: full\ndata: {}\n\n');
				controller.close();
				return;
			}
			peerId = peer.id;
			keepalive = setInterval(() => write(': keepalive\n\n'), KEEPALIVE_MS);
		},
		cancel: close
	});
	request.signal.addEventListener('abort', close, { once: true });

	const response = new Response(body, {
		headers: {
			'content-type': 'text/event-stream; charset=utf-8',
			'cache-control': 'private, no-store',
			// nginx buffers a response unless told not to, which holds every event
			// until the buffer fills.
			'x-accel-buffering': 'no'
		}
	});
	return tiedToSession(session, request.signal, response);
};
