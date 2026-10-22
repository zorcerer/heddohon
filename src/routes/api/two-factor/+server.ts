import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { config, saveSetup } from '$lib/server/config';
import { decidedByEnvironment } from '$lib/server/setup';
import { accountIdByName, destroyAllSessions } from '$lib/server/auth';
import { backendFor } from '$lib/server/backends';
import { log } from '$lib/server/log';
import {
	addPasskey,
	afterFactorChange,
	checkProof,
	clearSecondFactors,
	confirmTotp,
	factorsOf,
	hasSecondFactor,
	listPasskeys,
	makeRecoveryCodes,
	MAX_PASSKEY_NAME,
	MAX_PASSKEYS,
	passkeyCreationOptions,
	passkeysOffered,
	proofOptions,
	removePasskey,
	removeTotp,
	renamePasskey,
	startTotp,
	type Proof
} from '$lib/server/twofactor';

/** A passkey's id as the table holds it: base64url of at most 1023 bytes. */
const PASSKEY_ID = /^[A-Za-z0-9_-]{1,1364}$/;

/**
 * The account's second factors, for Settings, Security: what it has, its
 * passkeys by name, whether this address can use passkeys, and whether the
 * server requires a factor.
 */
export const GET: RequestHandler = async ({ locals, url }) => {
	const session = locals.session;
	if (!session) error(401, 'Not signed in');
	const [factors, passkeys] = await Promise.all([factorsOf(session.account.id), listPasskeys(session.account.id)]);
	return json({
		...factors,
		passkeyList: passkeys,
		passkeysOffered: passkeysOffered(url),
		required: config().requireTwoFactor,
		maxPasskeys: MAX_PASSKEYS,
		maxPasskeyName: MAX_PASSKEY_NAME
	});
};

/**
 * Every change to the account's factors, by `action`. Those that add or
 * take away a factor, or show recovery codes, need `proof` (`checkProof`):
 * a code or a passkey where the account has a factor, its password where it
 * has none. Adding a factor, and taking the last one away, ends the account's
 * other sessions.
 */
