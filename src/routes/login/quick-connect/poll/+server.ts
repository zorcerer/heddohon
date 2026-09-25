import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { createSession, rememberDevice, signInWithQuickConnect } from '$lib/server/auth';
import { backendFor, UpstreamError, type QuickConnectState } from '$lib/server/backends';
import { safeNext } from '$lib/server/next';
import { config } from '$lib/server/config';
import {
	claim,
	clearPending,
	forgetChecks,
	isClaimed,
	mayCheckUpstream,
	readPending,
	release
} from '$lib/server/quickconnect';
import { log, reason } from '$lib/server/log';

/**
 * Asks whether the code this browser is showing has been approved, and signs
 * the browser in once it has.
 *
 * A POST, although it mostly reads: the last answer creates a session, and a
 * POST is what the cross-origin check in hooks.server.ts covers.
 *
 * Answers `state`: `waiting`, `expired`, or `signed-in` with `next`.
 */
export const POST: RequestHandler = async (event) => {
	const body = (await event.request.json().catch(() => null)) as {
		code?: unknown;
		next?: unknown;
	} | null;
	const code = typeof body?.code === 'string' ? body.code : '';
	const address = event.getClientAddress();

	const pending = code ? readPending(event, code) : null;
	// The backend is checked against the configuration again: the cookie can
	// outlive a restart that removed it.
	const quickConnect =
		pending && config().upstreams.some((upstream) => upstream.kind === pending.backend)
			? backendFor(pending.backend).quickConnect
			: undefined;
	if (!pending || !quickConnect || isClaimed(pending.secret)) return json({ state: 'expired' });

	if (!mayCheckUpstream(pending.secret)) return json({ state: 'waiting' });

	let state: QuickConnectState;
	try {
		state = await quickConnect.state(pending.secret, pending.deviceId);
	} catch (err) {
		// A music server that did not answer this time may answer the next. The
		// request stays pending until Jellyfin says otherwise or the cookie expires.
		log.warn('quick-connect-failed', {
			backend: pending.backend,
			address,
			step: 'check',
			detail: reason(err)
		});
		return json({ state: 'waiting' });
	}

	if (state === 'waiting') return json({ state });
	if (state === 'expired') {
		clearPending(event);
		forgetChecks(pending.secret);
		return json({ state });
	}

	// Another request is finishing this sign-in, or already has.
	if (!claim(pending.secret)) return json({ state: 'expired' });

	let account;
	try {
		account = await signInWithQuickConnect(pending.backend, pending.secret, pending.deviceId);
	} catch (err) {
		// A refused secret will be refused again. Anything else, such as a timeout,
		// leaves the approval standing, so the secret is handed back and the next
		// poll tries again.
		const refused = err instanceof UpstreamError && err.status === 400;
		log.warn('sign-in-rejected', {
			backend: pending.backend,
			method: 'quick-connect',
			address,
			kind: err instanceof UpstreamError ? err.kind : 'error',
			detail: reason(err)
		});
		if (!refused) {
			release(pending.secret);
			return json({ state: 'waiting' });
		}
		clearPending(event);
		return json({ state: 'expired' });
	}

	clearPending(event);
	await createSession(event, account, event.request.headers.get('user-agent'));
	rememberDevice(event, pending.backend, account.username);
	log.info('signed-in', {
		username: account.username,
		backend: pending.backend,
		method: 'quick-connect',
		address
	});
	return json({ state: 'signed-in', next: safeNext(body?.next) });
};
