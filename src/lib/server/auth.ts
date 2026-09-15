/**
 * Account and session lifecycle.
 *
 * Two rules drive the shape of this module:
 *  1. Heddohon never holds a password of its own. Every sign-in is a live call
 *     to the configured Navidrome/Jellyfin server; if the upstream says no,
 *     there is no local fallback that could say yes.
 *  2. A session is an opaque random token. The database stores only its HMAC
 *     digest and an absolute expiry that is never extended past 72 hours.
 */
import { randomUUID } from 'node:crypto';
import type { Cookies } from '@sveltejs/kit';
import type { BackendKind } from '$lib/types';
import { config } from './config';
import { openJson, pseudonym, randomToken, sealJson, tokenDigest } from './crypto';
import { db, now, type AccountRow } from './db';
import { backendFor, type StoredCredential } from './backends';
import { log } from './log';

export const SESSION_COOKIE = 'heddohon_session';

export interface Account {
	id: string;
	backend: BackendKind;
	username: string;
	remoteUserId: string | null;
}

export interface AuthenticatedSession {
	account: Account;
	/** Epoch millis. Absolute, never extended. */
	expiresAt: number;
	credential: StoredCredential;
}

function toAccount(row: AccountRow): Account {
	return {
		id: row.id,
		backend: row.backend as BackendKind,
		username: row.username,
		remoteUserId: row.remote_user_id
	};
}

/**
 * Authenticates against the upstream server and, on success, upserts the local
 * account record with a freshly sealed credential.
 */
export async function signIn(
	kind: BackendKind,
	username: string,
	password: string
): Promise<Account> {
	const backend = backendFor(kind);
	const { credential, remoteUserId } = await backend.login(username, password);

	const database = db();
	const timestamp = now();
	const sealed = sealJson(credential);

	const existing = database
		.prepare<[string, string], AccountRow>(
			'SELECT * FROM accounts WHERE backend = ? AND username = ?'
		)
		.get(kind, credential.username);

	if (existing) {
		database
			.prepare('UPDATE accounts SET credential = ?, remote_user_id = ?, last_login_at = ? WHERE id = ?')
			.run(sealed, remoteUserId, timestamp, existing.id);
		return toAccount({ ...existing, remote_user_id: remoteUserId, last_login_at: timestamp });
	}

	const id = randomUUID();
	database
		.prepare(
			`INSERT INTO accounts (id, backend, username, remote_user_id, credential, created_at, last_login_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`
		)
		.run(id, kind, credential.username, remoteUserId, sealed, timestamp, timestamp);

	return { id, backend: kind, username: credential.username, remoteUserId };
}

/** Issues a session token and writes the cookie. Returns the raw token. */
export function createSession(cookies: Cookies, account: Account, clientHint: string | null): string {
	const token = randomToken();
	const created = now();
	const maxAgeMs = config().sessionMaxHours * 60 * 60 * 1000;
	const expiresAt = created + maxAgeMs;

	db()
		.prepare(
			`INSERT INTO sessions (token_digest, account_id, created_at, expires_at, last_seen_at, client_pseudonym)
			 VALUES (?, ?, ?, ?, ?, ?)`
		)
		.run(
			tokenDigest(token),
			account.id,
			created,
			expiresAt,
			created,
			clientHint ? pseudonym(clientHint) : null
		);

	cookies.set(SESSION_COOKIE, token, {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		secure: cookieSecure(),
		// The cookie dies with the session record; the server-side expiry is the
		// one that actually matters, this just avoids sending a dead cookie.
		maxAge: Math.floor(maxAgeMs / 1000)
	});

	pruneExpiredSessions();
	return token;
}