export const POST: RequestHandler = async (event) => {
	const session = event.locals.session;
	if (!session) error(401, 'Not signed in');
	const body = (await event.request.json().catch(() => null)) as {
		action?: unknown;
		proof?: Proof;
		code?: unknown;
		credential?: unknown;
		name?: unknown;
		id?: unknown;
		username?: unknown;
		on?: unknown;
	} | null;
	if (!body || typeof body.action !== 'string') error(400, 'action is required');
	const account = session.account;
	const proof = typeof body.proof === 'object' && body.proof !== null ? body.proof : null;

	async function proven(): Promise<Response | null> {
		const verdict = await checkProof(event, session!, proof);
		return verdict.ok ? null : json({ error: verdict.message }, { status: verdict.status });
	}

	/** Whether taking a factor away would leave none where one is required. */
	async function lastRequired(remaining: (factors: Awaited<ReturnType<typeof factorsOf>>) => boolean): Promise<boolean> {
		return config().requireTwoFactor && !remaining(await factorsOf(account.id));
	}

	switch (body.action) {
		case 'proof-options':
			// A challenge for a passkey to prove the holder with, before a change.
			if (!passkeysOffered(event.url)) error(404, 'Passkeys need this server on https.');
			return json(await proofOptions(event, account.id));

		case 'totp-start': {
			const refused = await proven();
			if (refused) return refused;
			const started = await startTotp(account);
			if (!started) return json({ error: 'An authenticator app is on already.' }, { status: 409 });
			return json(started);
		}

		case 'totp-confirm': {
			if (typeof body.code !== 'string' || body.code.length > 64) error(400, 'code is required');
			const codes = await confirmTotp(account.id, body.code);
			if (codes === null) return json({ error: 'That code was not right. Check the time on your phone and try the next one.' }, { status: 403 });
			const ended = await afterFactorChange(session);
			log.warn('second-factor-added', { account: account.id, factor: 'totp', sessionsEnded: ended });
			return json({ recoveryCodes: codes, sessionsEnded: ended });
		}

		case 'totp-remove': {
			if (await lastRequired((factors) => factors.passkeys > 0)) {
				return json({ error: 'This server requires a second factor. Add a passkey before removing the app.' }, { status: 409 });
			}
			const refused = await proven();
			if (refused) return refused;
			await removeTotp(account.id);
			const ended = (await factorsOf(account.id)).passkeys === 0 ? await afterFactorChange(session) : 0;
			log.warn('second-factor-removed', { account: account.id, factor: 'totp', sessionsEnded: ended });
			return json({ removed: true, sessionsEnded: ended });
		}

		case 'recovery-new': {
			const factors = await factorsOf(account.id);
			if (!factors.totp && factors.passkeys === 0) return json({ error: 'Turn on a second factor first.' }, { status: 409 });
			const refused = await proven();
			if (refused) return refused;
			log.warn('recovery-codes-made', { account: account.id });
			return json({ recoveryCodes: await makeRecoveryCodes(account.id) });
		}

		case 'passkey-options': {
			if (!passkeysOffered(event.url)) error(404, 'Passkeys need this server on https.');
			if ((await listPasskeys(account.id)).length >= MAX_PASSKEYS) {
				return json({ error: `An account holds at most ${MAX_PASSKEYS} passkeys. Remove one to add another.` }, { status: 409 });
			}
			const refused = await proven();
			if (refused) return refused;
			return json(await passkeyCreationOptions(event, account));
		}

		case 'passkey-add': {
			if (!passkeysOffered(event.url)) error(404, 'Passkeys need this server on https.');
			if (typeof body.name !== 'string' || body.name.length > 300) error(400, 'name is required');
			// The proof was given for the challenge in `passkey-options`, which this answers.
			const added = await addPasskey(event, account, body.credential, body.name);
			if (!added.ok) return json({ error: added.message }, { status: 400 });
			const ended = await afterFactorChange(session);
			log.warn('second-factor-added', { account: account.id, factor: 'passkey', sessionsEnded: ended });
			return json({ passkey: added.passkey, recoveryCodes: added.recoveryCodes, sessionsEnded: ended });
		}

		case 'passkey-rename': {
			if (typeof body.id !== 'string' || !PASSKEY_ID.test(body.id)) error(400, 'id is required');
			if (typeof body.name !== 'string' || body.name.length > 300) error(400, 'name is required');
			if (!(await renamePasskey(account.id, body.id, body.name))) return json({ error: 'No such passkey.' }, { status: 404 });
			return json({ renamed: true });
		}

		case 'passkey-remove': {
			if (typeof body.id !== 'string' || !PASSKEY_ID.test(body.id)) error(400, 'id is required');
			if (await lastRequired((factors) => factors.totp || factors.passkeys > 1)) {
				return json({ error: 'This server requires a second factor. Add another before removing this one.' }, { status: 409 });
			}
			const refused = await proven();
			if (refused) return refused;
			if (!(await removePasskey(account.id, body.id))) return json({ error: 'No such passkey.' }, { status: 404 });
			const left = await factorsOf(account.id);
			const ended = !left.totp && left.passkeys === 0 ? await afterFactorChange(session) : 0;
			log.warn('second-factor-removed', { account: account.id, factor: 'passkey', sessionsEnded: ended });
			return json({ removed: true, sessionsEnded: ended });
		}

		/*
		 * For an administrator of the music server. Read from the music server
		 * at each request, as the other switches under Settings are.
		 */
		case 'admin-require':
		case 'admin-clear': {
			if ((await backendFor(account.backend).isAdmin(session.credential)) !== true) {
				return json({ error: 'Only an administrator of the music server can change this.' }, { status: 403 });
			}
			if (config().requireTwoFactor && !(await hasSecondFactor(account.id))) {
				return json({ error: 'Set up your own second factor first.' }, { status: 403 });
			}
			if (body.action === 'admin-require') {
				if (typeof body.on !== 'boolean') error(400, 'on is required');
				if (decidedByEnvironment().requireTwoFactor) {
					return json({ error: 'HEDDOHON_REQUIRE_TWO_FACTOR in the environment decides this.' }, { status: 409 });
				}
				// Off is the default, so it is saved as no value.
				saveSetup({ HEDDOHON_REQUIRE_TWO_FACTOR: body.on ? 'true' : '' });
				log.warn('two-factor-required-switched', { by: account.username, on: body.on });
				return json({ required: body.on });
			}
			if (typeof body.username !== 'string' || body.username.trim() === '' || body.username.length > 256) {
				error(400, 'username is required');
			}
			const target = await accountIdByName(account.backend, body.username.trim());
			if (!target) return json({ error: 'No account of that name has signed in here.' }, { status: 404 });
			if (target === account.id) return json({ error: 'Remove your own factors above.' }, { status: 409 });
			const refused = await proven();
			if (refused) return refused;
			await clearSecondFactors(target);
			await destroyAllSessions(target);
			log.warn('two-factor-cleared', { account: target, by: account.username });
			return json({ cleared: true });
		}

		default:
			error(400, 'Unknown action');
	}
};
