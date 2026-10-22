/**
 * A second factor at sign-in: a TOTP app, passkeys, and recovery codes for
 * when both are lost (issue #225).
 *
 *  1. Heddohon holds no password of its own (`auth.ts`), so a factor here is
 *     on top of the music server's check and protects the Heddohon session,
 *     whatever the music server does.
 *  2. A sign-in the music server accepts for an account with a factor is held
 *     in `sign_in_steps`, the music server's answer sealed, and stored as the
 *     account's only once the factor is given (`finishStep`). A password
 *     alone changes no row of the account.
 *  3. Wrong factors are counted per account (`secondFactorKeys`), 5 in 15
 *     minutes, and per held sign-in, 5 before it has to start again.
 *  4. A change to the factors needs a proof (`checkProof`): one of the
 *     account's factors where it has one, its music server password where it
 *     has none. Adding one, or taking the last one away, ends the account's
 *     other sessions.
 *  5. A passkey also signs in on its own, with the user verified by the
 *     authenticator, through the credential stored at the last password
 *     sign-in. The music server is asked whether that credential still works
 *     first (`checkCredential`), so a password changed there ends it.
 */
import { randomBytes, randomInt } from 'node:crypto';
import type { Cookies } from '@sveltejs/kit';
import type { BackendKind } from '$lib/types';
import { now, store } from './db';
import {
	constantTimeEquals,
	openJson,
	passkeyChallengeDigest,
	randomToken,
	recoveryDigest,
	sealJson,
	signInStepDigest
} from './crypto';
import {
	accountById,
	cookieSecure,
	endSessions,
	storeAccount,
	type Account,
	type AuthenticatedSession,
	type UpstreamSignIn
} from './auth';
import { backendFor, UpstreamError } from './backends';
import { config } from './config';
import { log } from './log';
import {
	clearLoginFailures,
	clearSecondFactorFailures,
	loginKeys,
	refundLoginAttempt,
	reserveLoginAttempt,
	secondFactorKeys,
	visitorAddress
} from './ratelimit';
import { matchingStep, newTotpSecret, totpUri } from './totp';
import {
	ALGORITHMS,
	readAssertion,
	readRegistration,
	toBase64url,
	verifyAssertion,
	WebAuthnError
} from './webauthn';

/** A held sign-in lasts this long, as Quick Connect's code does in the browser. */
const STEP_TTL_MS = 5 * 60 * 1000;
/** Factors one held sign-in may be sent before it is dropped. */
const STEP_MAX_ATTEMPTS = 5;
/** Held sign-ins one account may have at once; see `beginStep`. */
const MAX_STEPS_PER_ACCOUNT = 10;
/** A WebAuthn challenge lasts as long as the browser's own `timeout`. */
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
export const RECOVERY_CODE_COUNT = 10;
export const MAX_PASSKEYS = 20;
export const MAX_PASSKEY_NAME = 64;

const STEP_COOKIE = 'heddohon_sign_in_step';

export interface FactorSummary {
	totp: boolean;
	passkeys: number;
	recoveryCodes: number;
}

export interface PasskeySummary {
	id: string;
	name: string;
	createdAt: number;
	lastUsedAt: number | null;
}

/** What an event needs for the cookie and the WebAuthn origin. */
interface StepContext {
	cookies: Cookies;
	url: URL;
}

// ---------------------------------------------------------------------------
// What an account has

export async function factorsOf(accountId: string): Promise<FactorSummary> {
	const database = await store();
	const [totp, passkeys, codes] = await Promise.all([
		database.get<{ confirmed: number }>('SELECT confirmed FROM totp WHERE account_id = ?', accountId),
		database.get<{ count: number }>('SELECT COUNT(*) AS count FROM passkeys WHERE account_id = ?', accountId),
		database.get<{ count: number }>('SELECT COUNT(*) AS count FROM recovery_codes WHERE account_id = ?', accountId)
	]);
	return {
		totp: Number(totp?.confirmed ?? 0) === 1,
		passkeys: Number(passkeys?.count ?? 0),
		recoveryCodes: Number(codes?.count ?? 0)
	};
}

function hasAny(factors: FactorSummary): boolean {
	return factors.totp || factors.passkeys > 0;
}

/*
 * Whether an account has a factor, for the gate in `hooks.server.ts` while
 * one is required, which asks on every request. Held for 5 seconds;
 * everything here that changes an account's factors drops its entry, and a
 * second process on the same PostgreSQL database sees a change up to 5
 * seconds late.
 */
