import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	checkCode,
	checkDatabase,
	decidedByEnvironment,
	finishSetup,
	forgetPending,
	forgetSecret,
	probe,
	setupPending,
	type SetupInput
} from '$lib/server/setup';
import { closeStore } from '$lib/server/db';

/** The body is a code, an address or two and a few choices. */
const MAX_BODY = 16 * 1024;

/**
 * The one endpoint of the first-run setup. Every call carries the code from
 * the server's log and is refused without it; `hooks.server.ts` serves it only
 * while the deployment is not set up, and only as JSON.
 *
 * - `check`: whether the code is right, what is missing, and what the
 *   environment already decides.
 * - `probe`: whether a music server answers at an address.
 * - `database`: whether a PostgreSQL server takes the connection.
 * - `save`: saves the setup and ends it.
 *
 * One call comes after the setup, from the page that finished it and with
 * the token that page was given: `forget`, which takes the secret out of the
 * saved file. `hooks.server.ts` serves it only while that token is good.
 */
export const POST: RequestHandler = async ({ request }) => {
	const missing = setupPending();
	// Set up, and no page is owed the one call that comes after: there is no such endpoint.
	if (missing === null && !forgetPending()) error(404, 'Not found');

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

	if (body.action === 'forget') {
		if (!forgetSecret(body.token)) return json({ error: 'wrong_token' }, { status: 401 });
		return json({ ok: true });
	}
	if (missing === null) error(404, 'Not found');

	if (!checkCode(body.code)) return json({ error: 'wrong_code' }, { status: 401 });

	switch (body.action) {
		case 'check':
			return json({ ok: true, missing, environment: decidedByEnvironment() });
		case 'probe': {
			if (body.kind !== 'subsonic' && body.kind !== 'jellyfin') return json({ error: 'bad_request' }, { status: 400 });
			return json(await probe(body.kind, body.url));
		}
		case 'database':
			return json(await checkDatabase(body.database));
		case 'save': {
			const values = typeof body.values === 'object' && body.values !== null ? (body.values as SetupInput) : {};
			const postgres = !decidedByEnvironment().database && (values.database as { kind?: unknown } | undefined)?.kind === 'postgres';
			if (postgres) {
				const reached = await checkDatabase(values.database);
				if (!reached.ok) return json({ ok: false, field: 'database', message: reached.message }, { status: 400 });
			}
			const outcome = finishSetup(values);
			// A SQLite file opened while the setup waited is not the database any more.
			if (outcome.ok && postgres) await closeStore();
			return json(outcome, { status: outcome.ok ? 200 : 400 });
		}
		default:
			return json({ error: 'bad_request' }, { status: 400 });
	}
};
