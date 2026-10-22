import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { createSession, destroySession, rememberDevice } from '$lib/server/auth';
import { safeNext } from '$lib/server/next';
import { passkeyStartKeys, pruneLoginAttempts, reserveLoginAttempt, visitorAddress } from '$lib/server/ratelimit';
import {
	finishStepWithPasskey,
	passkeysOffered,
	signInOptions,
	signInWithPasskey,
	stepPasskeyOptions
} from '$lib/server/twofactor';
import { log } from '$lib/server/log';

/**
 * Passkeys at sign-in, under `/login`, so reachable without a session. Each
 * call is a POST, which the cross-origin check in hooks.server.ts covers.
 *
 * `{ action: 'options', for }` hands out a challenge: `for: 'step'` for the
 * sign-in this browser holds after its password (`beginStep`), `for:
 * 'sign-in'` for a passkey alone. `{ action: 'verify', for, credential,
 * next }` checks the answer and signs in. Answers `{ error }` with a status
 * otherwise.
 */
export const POST: RequestHandler = async (event) => {
	if (!passkeysOffered(event.url)) return json({ error: 'Passkeys need this server on https.' }, { status: 404 });
	const body = (await event.request.json().catch(() => null)) as {
		action?: unknown;
		for?: unknown;
		credential?: unknown;
		next?: unknown;
	} | null;
	const purpose = body?.for === 'step' ? 'step' : body?.for === 'sign-in' ? 'sign-in' : null;
	if (!purpose || (body?.action !== 'options' && body?.action !== 'verify')) {
		return json({ error: 'bad_request' }, { status: 400 });
	}
	const address = event.getClientAddress();

	if (body.action === 'options') {
		if (purpose === 'step') {
			const options = await stepPasskeyOptions(event);
			return options ? json(options) : json({ error: 'That sign-in expired. Sign in again.' }, { status: 400 });
		}
		// A challenge is stored before anybody is known; see `passkeyStartKeys`.
		const verdict = await reserveLoginAttempt(passkeyStartKeys(visitorAddress(event)));
		await pruneLoginAttempts();
		if (!verdict.allowed) {
			log.warn('passkey-throttled', { address, retryAfter: verdict.retryAfter });
			return json({ error: 'Too many passkey sign-ins. Try again shortly.' }, { status: 429 });
		}
		return json(await signInOptions(event));
	}

	const outcome =
		purpose === 'step' ? await finishStepWithPasskey(event, body.credential) : await signInWithPasskey(event, body.credential);
	if (!outcome.ok) {
		return json(
			{ error: outcome.message, restart: 'restart' in outcome ? outcome.restart : false },
			{ status: outcome.status }
		);
	}

	const { account } = outcome;
	// A browser already signed in replaces its session, as Quick Connect does.
	await destroySession(event);
	await createSession(event, account, event.request.headers.get('user-agent'));
	rememberDevice(event, account);
	log.info('signed-in', {
		username: account.username,
		backend: account.backend,
		method: 'method' in outcome ? String(outcome.method) : 'passkey',
		factor: 'passkey',
		address
	});
	return json({ state: 'signed-in', next: safeNext(body.next) });
};