const HELD_MS = 5000;
const HELD_MAX = 5000;
const held = new Map<string, { has: boolean; until: number }>();

export async function hasSecondFactor(accountId: string): Promise<boolean> {
	const entry = held.get(accountId);
	if (entry && entry.until > now()) return entry.has;
	const has = hasAny(await factorsOf(accountId));
	held.set(accountId, { has, until: now() + HELD_MS });
	if (held.size > HELD_MAX) held.delete(held.keys().next().value!);
	return has;
}

function changed(accountId: string): void {
	held.delete(accountId);
}

/**
 * Removes every factor of the account: an administrator's reset, or a new
 * user under the name (`storeAccount`). Its held sign-ins go too.
 */
export async function clearSecondFactors(accountId: string): Promise<void> {
	const database = await store();
	await database.run('DELETE FROM totp WHERE account_id = ?', accountId);
	await database.run('DELETE FROM passkeys WHERE account_id = ?', accountId);
	await database.run('DELETE FROM recovery_codes WHERE account_id = ?', accountId);
	await database.run('DELETE FROM sign_in_steps WHERE account_id = ?', accountId);
	await database.run('DELETE FROM passkey_challenges WHERE account_id = ?', accountId);
	changed(accountId);
}

// ---------------------------------------------------------------------------
// TOTP

/**
 * Starts setting up a TOTP app: a new secret, held unconfirmed until the
 * first code from the app. Null where one is on already.
 */
export async function startTotp(account: Account): Promise<{ secret: string; uri: string } | null> {
	const database = await store();
	const existing = await database.get<{ confirmed: number }>('SELECT confirmed FROM totp WHERE account_id = ?', account.id);
	if (Number(existing?.confirmed ?? 0) === 1) return null;
	const secret = newTotpSecret();
	await database.run('DELETE FROM totp WHERE account_id = ? AND confirmed = 0', account.id);
	await database.run(
		'INSERT INTO totp (account_id, secret, confirmed, last_step, created_at) VALUES (?, ?, 0, NULL, ?)',
		account.id,
		sealJson(secret, 'totp'),
		now()
	);
	return { secret, uri: totpUri(secret, config().appName, account.username) };
}

/**
 * Turns the app on with its first code. Returns the recovery codes made with
 * it where the account had none, an empty list where it had, and null for a
 * wrong code or nothing being set up.
 */
export async function confirmTotp(accountId: string, code: string): Promise<string[] | null> {
	const database = await store();
	const row = await database.get<{ secret: string }>('SELECT secret FROM totp WHERE account_id = ? AND confirmed = 0', accountId);
	if (!row) return null;
	let secret: string;
	try {
		secret = openJson<string>(row.secret, 'totp');
	} catch {
		return null;
	}
	const step = matchingStep(secret, code.trim());
	if (step === null) return null;
	const result = await database.run(
		'UPDATE totp SET confirmed = 1, last_step = ? WHERE account_id = ? AND confirmed = 0',
		step,
		accountId
	);
	if (result.changes === 0) return null;
	changed(accountId);
	return (await factorsOf(accountId)).recoveryCodes > 0 ? [] : makeRecoveryCodes(accountId);
}

export async function removeTotp(accountId: string): Promise<void> {
	await (await store()).run('DELETE FROM totp WHERE account_id = ?', accountId);
	await dropCodesWithoutFactor(accountId);
	changed(accountId);
}

/**
 * Takes a TOTP code. The update is the check against replay: it sets the
 * step only past the last one taken, in one statement, so a code is taken
 * once however many requests carry it at the same moment.
 */
async function takeTotp(accountId: string, code: string): Promise<boolean> {
	const database = await store();
	const row = await database.get<{ secret: string }>('SELECT secret FROM totp WHERE account_id = ? AND confirmed = 1', accountId);
	if (!row) return false;
	let secret: string;
	try {
		secret = openJson<string>(row.secret, 'totp');
	} catch {
		// HEDDOHON_SECRET changed. The app cannot be used, and a recovery
		// code or an administrator's reset is the way back in.
		return false;
	}
	const step = matchingStep(secret, code);
	if (step === null) return false;
	const result = await database.run(
		'UPDATE totp SET last_step = ? WHERE account_id = ? AND confirmed = 1 AND (last_step IS NULL OR last_step < ?)',
		step,
		accountId,
		step
	);
	return result.changes === 1;
}

