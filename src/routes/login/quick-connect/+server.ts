import { json } from '@sveltejs/kit';
import { randomUUID } from 'node:crypto';
import type { RequestHandler } from './$types';
import { config } from '$lib/server/config';
import { backendFor, isBackendKind, UpstreamError } from '$lib/server/backends';
import { QUICK_CONNECT_TTL_MS, clearPending, savePending } from '$lib/server/quickconnect';
import {
	pruneLoginAttempts,
	quickConnectKeys,
	refundLoginAttempt,
	reserveLoginAttempt
} from '$lib/server/ratelimit';
import { log, reason } from '$lib/server/log';

/**
 * Starts a Quick Connect request and answers with the code to show.
 *
 * Under `/login` so that it is reachable without a session. It is a POST, so
 * the cross-origin check in hooks.server.ts applies to it as to every write.
 */
export const POST: RequestHandler = async (event) => {
	const body = (await event.request.json().catch(() => null)) as { backend?: unknown } | null;
	const address = event.getClientAddress();

	const servers = config().upstreams;
	const backend = isBackendKind(body?.backend)
		? body.backend
		: servers.length === 1
			? servers[0].kind
			: null;
	if (!backend || !servers.some((server) => server.kind === backend)) {
		return json({ error: 'Choose which music server to sign in to.' }, { status: 400 });
	}

	const quickConnect = backendFor(backend).quickConnect;
	if (!quickConnect || !(await quickConnect.enabled())) {
		return json({ error: 'Quick Connect is not turned on for this server.' }, { status: 404 });
	}

	const keys = quickConnectKeys(address);
	const verdict = reserveLoginAttempt(keys);
	// Starts never reach the path that prunes after a rejected password, so the
	// rows they leave are dropped here.
	pruneLoginAttempts();
	if (!verdict.allowed) {
		log.warn('quick-connect-throttled', { backend, address, retryAfter: verdict.retryAfter });
		return json(
			{
				error: `Too many Quick Connect requests. Try again in ${Math.ceil(verdict.retryAfter / 60)} minute${verdict.retryAfter > 60 ? 's' : ''}.`
			},
			{ status: 429 }
		);
	}

	// Fresh per request. Jellyfin issues the token to the device that started the
	// request, so this id is sealed with the secret and used again to finish.
	const deviceId = randomUUID();
	let started;
	try {
		started = await quickConnect.initiate(deviceId);
	} catch (err) {
		// Nothing is pending upstream after a failed start, so it costs nothing.
		refundLoginAttempt(keys);
		if (err instanceof UpstreamError) {
			log.warn('quick-connect-failed', { backend, address, step: 'initiate', detail: err.message });
			return err.status === 401
				? json({ error: 'Quick Connect is not turned on for this server.' }, { status: 404 })
				: json(
						{ error: 'The music server could not start Quick Connect. Try again shortly.' },
						{ status: 502 }
					);
		}
		log.error('quick-connect-failed', { backend, address, step: 'initiate', detail: reason(err) });
		return json({ error: 'Quick Connect failed unexpectedly.' }, { status: 500 });
	}

	savePending(event, { backend, ...started, deviceId, startedAt: Date.now() });
	log.info('quick-connect-started', { backend, address });
	return json({ code: started.code, expiresIn: Math.floor(QUICK_CONNECT_TTL_MS / 1000) });
};

/** Abandons the pending request on this browser. Jellyfin expires its side. */
export const DELETE: RequestHandler = async (event) => {
	clearPending(event);
	return new Response(null, { status: 204 });
};
