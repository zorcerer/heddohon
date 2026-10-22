import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { config } from '$lib/server/config';
import { log } from '$lib/server/log';
import { beginOidc, linkOf, unlinkIdentity } from '$lib/server/oidc';
import { checkProof, type Proof } from '$lib/server/twofactor';

/**
 * The account's link to the identity provider, for Settings, Security:
 * the provider's name and the link, or `provider: null` where none is
 * configured.
 */
export const GET: RequestHandler = async ({ locals }) => {
	const session = locals.session;
	if (!session) error(401, 'Not signed in');
	const oidc = config().oidc;
	return json({ provider: oidc?.label ?? null, link: oidc ? await linkOf(session.account.id) : null });
};

/**
 * `link` answers with the provider's address for the browser to go to, and
 * needs `proof` (`checkProof`), as adding a passkey does: a link is a way in
 * without the password. `unlink` takes one away and needs none.
 */
export const POST: RequestHandler = async (event) => {
	const session = event.locals.session;
	if (!session) error(401, 'Not signed in');
	if (!config().oidc) error(404, 'No identity provider is configured.');
	const body = (await event.request.json().catch(() => null)) as { action?: unknown; proof?: Proof } | null;
	const account = session.account;

	switch (body?.action) {
		case 'link': {
			const proof = typeof body.proof === 'object' && body.proof !== null ? body.proof : null;
			const verdict = await checkProof(event, session, proof);
			if (!verdict.ok) return json({ error: verdict.message }, { status: verdict.status });
			const to = await beginOidc(event, 'link', account.id, '/settings?tab=security');
			if (!to) return json({ error: 'The identity provider could not be reached. Try again shortly.' }, { status: 502 });
			return json({ url: to });
		}
		case 'unlink': {
			const removed = await unlinkIdentity(account.id);
			if (removed) log.warn('oidc-unlinked', { account: account.id });
			return json({ removed });
		}
		default:
			error(400, 'Unknown action');
	}
};