// ---------------------------------------------------------------------------
// Recovery codes

const RECOVERY_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
/** Ten characters of 32: 50 bits each, shown as two groups of five. */
const RECOVERY_LENGTH = 10;

function normalRecoveryCode(code: string): string | null {
	const plain = code.toLowerCase().replace(/[\s-]/g, '');
	if (plain.length !== RECOVERY_LENGTH) return null;
	for (const char of plain) if (!RECOVERY_ALPHABET.includes(char)) return null;
	return plain;
}

/** New recovery codes in place of the account's old ones, shown once. */
export async function makeRecoveryCodes(accountId: string): Promise<string[]> {
	const database = await store();
	const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () => {
		let code = '';
		for (let i = 0; i < RECOVERY_LENGTH; i++) code += RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)];
		return code;
	});
	await database.run('DELETE FROM recovery_codes WHERE account_id = ?', accountId);
	const created = now();
	for (const code of codes) {
		await database.run(
			'INSERT INTO recovery_codes (account_id, digest, created_at) VALUES (?, ?, ?)',
			accountId,
			recoveryDigest(accountId, code),
			created
		);
	}
	return codes.map((code) => `${code.slice(0, 5)}-${code.slice(5)}`);
}

/** Takes a recovery code: the delete is the check, so a code is taken once. */
async function takeRecoveryCode(accountId: string, code: string): Promise<boolean> {
	const plain = normalRecoveryCode(code);
	if (!plain) return false;
	const result = await (await store()).run(
		'DELETE FROM recovery_codes WHERE account_id = ? AND digest = ?',
		accountId,
		recoveryDigest(accountId, plain)
	);
	return result.changes === 1;
}

/** Recovery codes stand in for a factor, so they go when the last one does. */
async function dropCodesWithoutFactor(accountId: string): Promise<void> {
	if (!hasAny(await factorsOf(accountId))) {
		await (await store()).run('DELETE FROM recovery_codes WHERE account_id = ?', accountId);
	}
}

// ---------------------------------------------------------------------------
// Codes, counted

export type CodeVerdict =
	| { ok: true; kind: 'totp' | 'recovery'; recoveryLeft: number | null }
	| { ok: false; retryAfter: number | null };

/**
 * Takes a six-digit code from the app or a recovery code, counted against
 * the account's wrong factors before it is looked at.
 */
export async function takeCode(accountId: string, code: string, address: string): Promise<CodeVerdict> {
	const keys = secondFactorKeys(accountId);
	const verdict = await reserveLoginAttempt(keys);
	if (!verdict.allowed) {
		log.warn('second-factor-throttled', { account: accountId, address, retryAfter: verdict.retryAfter });
		return { ok: false, retryAfter: verdict.retryAfter };
	}
	const trimmed = code.trim().slice(0, 64);
	let kind: 'totp' | 'recovery' | null = null;
	if (/^\d{6}$/.test(trimmed.replace(/\s/g, ''))) {
		if (await takeTotp(accountId, trimmed.replace(/\s/g, ''))) kind = 'totp';
	} else if (await takeRecoveryCode(accountId, trimmed)) {
		kind = 'recovery';
	}
	if (!kind) {
		log.warn('second-factor-rejected', { account: accountId, address, method: 'code' });
		return { ok: false, retryAfter: null };
	}
	await clearSecondFactorFailures(accountId);
	if (kind === 'recovery') {
		const left = (await factorsOf(accountId)).recoveryCodes;
		log.warn('recovery-code-used', { account: accountId, address, left });
		return { ok: true, kind, recoveryLeft: left };
	}
	return { ok: true, kind, recoveryLeft: null };
}

// ---------------------------------------------------------------------------
// Passkeys

/**
 * Where passkeys can be used at all. A browser offers WebAuthn only in a
 * secure context and for a domain name: an `https` address, or `localhost`.
 * An address that is an IP, or plain http on a network, is neither.
 */
export function passkeysOffered(url: URL): boolean {
	const host = url.hostname;
	if (host === 'localhost') return true;
	if (url.protocol !== 'https:') return false;
	return !/^[\d.]+$/.test(host) && !host.startsWith('[');
}

type ChallengePurpose = 'register' | 'proof' | 'step' | 'sign-in';

