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

/**
 * The name used wherever the cookie is `Secure`.
 *
 * Host-only is not enough on its own. A sibling origin on the same registrable
 * domain (`jellyfin.example.com` next to `music.example.com`) can write
 * `heddohon_session` with `Domain=.example.com`. Both then arrive in one
 * `Cookie` header, and the parser in `cookie@0.6.0` keeps the first occurrence,
 * which is ordered by creation time and so is the planted one. Signing in
 * overwrites the host-only cookie, a different cookie, so the plant keeps
 * winning and `destroySession` cannot clear it either.
 *
 * `__Host-` closes that: the browser refuses to set such a cookie with a
 * `Domain`, so nothing but this exact host can write one. The prefix requires
 * `Secure`, which is why the bare name is still used where the cookie is not.
 */
export const SESSION_COOKIE_HOST = `__Host-${SESSION_COOKIE}`;

/** What the cookie helpers need from a request. */
export interface CookieContext {
	cookies: Cookies;
	url: URL;
}

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
	const { credential, remoteUserId } = await backendFor(kind).login(username, password);
	return storeAccount(kind, credential, remoteUserId);
}

/**
 * Completes a Quick Connect sign-in the user has approved upstream. The result
 * is stored exactly as a password sign-in's is.
 */
export async function signInWithQuickConnect(
	kind: BackendKind,
	secret: string,
	deviceId: string
): Promise<Account> {
	const quickConnect = backendFor(kind).quickConnect;
	if (!quickConnect) throw new Error(`The ${kind} backend has no Quick Connect`);
	const { credential, remoteUserId } = await quickConnect.authenticate(secret, deviceId);
	return storeAccount(kind, credential, remoteUserId);
}