/**
 * Whether to mark the session cookie `Secure`.
 *
 * 'auto' used to mean `NODE_ENV === 'production'`. The shipped Dockerfile sets
 * that, so the image was fine — but every other way of running this (npm start,
 * a systemd unit, most PaaS runners) leaves NODE_ENV unset, and there the cookie
 * went out without `Secure` behind a perfectly good TLS proxy. One plain-http
 * request to the public hostname, which any page on the internet can provoke
 * with an <img>, then puts the session token on the wire in clear.
 *
 * So 'auto' now asks the deployment where it actually lives. ORIGIN is the URL
 * the operator has already had to set correctly for CSRF to work at all — if it
 * says https, the cookie is Secure regardless of how the process was started.
 * Loopback stays exempt so that `npm run dev` still works.
 */
function cookieSecure(): boolean {
	const setting = config().cookieSecure;
	if (setting !== 'auto') return setting;
	if (process.env.NODE_ENV === 'production') return true;

	const origin = process.env.ORIGIN;
	if (origin) {
		try {
			const url = new URL(origin);
			if (url.protocol === 'https:') return true;
			const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
			return !local;
		} catch {
			// A malformed ORIGIN is the operator's problem, but it is not a reason
			// to hand out a cookie with fewer protections than usual.
			return true;
		}
	}
	return false;
}

/**
 * Resolves a request cookie to a live session, opening the stored credential.
 * Returns null for anything expired, unknown or undecryptable.
 */
export function resolveSession(cookies: Cookies): AuthenticatedSession | null {
	const token = cookies.get(SESSION_COOKIE);
	if (!token) return null;

	const row = db()
		.prepare<[string], { account_id: string; expires_at: number }>(
			'SELECT account_id, expires_at FROM sessions WHERE token_digest = ?'
		)
		.get(tokenDigest(token));

	if (!row) return null;

	if (row.expires_at <= now()) {
		destroySession(cookies);
		return null;
	}

	const account = db()
		.prepare<[string], AccountRow>('SELECT * FROM accounts WHERE id = ?')
		.get(row.account_id);
	if (!account) {
		destroySession(cookies);
		return null;
	}

	let credential: StoredCredential;
	try {
		credential = openJson<StoredCredential>(account.credential);
	} catch {
		// The secret changed, or the row was tampered with. Either way this
		// session can no longer be honoured.
		destroySession(cookies);
		return null;
	}

	// `last_seen_at` is observability only. It deliberately does not extend
	// `expires_at`: the 72-hour ceiling is absolute, not idle-based.
	db().prepare('UPDATE sessions SET last_seen_at = ? WHERE token_digest = ?').run(now(), tokenDigest(token));

	return { account: toAccount(account), expiresAt: row.expires_at, credential };
}

export function destroySession(cookies: Cookies): void {
	const token = cookies.get(SESSION_COOKIE);
	if (token) {
		db().prepare('DELETE FROM sessions WHERE token_digest = ?').run(tokenDigest(token));
	}
	cookies.delete(SESSION_COOKIE, { path: '/' });
}

/** Signs the account out everywhere — used when the upstream rejects the stored credential. */
export function destroyAllSessions(accountId: string): void {
	const result = db().prepare('DELETE FROM sessions WHERE account_id = ?').run(accountId);
	// The account was signed in and now is not, without anybody asking for that.
	// It means the password changed upstream, or the token was revoked there, and
	// it is the explanation for "it logged me out on its own".
	log.warn('sessions-destroyed', { account: accountId, sessions: result.changes });
}

let lastPrune = 0;

function pruneExpiredSessions(): void {
	// Cheap enough to do opportunistically, but not on every request.
	const timestamp = now();
	if (timestamp - lastPrune < 60_000) return;
	lastPrune = timestamp;
	db().prepare('DELETE FROM sessions WHERE expires_at <= ?').run(timestamp);
}

export function activeSessionCount(accountId: string): number {
	const row = db()
		.prepare<[string, number], { count: number }>(
			'SELECT COUNT(*) AS count FROM sessions WHERE account_id = ? AND expires_at > ?'
		)
		.get(accountId, now());
	return row?.count ?? 0;
}
