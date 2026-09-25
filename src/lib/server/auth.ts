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
import { randomBytes } from 'node:crypto';
import {
	constantTimeEquals,
	deviceDigest,
	openJson,
	pseudonym,
	randomToken,
	sealJson,
	tokenDigest
} from './crypto';
import { now, store, type AccountRow } from './db';
import { backendFor, type StoredCredential } from './backends';
import { log } from './log';
import { forgetListings } from './listings';
import { forgetTranscodes } from './transcodes';
import { clearAccountState } from './settings';
import { revokeAllShares } from './shares';

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

async function storeAccount(
	kind: BackendKind,
	credential: StoredCredential,
	remoteUserId: string | null
): Promise<Account> {
	const database = await store();
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
	//
	// `lower()` on both sides rather than SQLite's `COLLATE NOCASE`, which
	// PostgreSQL does not have. Both fold ASCII only, as NOCASE did.
	const existing = await database.get<AccountRow>(
		'SELECT * FROM accounts WHERE backend = ? AND lower(username) = lower(?) ORDER BY created_at LIMIT 1',
		kind,
		credential.username
	);

	if (existing && isAnotherUser(kind, existing.remote_user_id, remoteUserId)) {
		/*
		 * The music server has a different user under this name: an account
		 * deleted and a new one created with the same name, or a rename that
		 * freed it. Keeping the row handed the new person's credential to the
		 * old person's sessions, which then read the new person's library for
		 * up to 72 hours, and played the old person's links through it.
		 * Everything tied to the old user goes before the credential changes,
		 * so no request can pair an old session with the new credential.
		 */
		await destroyAllSessions(existing.id);
		const links = await revokeAllShares(existing.id);
		await clearAccountState(existing.id);
		log.warn('account-user-replaced', { account: existing.id, backend: kind, links });
	} else if (existing && passwordChanged(existing.credential, credential)) {
		/*
		 * Subsonic reports no user id, so a name given to someone else cannot be
		 * told apart from its owner changing their password. Both end the row's
		 * sessions. Kept, the sessions of whoever held the old password went on
		 * working with the new one: a Navidrome name reused for another person
		 * handed that person's library to the previous holder for up to 72
		 * hours. The cost is that changing a password signs out the other
		 * devices, which is also what a password change is expected to do.
		 *
		 * Links, settings and the queue are kept, since the same person
		 * changing their password would lose them.
		 */
		await destroyAllSessions(existing.id);
		log.warn('account-password-changed', { account: existing.id, backend: kind });
	}

	if (existing) {
		// The stored username follows the latest sign-in. It is the spelling the
		// upstream accepted, and for Subsonic it is sent back in the query string
		// of every request, so it has to match what was authenticated.
		await database.run(
			'UPDATE accounts SET username = ?, credential = ?, remote_user_id = ?, last_login_at = ? WHERE id = ?',
			credential.username,
			sealed,
			remoteUserId,
			timestamp,
			existing.id
		);
		forgetAccount(existing.id);
		return toAccount({
			...existing,
			username: credential.username,
			remote_user_id: remoteUserId,
			last_login_at: timestamp
		});
	}

	const id = randomUUID();
	await database.run(
		`INSERT INTO accounts (id, backend, username, remote_user_id, credential, created_at, last_login_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		id,
		kind,
		credential.username,
		remoteUserId,
		sealed,
		timestamp,
		timestamp
	);

	return { id, backend: kind, username: credential.username, remoteUserId };
}

/**
 * Whether a sign-in under an existing row's name is a different upstream user.
 *
 * Jellyfin only. Its user id is a GUID that survives renames and is never
 * reused. The Subsonic adapter has no user id to compare, and stores the name
 * as typed in its place.
 */
function isAnotherUser(kind: BackendKind, stored: string | null, signedIn: string | null): boolean {
	if (kind !== 'jellyfin' || !stored || !signedIn) return false;
	return stored.toLowerCase() !== signedIn.toLowerCase();
}

/**
 * Whether a Subsonic sign-in stores a password other than the one held. A
 * stored credential that no longer opens counts as changed.
 */
function passwordChanged(stored: string, signedIn: StoredCredential): boolean {
	if (signedIn.kind !== 'subsonic') return false;
	let previous: StoredCredential;
	try {
		previous = openJson<StoredCredential>(stored);
	} catch {
		return true;
	}
	return previous.kind !== 'subsonic' || !constantTimeEquals(previous.password, signedIn.password);
}

/** Issues a session token and writes the cookie. Returns the raw token. */
export async function createSession(
	event: CookieContext,
	account: Account,
	clientHint: string | null
): Promise<string> {
	const token = randomToken();
	const created = now();
	const maxAgeMs = config().sessionMaxHours * 60 * 60 * 1000;
	const expiresAt = created + maxAgeMs;

	await (await store()).run(
		`INSERT INTO sessions (token_digest, account_id, created_at, expires_at, last_seen_at, client_pseudonym)
		 VALUES (?, ?, ?, ?, ?, ?)`,
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

	await pruneExpiredSessions();
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
export async function resolveSession(event: CookieContext): Promise<AuthenticatedSession | null> {
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

	const digest = tokenDigest(token);
	const database = await store();

	const cached = sessionCache.get(digest);
	let row: { account_id: string; expires_at: number; last_seen_at: number } | undefined;
	let account: AccountRow | undefined;
	if (cached && cached.until > now()) {
		({ row, account } = cached);
	} else {
		// Taken before the reads, so a sign-out that lands while they are out is
		// seen afterwards: the rows read may already be stale, and caching them
		// would honour the ended session for another five seconds.
		const epoch = sessionEpoch;
		row = await database.get('SELECT account_id, expires_at, last_seen_at FROM sessions WHERE token_digest = ?', digest);
		if (row) account = await database.get<AccountRow>('SELECT * FROM accounts WHERE id = ?', row.account_id);
		if (row && account && database.kind === 'postgres' && epoch === sessionEpoch) {
			sessionCache.set(digest, { row, account, until: now() + SESSION_CACHE_MS });
			if (sessionCache.size > SESSION_CACHE_MAX) sessionCache.delete(sessionCache.keys().next().value!);
		}
	}

	if (!row) return null;

	if (row.expires_at <= now()) {
		await destroySession(event);
		return null;
	}

	if (!account) {
		await destroySession(event);
		return null;
	}

	let credential: StoredCredential;
	try {
		credential = openJson<StoredCredential>(account.credential);
	} catch {
		// The secret changed, or the row was tampered with. Either way this
		// session can no longer be honoured.
		await destroySession(event);
		return null;
	}

	// `last_seen_at` is observability only. It deliberately does not extend
	// `expires_at`: the 72-hour ceiling is absolute, not idle-based.
	//
	// Written at most once a minute per session. It was written on every
	// request, and a library page opens dozens of covers, each of which came
	// through here: a database write per image, serialised behind SQLite's one
	// writer, to record a time nobody reads to the second.
	const seen = now();
	if (seen - row.last_seen_at >= LAST_SEEN_RESOLUTION_MS) {
		row.last_seen_at = seen;
		await database.run('UPDATE sessions SET last_seen_at = ? WHERE token_digest = ?', seen, digest);
	}

	return { account: toAccount(account), expiresAt: row.expires_at, credential };
}

const LAST_SEEN_RESOLUTION_MS = 60_000;

/*
 * On PostgreSQL, a resolved session is remembered for five seconds.
 *
 * Every request resolves the session, and a library page opens dozens of
 * covers at once. Against SQLite in the same process that costs microseconds;
 * against a server on the network it was two round trips per image. Five
 * seconds is short enough that expiry, which is checked on every request from
 * the remembered row, stays exact, and everything in this process that ends a
 * session or changes an account drops the entry at once. A second Heddohon
 * process on the same database would see a sign-out elsewhere up to five
 * seconds late. SQLite is not cached: it gains nothing.
 */
const SESSION_CACHE_MS = 5000;
const SESSION_CACHE_MAX = 5000;
const sessionCache = new Map<
	string,
	{ row: { account_id: string; expires_at: number; last_seen_at: number }; account: AccountRow; until: number }
>();

/**
 * Bumped by everything that ends a session or changes an account. A read that
 * started before a bump does not go into the cache. Invalidations are rare
 * (a sign-out, a sign-in, a rejected credential), so one counter for all of
 * them costs a few extra database reads at most.
 */
let sessionEpoch = 0;

/** Drops every remembered session for an account, after its row changed. */
function forgetAccount(accountId: string): void {
	sessionEpoch++;
	for (const [digest, entry] of sessionCache) {
		if (entry.row.account_id === accountId) sessionCache.delete(digest);
	}
}

/*
 * Known devices, so that guessing at a username cannot lock its owner out.
 *
 * The username throttle is checked before the music server is asked, so ten
 * wrong guesses from anywhere refused the owner's right password as well, for
 * fifteen minutes, and an attacker could keep that up indefinitely. A browser
 * that has signed in as an account carries this cookie afterwards, and its
 * attempts at that account are counted against the device instead of the
 * username (see `loginKeys`). Guessing elsewhere does not reach that budget.
 *
 * The value is a random id and an HMAC over the id, the backend and the
 * lower-cased username, so it cannot be made up and one device's cookie says
 * nothing about another's. It carries no session and opens nothing by itself.
 *
 * The backend is signed because a name on the Subsonic server and the same
 * name on the Jellyfin server can be two people. Signed over the username
 * alone, a cookie earned by signing in to one counted as known at the other,
 * and signing in to the first again cleared the device's counter, so its
 * holder could guess at the second without limit.
 */
const DEVICE_COOKIE = 'heddohon_device';
const DEVICE_MAX_AGE_S = 180 * 24 * 60 * 60;
const DEVICE_ID = /^[A-Za-z0-9_-]{22}$/;

function deviceCookieName(url: URL): string {
	return cookieSecure(url) ? `__Host-${DEVICE_COOKIE}` : DEVICE_COOKIE;
}

function deviceSignature(id: string, kind: BackendKind, username: string): string {
	return deviceDigest(`${id}:${kind}:${username.toLowerCase()}`);
}

/** The id of this browser if it has signed in as `username` on `kind` before, else null. */
export function knownDevice(event: CookieContext, kind: BackendKind, username: string): string | null {
	const raw = event.cookies.get(deviceCookieName(event.url));
	if (!raw) return null;
	const [id, signature, extra] = raw.split('.');
	if (extra !== undefined || !id || !signature || !DEVICE_ID.test(id)) return null;
	return constantTimeEquals(signature, deviceSignature(id, kind, username)) ? id : null;
}

/** Marks this browser as known for `username` on `kind`, after a successful sign-in. */
export function rememberDevice(event: CookieContext, kind: BackendKind, username: string): void {
	const id = knownDevice(event, kind, username) ?? randomBytes(16).toString('base64url');
	const secure = cookieSecure(event.url);
	event.cookies.set(deviceCookieName(event.url), `${id}.${deviceSignature(id, kind, username)}`, {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		secure,
		maxAge: DEVICE_MAX_AGE_S
	});
}

export async function destroySession(event: CookieContext): Promise<void> {
	// Both names, so that signing out of a deployment that has changed scheme
	// since the cookie was issued still clears the row and the cookie.
	for (const name of [SESSION_COOKIE_HOST, SESSION_COOKIE]) {
		const token = event.cookies.get(name);
		if (token) {
			const digest = tokenDigest(token);
			await (await store()).run('DELETE FROM sessions WHERE token_digest = ?', digest);
			// After the delete, so a read that began before it cannot cache the
			// row it saw.
			sessionEpoch++;
			sessionCache.delete(digest);
		}
		event.cookies.delete(name, { path: '/' });
	}
}

/** Signs the account out everywhere — used when the upstream rejects the stored credential. */
export async function destroyAllSessions(accountId: string): Promise<void> {
	const result = await (await store()).run('DELETE FROM sessions WHERE account_id = ?', accountId);
	forgetAccount(accountId);
	forgetListings(accountId);
	forgetTranscodes(accountId);
	// The account was signed in and now is not, without anybody asking for that.
	// It means the password changed upstream, or the token was revoked there, and
	// it is the explanation for "it logged me out on its own".
	log.warn('sessions-destroyed', { account: accountId, sessions: result.changes });
}

let lastPrune = 0;

async function pruneExpiredSessions(): Promise<void> {
	// Cheap enough to do opportunistically, but not on every request.
	const timestamp = now();
	if (timestamp - lastPrune < 60_000) return;
	lastPrune = timestamp;
	await (await store()).run('DELETE FROM sessions WHERE expires_at <= ?', timestamp);
}

export async function activeSessionCount(accountId: string): Promise<number> {
	const row = await (await store()).get<{ count: number }>(
		'SELECT COUNT(*) AS count FROM sessions WHERE account_id = ? AND expires_at > ?',
		accountId,
		now()
	);
	return Number(row?.count ?? 0);
}