function storeAccount(
	kind: BackendKind,
	credential: StoredCredential,
	remoteUserId: string | null
): Account {
	const database = db();
	const timestamp = now();
	const sealed = sealJson(credential);

	/*
	 * NOCASE, because Navidrome and Jellyfin both accept a username in any case.
	 * A case-sensitive match gave `Alice` and `alice` two account rows for one
	 * person, and with them two sets of settings, two saved queues and two
	 * playback positions, which reads as the app losing state at random.
	 *
	 * Ordered so that repeated sign-ins keep landing on the same row where a
	 * database written before this already holds both.
	 */
	const existing = database
		.prepare<[string, string], AccountRow>(
			'SELECT * FROM accounts WHERE backend = ? AND username = ? COLLATE NOCASE ORDER BY created_at LIMIT 1'
		)
		.get(kind, credential.username);

	if (existing) {
		// The stored username follows the latest sign-in. It is the spelling the
		// upstream accepted, and for Subsonic it is sent back in the query string
		// of every request, so it has to match what was authenticated.
		database
			.prepare(
				'UPDATE accounts SET username = ?, credential = ?, remote_user_id = ?, last_login_at = ? WHERE id = ?'
			)
			.run(credential.username, sealed, remoteUserId, timestamp, existing.id);
		return toAccount({
			...existing,
			username: credential.username,
			remote_user_id: remoteUserId,
			last_login_at: timestamp
		});
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
export function createSession(
	event: CookieContext,
	account: Account,
	clientHint: string | null
): string {
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

	const secure = cookieSecure(event.url);
	event.cookies.set(secure ? SESSION_COOKIE_HOST : SESSION_COOKIE, token, {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		secure,
		// The cookie dies with the session record; the server-side expiry is the
		// one that actually matters, this just avoids sending a dead cookie.
		maxAge: Math.floor(maxAgeMs / 1000)
	});

	// A session issued under the bare name before this deployment became Secure
	// would otherwise sit alongside the new one and be the value a downgrade
	// reads. Clearing it costs nothing when it is not there.
	if (secure) event.cookies.delete(SESSION_COOKIE, { path: '/' });

	pruneExpiredSessions();
	return token;
}

/**
 * Whether to mark the session cookie `Secure`, and with it which name the
 * cookie carries.
 *
 * 'auto' used to read `process.env.ORIGIN`, on the reasoning that CSRF had
 * already forced the operator to set it correctly. adapter-node disproves that.
 * With ORIGIN unset it derives the origin from the Host header and defaults the
 * scheme to 'https' (`get_origin` in the bundled handler), so an https
 * deployment behind Caddy or nginx passes its own CSRF check with ORIGIN unset
 * while this function saw nothing and returned false. The cookie then went out
 * without `Secure`, and one plain-http request to the public hostname, which any
 * page on the internet can provoke with an <img>, put the token on the wire in
 * clear.
 *
 * The request's own scheme is the signal that cannot be missing, so that is what
 * is read first. It is not the only one: `NODE_ENV=production` also turns
 * `Secure` on, whatever the scheme, and the Docker image sets it. A plain-http
 * deployment of the image therefore needs HEDDOHON_COOKIE_SECURE=false, or the
 * browser refuses the cookie and sign-in does not stick. The same adapter-node default is why this cannot break a working
 * plain-http deployment that leaves ORIGIN unset: there `url.protocol` is https
 * and the browser's Origin header is http, the cross-origin check in
 * hooks.server.ts rejects the mismatch, and sign-in already does not work.
 *
 * Loopback over plain http stays exempt outside production so that `vite dev`
 * on the machine itself keeps working, where `Secure` would stop the browser
 * returning the cookie at all.
 */
export function cookieSecure(url: URL): boolean {
	const setting = config().cookieSecure;
	if (setting !== 'auto') return setting;
	if (url.protocol === 'https:') return true;
	if (process.env.NODE_ENV === 'production') return true;

	const host = url.hostname;
	return !(host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]');
}

/**
 * Resolves a request cookie to a live session, opening the stored credential.
 * Returns null for anything expired, unknown or undecryptable.
 */
export function resolveSession(event: CookieContext): AuthenticatedSession | null {
	// Exactly one name is read, the one this deployment issues. Falling back to
	// the bare name on a Secure deployment would re-open the shadowing described
	// on SESSION_COOKIE_HOST: an unauthenticated visitor carrying a planted
	// `heddohon_session` would be resolved into the session that planted it.
	// The cost is that sessions issued before this change are not honoured, so
	// upgrading signs everybody out once.
	const token = event.cookies.get(
		cookieSecure(event.url) ? SESSION_COOKIE_HOST : SESSION_COOKIE
	);
	if (!token) return null;

	const row = db()
		.prepare<[string], { account_id: string; expires_at: number }>(
			'SELECT account_id, expires_at FROM sessions WHERE token_digest = ?'
		)
		.get(tokenDigest(token));

	if (!row) return null;

	if (row.expires_at <= now()) {
		destroySession(event);
		return null;
	}

	const account = db()
		.prepare<[string], AccountRow>('SELECT * FROM accounts WHERE id = ?')
		.get(row.account_id);
	if (!account) {
		destroySession(event);
		return null;
	}

	let credential: StoredCredential;
	try {
		credential = openJson<StoredCredential>(account.credential);
	} catch {
		// The secret changed, or the row was tampered with. Either way this
		// session can no longer be honoured.
		destroySession(event);
		return null;
	}

	// `last_seen_at` is observability only. It deliberately does not extend
	// `expires_at`: the 72-hour ceiling is absolute, not idle-based.
	db().prepare('UPDATE sessions SET last_seen_at = ? WHERE token_digest = ?').run(now(), tokenDigest(token));

	return { account: toAccount(account), expiresAt: row.expires_at, credential };
}

export function destroySession(event: CookieContext): void {
	// Both names, so that signing out of a deployment that has changed scheme
	// since the cookie was issued still clears the row and the cookie.
	for (const name of [SESSION_COOKIE_HOST, SESSION_COOKIE]) {
		const token = event.cookies.get(name);
		if (token) {
			db().prepare('DELETE FROM sessions WHERE token_digest = ?').run(tokenDigest(token));
		}
		event.cookies.delete(name, { path: '/' });
	}
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
