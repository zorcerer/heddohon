import { error, redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { config } from '$lib/server/config';
import { safeNext } from '$lib/server/next';
import { beginOidc } from '$lib/server/oidc';

/**
 * Starts a sign-in through the identity provider and sends the browser there
 * (`oidc.ts`). Under `/login`, so reachable without a session.
 *
 * A GET, the button on the sign-in page being a link: the page's
 * `form-action 'self'` stops a form whose answer redirects to another site,
 * in Chromium. It writes nothing but this browser's own cookie, and a
 * sign-in started from another site ends at the account of whoever completes
 * it at the provider.
 */
export const GET: RequestHandler = async (event) => {
	if (!config().oidc) error(404, 'Not found');
	const next = safeNext(event.url.searchParams.get('next'));
	const to = await beginOidc(event, 'sign-in', null, next);
	if (!to) redirect(303, `/login?oidc=unreachable&next=${encodeURIComponent(next)}`);
	redirect(303, to);
};