async function newChallenge(purpose: ChallengePurpose, accountId: string | null, step: string | null): Promise<string> {
	const challenge = randomBytes(32).toString('base64url');
	const database = await store();
	const timestamp = now();
	await database.run('DELETE FROM passkey_challenges WHERE expires_at <= ?', timestamp);
	/*
	 * One live challenge for each held sign-in, and for each account and
	 * purpose: a new one replaces the last. Otherwise a signed-in session, or
	 * whoever has the password, could store challenges without limit for the
	 * five minutes each lasts. Anonymous sign-ins are bounded by
	 * `passkeyStartKeys` instead.
	 */
	if (step !== null) await database.run('DELETE FROM passkey_challenges WHERE step = ?', step);
	else if (accountId !== null) {
		await database.run('DELETE FROM passkey_challenges WHERE account_id = ? AND purpose = ?', accountId, purpose);
	}
	await database.run(
		'INSERT INTO passkey_challenges (digest, purpose, account_id, step, expires_at) VALUES (?, ?, ?, ?, ?)',
		passkeyChallengeDigest(challenge),
		purpose,
		accountId,
		step,
		timestamp + CHALLENGE_TTL_MS
	);
	return challenge;
}

/** Takes a challenge, once: the delete is the check. */
async function takeChallenge(challenge: string): Promise<{ purpose: string; account_id: string | null; step: string | null } | null> {
	const row = await (await store()).get<{ purpose: string; account_id: string | null; step: string | null }>(
		'DELETE FROM passkey_challenges WHERE digest = ? AND expires_at > ? RETURNING purpose, account_id, step',
		passkeyChallengeDigest(challenge),
		now()
	);
	return row ?? null;
}

/** The user handle a passkey is made with: the account's id, which names nobody. */
function userHandleOf(accountId: string): string {
	return toBase64url(Buffer.from(accountId, 'utf8'));
}

export async function listPasskeys(accountId: string): Promise<PasskeySummary[]> {
	const rows = await (await store()).all<{ id: string; name: string; created_at: number; last_used_at: number | null }>(
		'SELECT id, name, created_at, last_used_at FROM passkeys WHERE account_id = ? ORDER BY created_at',
		accountId
	);
	return rows.map((row) => ({
		id: row.id,
		name: row.name,
		createdAt: Number(row.created_at),
		lastUsedAt: row.last_used_at === null ? null : Number(row.last_used_at)
	}));
}

/** What `navigator.credentials.create()` is called with, binary fields in base64url. */
export async function passkeyCreationOptions(event: StepContext, account: Account) {
	const existing = await listPasskeys(account.id);
	return {
		challenge: await newChallenge('register', account.id, null),
		rp: { id: event.url.hostname, name: config().appName },
		user: { id: userHandleOf(account.id), name: account.username, displayName: account.username },
		pubKeyCredParams: ALGORITHMS.map((alg) => ({ type: 'public-key', alg })),
		timeout: CHALLENGE_TTL_MS,
		attestation: 'none',
		// Discoverable where the authenticator can, so it can sign in on its
		// own. A security key without room for one is still a second factor.
		authenticatorSelection: { residentKey: 'preferred', requireResidentKey: false, userVerification: 'preferred' },
		excludeCredentials: existing.map((key) => ({ type: 'public-key', id: key.id }))
	};
}

export type PasskeyAdded = { ok: true; passkey: PasskeySummary; recoveryCodes: string[] } | { ok: false; message: string };

