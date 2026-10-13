import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { checkCode, finishSetup, probe, setupPending, type SetupInput } from '$lib/server/setup';

/** The body is a code, an address or two and a few choices. */
const MAX_BODY = 16 * 1024;

/**
 * The one endpoint of the first-run setup. Every call carries the code from
 * the server's log and is refused without it; `hooks.server.ts` serves it only
 * while the deployment is not set up, and only as JSON.
 *
 * - `check`: whether the code is right, and what is missing.
 * - `probe`: whether a music server answers at an address.
 * - `save`: saves the setup and ends it.
 */
export const POST: RequestHandler = async ({ request }) => {
	const missing = setupPending();
	// Set up: there is no such endpoint.
	if (missing === null) error(404, 'Not found');

	let body: Record<string, unknown>;
	try {
		const text = await request.text();
		if (text.length > MAX_BODY) return json({ error: 'too_large' }, { status: 413 });
		const parsed: unknown = JSON.parse(text);
		if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object');
		body = parsed as Record<string, unknown>;
	} catch {
		return json({ error: 'bad_request' }, { status: 400 });
	}

	if (!checkCode(body.code)) return json({ error: 'wrong_code' }, { status: 401 });

	switch (body.action) {
		case 'check':
			return json({ ok: true, missing });
		case 'probe': {
			if (body.kind !== 'subsonic' && body.kind !== 'jellyfin') return json({ error: 'bad_request' }, { status: 400 });
			return json(await probe(body.kind, body.url));
		}
		case 'save': {
			const values = typeof body.values === 'object' && body.values !== null ? (body.values as SetupInput) : {};
			const outcome = finishSetup(values);
			return json(outcome, { status: outcome.ok ? 200 : 400 });
		}
		default:
			return json({ error: 'bad_request' }, { status: 400 });
	}
};
