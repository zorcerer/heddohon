import { error, redirect, type RequestEvent } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { config } from '$lib/server/config';
import { accountById, createSession, destroySession, rememberDevice } from '$lib/server/auth';
import { backendFor, UpstreamError } from '$lib/server/backends';
import { accountOfIdentity, finishOidc, linkIdentity, type OidcReturn } from '$lib/server/oidc';
import { oidcKeys, pruneLoginAttempts, reserveLoginAttempt, visitorAddress } from '$lib/server/ratelimit';
import { beginStep } from '$lib/server/twofactor';
import { log } from '$lib/server/log';

/**
 * Where the identity provider sends the browser back (`oidc.ts`), for a
 * sign-in or a link started in Settings. A GET that changes state, as an
 * OAuth return has to be: the state, the nonce and the PKCE verifier are in
 * this browser's own cookie, so a return sent to another browser is refused
 * before anything reaches the provider. `code` and `state` are kept out of
 * the request log by `redact` in `log.ts`.
 */
export const GET: RequestHandler = async (event) => {
	if (!config().oidc) error(404, 'Not found');
	const address = event.getClientAddress();
	const verdict = await reserveLoginAttempt(oidcKeys(visitorAddress(event)));
	await pruneLoginAttempts();
	if (!verdict.allowed) {
		log.warn('oidc-throttled', { address, retryAfter: verdict.retryAfter });
		redirect(303, '/login?oidc=throttled');
	}

	const outcome = await finishOidc(event);
	if (!outcome.ok) {
		// A return with no pending sign-in in this browser goes to Settings
		// where it is signed in, which is where a link would have started.
		const linking = outcome.purpose === 'link' || (outcome.purpose === null && event.locals.session !== null);
		redirect(
			303,
			linking ? `/settings?tab=security&oidc=${outcome.failure}` : `/login?oidc=${outcome.failure}&next=${encodeURIComponent(outcome.next)}`
		);
	}
	if (outcome.purpose === 'link') return link(event, outcome);
	return signIn(event, outcome);
};

type Completed = Extract<OidcReturn, { ok: true }>;

/** Links the identity to the account that started the link, if this browser is still signed in to it. */
async function link(event: RequestEvent, outcome: Completed): Promise<never> {
	const session = event.locals.session;
	if (!session || session.account.id !== outcome.accountId) {
		log.warn('oidc-rejected', { purpose: 'link', step: 'session', detail: 'not the session that started the link' });
		redirect(303, '/settings?tab=security&oidc=refused');
	}
	if (!(await linkIdentity(session.account.id, outcome.issuer, outcome.subject))) {
		log.warn('oidc-rejected', { purpose: 'link', step: 'link', account: session.account.id, detail: 'linked to another account' });
		redirect(303, '/settings?tab=security&oidc=taken');
	}
	log.warn('oidc-linked', { account: session.account.id });
	redirect(303, '/settings?tab=security&oidc=linked');
}

/**
 * Signs in to the linked account through the credential stored at its last
 * password sign-in, after asking the music server whether it still takes
 * it, as `signInWithPasskey` does. An account with a second factor is asked
 * for it (`beginStep`): the provider's sign-in stands in for the password,
 * not for the factor.
 */
async function signIn(event: RequestEvent, outcome: Completed): Promise<Response> {
	const address = event.getClientAddress();
	const back = (problem: string) => redirect(303, `/login?oidc=${problem}&next=${encodeURIComponent(outcome.next)}`);
	const accountId = await accountOfIdentity(outcome.issuer, outcome.subject);
	if (!accountId) {
		log.warn('oidc-rejected', { purpose: 'sign-in', step: 'link', address, detail: 'identity not linked' });
		back('unlinked');
	}
	const found = await accountById(accountId!);
	if (!found || !config().upstreams.some((upstream) => upstream.kind === found.account.backend)) back('stale');
	const { account, credential } = found!;
	try {
		await backendFor(account.backend).checkCredential(credential);
	} catch (err) {
		if (err instanceof UpstreamError && err.kind === 'auth') {
			log.warn('oidc-credential-stale', { account: account.id });
			back('stale');
		}
		back('unreachable');
	}

	// A browser already signed in replaces its session, as a passkey does.
	await destroySession(event);
	const step = await beginStep(event, account.backend, account.id, { credential, remoteUserId: account.remoteUserId }, 'oidc');
	if (step) {
		log.info('sign-in-step', { username: account.username, backend: account.backend, method: 'oidc', address });
		return onwards(`/login?next=${encodeURIComponent(outcome.next)}`);
	}
	await createSession(event, account, event.request.headers.get('user-agent'));
	rememberDevice(event, account);
	log.info('signed-in', { username: account.username, backend: account.backend, method: 'oidc', address });
	redirect(303, outcome.next);
}

/**
 * Sends the browser on by a page of its own rather than a redirect. The held
 * sign-in's cookie is `SameSite=Strict`, and a redirect here is still part
 * of the navigation the provider's site started, which a browser does not
 * send that cookie with: the sign-in page would ask for a password. A
 * refresh from this page is a navigation of this site.
 */
function onwards(path: string): Response {
	const target = path.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
	return new Response(
		`<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${target}"><title>Signing in</title><p><a href="${target}">Continue</a></p>`,
		{ headers: { 'content-type': 'text/html; charset=utf-8' } }
	);
}