/** Stores a passkey `navigator.credentials.create()` made for the account. */
export async function addPasskey(event: StepContext, account: Account, response: unknown, name: string): Promise<PasskeyAdded> {
	let made;
	try {
		made = readRegistration(response, event.url.origin, event.url.hostname);
	} catch (err) {
		log.warn('passkey-rejected', { account: account.id, step: 'register', detail: err instanceof WebAuthnError ? err.message : 'unreadable' });
		return { ok: false, message: 'The passkey could not be read. Try again.' };
	}
	const challenge = await takeChallenge(made.challenge);
	if (!challenge || challenge.purpose !== 'register' || challenge.account_id !== account.id) {
		return { ok: false, message: 'That request expired. Try again.' };
	}
	const database = await store();
	const count = await database.get<{ count: number }>('SELECT COUNT(*) AS count FROM passkeys WHERE account_id = ?', account.id);
	if (Number(count?.count ?? 0) >= MAX_PASSKEYS) {
		return { ok: false, message: `An account holds at most ${MAX_PASSKEYS} passkeys. Remove one to add another.` };
	}
	const hadFactor = hasAny(await factorsOf(account.id));
	const created = now();
	const label = name.trim().slice(0, MAX_PASSKEY_NAME) || 'Passkey';
	// The id is the primary key: a passkey already on any account is refused.
	const result = await database.run(
		`INSERT INTO passkeys (id, account_id, public_key, algorithm, sign_count, name, created_at, last_used_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, NULL) ON CONFLICT (id) DO NOTHING`,
		made.credentialId,
		account.id,
		made.publicKey,
		made.algorithm,
		made.signCount,
		label,
		created
	);
	if (result.changes === 0) return { ok: false, message: 'That passkey is already in use.' };
	changed(account.id);
	log.info('passkey-added', { account: account.id });
	const recoveryCodes = hadFactor || (await factorsOf(account.id)).recoveryCodes > 0 ? [] : await makeRecoveryCodes(account.id);
	return { ok: true, passkey: { id: made.credentialId, name: label, createdAt: created, lastUsedAt: null }, recoveryCodes };
}

export async function renamePasskey(accountId: string, id: string, name: string): Promise<boolean> {
	const label = name.trim().slice(0, MAX_PASSKEY_NAME);
	if (!label) return false;
	const result = await (await store()).run('UPDATE passkeys SET name = ? WHERE id = ? AND account_id = ?', label, id, accountId);
	return result.changes === 1;
}

export async function removePasskey(accountId: string, id: string): Promise<boolean> {
	const result = await (await store()).run('DELETE FROM passkeys WHERE id = ? AND account_id = ?', id, accountId);
	if (result.changes === 0) return false;
	await dropCodesWithoutFactor(accountId);
	changed(accountId);
	log.info('passkey-removed', { account: accountId });
	return true;
}

/**
 * What `navigator.credentials.get()` is called with. For an account (a proof,
 * a second step), the account's passkeys are named; for a sign-in with a
 * passkey alone, none are, and the browser offers whichever it holds for
 * this site, with the user verified.
 */
async function requestOptions(event: StepContext, purpose: ChallengePurpose, accountId: string | null, step: string | null) {
	const allow = accountId ? await listPasskeys(accountId) : [];
	return {
		challenge: await newChallenge(purpose, accountId, step),
		rpId: event.url.hostname,
		timeout: CHALLENGE_TTL_MS,
		userVerification: purpose === 'sign-in' ? 'required' : 'preferred',
		allowCredentials: allow.map((key) => ({ type: 'public-key', id: key.id }))
	};
}

export function proofOptions(event: StepContext, accountId: string) {
	return requestOptions(event, 'proof', accountId, null);
}

/**
 * Checks an assertion against the challenge it answers and the passkey it
 * names. Returns the passkey's account, or null; the reason is logged.
 */
async function takeAssertion(
	event: StepContext,
	response: unknown,
	expect: { purpose: ChallengePurpose; accountId?: string; step?: string }
): Promise<string | null> {
	const fail = (detail: string) => {
		log.warn('passkey-rejected', { account: expect.accountId ?? null, step: expect.purpose, detail });
		return null;
	};
	let assertion;
	try {
		assertion = readAssertion(response, event.url.origin);
	} catch (err) {
		return fail(err instanceof WebAuthnError ? err.message : 'unreadable');
	}
	const challenge = await takeChallenge(assertion.challenge);
	if (!challenge || challenge.purpose !== expect.purpose) return fail('challenge');
	if (expect.accountId !== undefined && challenge.account_id !== expect.accountId) return fail('challenge account');
	if (expect.step !== undefined && (challenge.step === null || !constantTimeEquals(challenge.step, expect.step))) {
		return fail('challenge sign-in');
	}

	const database = await store();
	const key = await database.get<{ account_id: string; public_key: string; algorithm: number; sign_count: number }>(
		'SELECT account_id, public_key, algorithm, sign_count FROM passkeys WHERE id = ?',
		assertion.credentialId
	);
	if (!key) return fail('unknown passkey');
	if (expect.accountId !== undefined && key.account_id !== expect.accountId) return fail('passkey of another account');
	if (assertion.userHandle !== null && assertion.userHandle !== userHandleOf(key.account_id)) return fail('user handle');

	let checked;
	try {
		checked = verifyAssertion(assertion, { publicKey: key.public_key, algorithm: Number(key.algorithm) }, event.url.hostname);
	} catch (err) {
		return fail(err instanceof WebAuthnError ? err.message : 'signature');
	}
	if (expect.purpose === 'sign-in' && !checked.userVerified) return fail('user not verified');

	/*
	 * A counter that does not move forward is the sign of a copied key
	 * (WebAuthn section 6.1.1). Synced passkeys send 0 every time, and 0 on
	 * both sides is no signal.
	 */
	const stored = Number(key.sign_count);
	if ((checked.signCount !== 0 || stored !== 0) && checked.signCount <= stored) return fail('signature counter went back');
	await database.run(
		'UPDATE passkeys SET sign_count = ?, last_used_at = ? WHERE id = ?',
		checked.signCount,
		now(),
		assertion.credentialId
	);
	return key.account_id;
}

// ---------------------------------------------------------------------------
// Proofs for a change

export interface Proof {
	password?: unknown;
	code?: unknown;
	passkey?: unknown;
}

export type ProofVerdict = { ok: true } | { ok: false; status: number; message: string };

/**
 * Checks that the person at a signed-in session is the account's holder,
 * before a change to its factors. Where the account has a factor, one of its
 * factors: a code or a passkey. Where it has none, its music server password,
 * counted as a sign-in is, so that a session left open is not enough to put a
 * factor on an account and lock its holder out.
 */
export async function checkProof(
	event: StepContext & { getClientAddress(): string; request: Request },
	session: AuthenticatedSession,
	proof: Proof | null
): Promise<ProofVerdict> {
	const accountId = session.account.id;
	const address = event.getClientAddress();
	if (hasAny(await factorsOf(accountId))) {
		if (typeof proof?.code === 'string' && proof.code.trim() !== '') {
			const verdict = await takeCode(accountId, proof.code, address);
			if (verdict.ok) return { ok: true };
			return verdict.retryAfter !== null
				? { ok: false, status: 429, message: `Too many wrong codes. Try again in ${Math.ceil(verdict.retryAfter / 60)} minutes.` }
				: { ok: false, status: 403, message: 'That code was not right.' };
		}
		if (proof?.passkey !== undefined && proof.passkey !== null) {
			const keys = secondFactorKeys(accountId);
			const verdict = await reserveLoginAttempt(keys);
			if (!verdict.allowed) return { ok: false, status: 429, message: 'Too many attempts. Try again later.' };
			if ((await takeAssertion(event, proof.passkey, { purpose: 'proof', accountId })) === accountId) {
				await clearSecondFactorFailures(accountId);
				return { ok: true };
			}
			return { ok: false, status: 403, message: 'That passkey was not accepted.' };
		}
		return { ok: false, status: 403, message: 'Confirm with a code from your app, a recovery code or a passkey.' };
	}

	if (typeof proof?.password !== 'string' || proof.password === '' || proof.password.length > 1024) {
		return { ok: false, status: 403, message: 'Confirm with your password.' };
	}
	const { backend, username } = session.account;
	const keys = loginKeys(backend, username, visitorAddress(event));
	const verdict = await reserveLoginAttempt(keys);
	if (!verdict.allowed) return { ok: false, status: 429, message: 'Too many attempts. Try again later.' };
	try {
		await backendFor(backend).login(username, proof.password);
	} catch (err) {
		if (err instanceof UpstreamError && err.kind === 'auth') {
			log.warn('second-factor-rejected', { account: accountId, address, method: 'password' });
			return { ok: false, status: 403, message: 'That password was not accepted.' };
		}
		await refundLoginAttempt(keys);
		return { ok: false, status: 502, message: 'The music server could not check the password. Try again shortly.' };
	}
	await clearLoginFailures(keys);
	return { ok: true };
}

/**
 * After a factor is added, or the last one taken away: every other session
 * of the account ends, the ones signed in after this one too. The proof
 * checked before the change is what lets this one end the newer ones, which
 * `endSessions` otherwise leaves to their own browsers.
 */
export async function afterFactorChange(session: AuthenticatedSession): Promise<number> {
	return endSessions(session, 'others', { newer: true });
}

// ---------------------------------------------------------------------------
// The second step of a sign-in

function stepCookieName(url: URL): string {
	return cookieSecure(url) ? `__Host-${STEP_COOKIE}` : STEP_COOKIE;
}

interface HeldSignIn {
	kind: BackendKind;
	upstream: UpstreamSignIn;
	method: 'password' | 'quick-connect' | 'oidc';
}

export interface StepMethods {
	totp: boolean;
	passkey: boolean;
}

/**
 * Holds a sign-in the music server accepted, where the account it reaches has
 * a factor, and writes the cookie that names it. Null where there is no
 * factor to ask for: the caller stores the account and signs in at once.
 */
export async function beginStep(
	event: StepContext,
	kind: BackendKind,
	accountId: string | null,
	upstream: UpstreamSignIn,
	method: HeldSignIn['method']
): Promise<StepMethods | null> {
	if (!accountId) return null;
	const factors = await factorsOf(accountId);
	if (!hasAny(factors)) return null;
	const token = randomToken();
	const timestamp = now();
	const database = await store();
	await database.run('DELETE FROM sign_in_steps WHERE expires_at <= ?', timestamp);
	// One held sign-in a browser: a second password sign-in replaces the first.
	await dropStep(event);
	await database.run(
		'INSERT INTO sign_in_steps (token_digest, account_id, upstream, created_at, expires_at, attempts) VALUES (?, ?, ?, ?, ?, 0)',
		signInStepDigest(token),
		accountId,
		sealJson({ kind, upstream, method } satisfies HeldSignIn, 'sign-in-step'),
		timestamp,
		timestamp + STEP_TTL_MS
	);
	// At most this many held sign-ins an account, the newest kept: a correct
	// password clears the sign-in throttle, so whoever has it could otherwise
	// hold sign-ins without limit for five minutes at a time.
	await database.run(
		`DELETE FROM sign_in_steps WHERE account_id = ? AND token_digest NOT IN (
		   SELECT token_digest FROM sign_in_steps WHERE account_id = ? ORDER BY created_at DESC LIMIT ${MAX_STEPS_PER_ACCOUNT}
		 )`,
		accountId,
		accountId
	);
	const secure = cookieSecure(event.url);
	event.cookies.set(stepCookieName(event.url), token, {
		path: '/',
		httpOnly: true,
		sameSite: 'strict',
		secure,
		maxAge: Math.floor(STEP_TTL_MS / 1000)
	});
	return { totp: factors.totp, passkey: factors.passkeys > 0 && passkeysOffered(event.url) };
}

interface Step {
	digest: string;
	accountId: string;
	held: HeldSignIn;
}

/** The sign-in this browser holds, if it has not expired. */
export async function currentStep(event: StepContext): Promise<Step | null> {
	const token = event.cookies.get(stepCookieName(event.url));
	if (!token || token.length > 128) return null;
	const digest = signInStepDigest(token);
	const row = await (await store()).get<{ account_id: string; upstream: string }>(
		'SELECT account_id, upstream FROM sign_in_steps WHERE token_digest = ? AND expires_at > ?',
		digest,
		now()
	);
	if (!row) return null;
	try {
		return { digest, accountId: row.account_id, held: openJson<HeldSignIn>(row.upstream, 'sign-in-step') };
	} catch {
		return null;
	}
}

export async function stepMethods(event: StepContext, step: Step): Promise<StepMethods> {
	const factors = await factorsOf(step.accountId);
	return { totp: factors.totp, passkey: factors.passkeys > 0 && passkeysOffered(event.url) };
}

export async function dropStep(event: StepContext): Promise<void> {
	const name = stepCookieName(event.url);
	const token = event.cookies.get(name);
	if (token && token.length <= 128) {
		await (await store()).run('DELETE FROM sign_in_steps WHERE token_digest = ?', signInStepDigest(token));
	}
	event.cookies.delete(name, { path: '/', secure: cookieSecure(event.url) });
}

/**
 * Counts one factor sent for the held sign-in. False once it has had its
 * five, and the sign-in is dropped: the password is asked for again.
 */
async function countStepAttempt(step: Step): Promise<boolean> {
	const row = await (await store()).get<{ attempts: number }>(
		'UPDATE sign_in_steps SET attempts = attempts + 1 WHERE token_digest = ? RETURNING attempts',
		step.digest
	);
	if (!row || Number(row.attempts) > STEP_MAX_ATTEMPTS) {
		await (await store()).run('DELETE FROM sign_in_steps WHERE token_digest = ?', step.digest);
		return false;
	}
	return true;
}

export type StepOutcome =
	| { ok: true; account: Account; method: HeldSignIn['method']; recoveryLeft: number | null }
	| { ok: false; status: number; message: string; restart: boolean };

/** Finishes the held sign-in with a code, and stores the account. */
export async function finishStepWithCode(event: StepContext & { getClientAddress(): string }, code: string): Promise<StepOutcome> {
	const step = await currentStep(event);
	if (!step) return { ok: false, status: 400, message: 'That sign-in expired. Sign in again.', restart: true };
	if (!(await countStepAttempt(step))) {
		await dropStep(event);
		return { ok: false, status: 429, message: 'Too many wrong codes. Sign in again.', restart: true };
	}
	const verdict = await takeCode(step.accountId, code, event.getClientAddress());
	if (!verdict.ok) {
		return verdict.retryAfter !== null
			? {
					ok: false,
					status: 429,
					message: `Too many wrong codes for this account. Try again in ${Math.ceil(verdict.retryAfter / 60)} minutes.`,
					restart: false
				}
			: { ok: false, status: 401, message: 'That code was not right.', restart: false };
	}
	return finishStep(event, step, verdict.recoveryLeft);
}

export async function stepPasskeyOptions(event: StepContext) {
	const step = await currentStep(event);
	if (!step) return null;
	return requestOptions(event, 'step', step.accountId, step.digest);
}

/** Finishes the held sign-in with a passkey, and stores the account. */
export async function finishStepWithPasskey(event: StepContext & { getClientAddress(): string }, response: unknown): Promise<StepOutcome> {
	const step = await currentStep(event);
	if (!step) return { ok: false, status: 400, message: 'That sign-in expired. Sign in again.', restart: true };
	if (!(await countStepAttempt(step))) {
		await dropStep(event);
		return { ok: false, status: 429, message: 'Too many attempts. Sign in again.', restart: true };
	}
	const keys = secondFactorKeys(step.accountId);
	const verdict = await reserveLoginAttempt(keys);
	if (!verdict.allowed) {
		return { ok: false, status: 429, message: 'Too many attempts for this account. Try again later.', restart: false };
	}
	if ((await takeAssertion(event, response, { purpose: 'step', accountId: step.accountId, step: step.digest })) !== step.accountId) {
		return { ok: false, status: 401, message: 'That passkey was not accepted.', restart: false };
	}
	await clearSecondFactorFailures(step.accountId);
	return finishStep(event, step, null);
}

async function finishStep(event: StepContext, step: Step, recoveryLeft: number | null): Promise<StepOutcome> {
	// Taken before the account is stored, so the sign-in completes once.
	const taken = await (await store()).run('DELETE FROM sign_in_steps WHERE token_digest = ?', step.digest);
	event.cookies.delete(stepCookieName(event.url), { path: '/', secure: cookieSecure(event.url) });
	if (taken.changes === 0) return { ok: false, status: 400, message: 'That sign-in expired. Sign in again.', restart: true };
	const account = await storeAccount(step.held.kind, step.held.upstream.credential, step.held.upstream.remoteUserId);
	return { ok: true, account, method: step.held.method, recoveryLeft };
}

// ---------------------------------------------------------------------------
// Signing in with a passkey alone

export function signInOptions(event: StepContext) {
	return requestOptions(event, 'sign-in', null, null);
}

export type PasskeySignIn = { ok: true; account: Account } | { ok: false; status: number; message: string };

/**
 * Signs in with a passkey, the user verified by the authenticator, through
 * the credential stored at the account's last sign-in. The music server is
 * asked first whether it still takes that credential.
 */
export async function signInWithPasskey(event: StepContext, response: unknown): Promise<PasskeySignIn> {
	const accountId = await takeAssertion(event, response, { purpose: 'sign-in' });
	if (!accountId) return { ok: false, status: 401, message: 'That passkey was not accepted.' };
	const found = await accountById(accountId);
	if (!found || !config().upstreams.some((upstream) => upstream.kind === found.account.backend)) {
		return { ok: false, status: 401, message: 'Sign in with your password.' };
	}
	try {
		await backendFor(found.account.backend).checkCredential(found.credential);
	} catch (err) {
		if (err instanceof UpstreamError && err.kind === 'auth') {
			log.warn('passkey-credential-stale', { account: accountId });
			return { ok: false, status: 401, message: 'Your music server password has changed since. Sign in with it once, and the passkey works again.' };
		}
		return { ok: false, status: 502, message: 'The music server could not complete the sign-in. Try again shortly.' };
	}
	return { ok: true, account: found.account };
}
