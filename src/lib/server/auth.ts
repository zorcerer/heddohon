/**
 * Accounts and sessions.
 *
 *  1. Heddohon holds no password of its own. Every sign-in is a live call to
 *     the configured Navidrome/Jellyfin server, with no local fallback.
 *  2. A session is an opaque random token. The database stores its HMAC
 *     digest and an absolute expiry, set at sign-in and never extended.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Cookies } from '@sveltejs/kit';
import type { BackendKind } from '$lib/types';
import { config } from './config';
import {
	constantTimeEquals,
	deviceDigest,
	openJson,
	randomToken,
	sealJson,
	tokenDigest
} from './crypto';
import { now, store, type AccountRow } from './db';
import { deviceLabel } from './device';
import { backendFor, type StoredCredential } from './backends';
import { log } from './log';
import { forgetListings } from './listings';
import { forgetDetails } from './details';
import { forgetSuggestions } from './suggestions';
import { forgetTranscodes } from './transcodes';
import { dropKeeper, stopFill } from './coverfill';
import { dropIntegrations } from './integrations';
import { clearAccountState } from './settings';
import { forgetSharedItems, revokeAllShares } from './shares';
import { foldName } from './names';
import { endPartiesOf } from './together';

const SESSION_COOKIE = 'heddohon_session';

/**
 * The cookie name wherever the cookie is `Secure`.
 *
 * A sibling origin on the same registrable domain can set `heddohon_session`
 * with `Domain=.example.com`. Both cookies then arrive in one header, and
 * `cookie@0.6.0` keeps the first, which is the older, planted one. Signing in
 * and `destroySession` write the host-only cookie and leave the plant.
 *
 * A browser refuses a `__Host-` cookie that carries a `Domain`, so only this
 * host can set one. The prefix requires `Secure`, so plain http keeps the bare
 * name.
 */
const SESSION_COOKIE_HOST = `__Host-${SESSION_COOKIE}`;

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
	/** See `rememberDevice`. */
	deviceEpoch: number;
}

export interface AuthenticatedSession {
	account: Account;
	/** Epoch millis. */
	createdAt: number;
	/** Epoch millis. Absolute, never extended. */
	expiresAt: number;
	credential: StoredCredential;
	/** This session's name in the list in Settings; see `sessionHandle`. */
	handle: string;
}

function toAccount(row: AccountRow): Account {
	return {
		id: row.id,
		backend: row.backend as BackendKind,
		username: row.username,
		remoteUserId: row.remote_user_id,
		deviceEpoch: Number(row.device_epoch ?? 0)
	};
}

/**
 * The username comparison as SQL, for the engine in use.
 *
 * SQLite's `lower()` folds ASCII only. PostgreSQL's follows the locale: on a
 * stock `postgres:16-alpine` (en_US.utf8) `lower(U&'\212Aate') = 'kate'`, so a
 * name with a Kelvin sign signed in to another user's row and took over its
 * settings and links. The "C" collation folds ASCII only, which is what
 * Navidrome compares by.
 */
function usernameMatch(kind: 'sqlite' | 'postgres'): string {
	return kind === 'postgres'
		? 'lower(username COLLATE "C") = lower(? COLLATE "C")'
		: 'lower(username) = lower(?)';
}

/** Signs in upstream and stores the account with a freshly sealed credential. */
export async function signIn(
	kind: BackendKind,
	username: string,
	password: string
): Promise<Account> {
	const { credential, remoteUserId } = await backendFor(kind).login(username, password);
	return storeAccount(kind, credential, remoteUserId);
}

/** Completes a Quick Connect sign-in approved upstream. Stored as a password sign-in is. */
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

	// Matched in any case, as Navidrome and Jellyfin do: a case-sensitive match
	// gave `Alice` and `alice` two rows, each with its own settings, queue and
	// position. Ordered so repeated sign-ins land on the same row where an older
	// database holds both. `lower()` instead of `COLLATE NOCASE`, which
	// PostgreSQL lacks; see `usernameMatch`.
	const existing = await database.get<AccountRow>(
		`SELECT * FROM accounts WHERE backend = ? AND ${usernameMatch(database.kind)} ORDER BY created_at LIMIT 1`,
		kind,
		credential.username
	);
	let deviceEpoch = Number(existing?.device_epoch ?? 0);

	if (existing && isAnotherUser(kind, existing.remote_user_id, remoteUserId)) {
		/*
		 * The music server has a different user under this name (deleted and
		 * recreated, or freed by a rename). Kept, the row handed the new user's
		 * credential to the old user's sessions and links. Everything tied to
		 * the old user goes before the credential changes, so no request pairs
		 * an old session with the new credential.
		 */
		await destroyAllSessions(existing.id);
		const links = await revokeAllShares(existing.id);
		await clearAccountState(existing.id);
		await dropKeeper(kind, existing.id);
		await dropIntegrations(existing.id);
		deviceEpoch++;
		log.warn('account-user-replaced', { account: existing.id, backend: kind, links });
	} else if (existing && passwordChanged(existing.credential, credential)) {
		/*
		 * Subsonic reports no user id, so a name given to someone else looks the
		 * same as a password change. Both end the row's sessions: kept, they
		 * worked with the new credential, which handed a reused name's library
		 * to its previous holder. A password change therefore signs out the
		 * other devices. Links, settings and the queue stay, since the same
		 * person would lose them.
		 */
		await destroyAllSessions(existing.id);
		// See `dropKeeper` and `dropIntegrations` for why these are not kept.
		await dropKeeper(kind, existing.id);
		await dropIntegrations(existing.id);
		deviceEpoch++;
		log.warn('account-password-changed', { account: existing.id, backend: kind });
	}

	if (existing) {
		// The stored username follows the latest sign-in: Subsonic sends it in
		// every request's query string, so it must be the spelling that
		// authenticated.
		await database.run(
			'UPDATE accounts SET username = ?, credential = ?, remote_user_id = ?, last_login_at = ?, device_epoch = ? WHERE id = ?',
			credential.username,
			sealed,
			remoteUserId,
			timestamp,
			deviceEpoch,
			existing.id
		);
		forgetAccount(existing.id);
		return toAccount({
			...existing,
			username: credential.username,
			remote_user_id: remoteUserId,
			last_login_at: timestamp,
			device_epoch: deviceEpoch
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

	return { id, backend: kind, username: credential.username, remoteUserId, deviceEpoch: 0 };
}

/**
 * Whether a sign-in under an existing row's name is a different upstream user.
 * Jellyfin only: its user id is a GUID that survives renames and is never
 * reused. Subsonic has no user id, and the name is stored in its place.
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
		`INSERT INTO sessions (token_digest, account_id, created_at, expires_at, last_seen_at, client_pseudonym, device)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		tokenDigest(token),
		account.id,
		created,
		expiresAt,
		created,
		// `client_pseudonym` held an HMAC of the User-Agent, the same value for
		// every session of one browser build, and nothing read it. Only the label
		// is kept.
		null,
		deviceLabel(clientHint)
	);
	await capSessions(account.id);

	const secure = cookieSecure(event.url);
	event.cookies.set(secure ? SESSION_COOKIE_HOST : SESSION_COOKIE, token, {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		secure,
		// The server-side expiry is the one enforced. This stops a dead cookie
		// being sent.
		maxAge: Math.floor(maxAgeMs / 1000)
	});

	// A bare-name cookie from before this deployment became Secure would be the
	// value a downgrade reads.
	if (secure) event.cookies.delete(SESSION_COOKIE, { path: '/' });

	await pruneExpiredSessions();
	return token;
}

/**
 * Sessions one account may hold. A sign-in past it ends the oldest.
 *
 * A correct password clears the throttle, so sign-ins were unlimited: 300 in
 * 1.5s made 300 rows and a 290KB Settings page.
 */
const MAX_SESSIONS_PER_ACCOUNT = 50;

async function capSessions(accountId: string): Promise<void> {
	const result = await (await store()).run(
		`DELETE FROM sessions WHERE account_id = ? AND token_digest NOT IN (
		   SELECT token_digest FROM sessions WHERE account_id = ? ORDER BY created_at DESC LIMIT ${MAX_SESSIONS_PER_ACCOUNT}
		 )`,
		accountId,
		accountId
	);
	if (result.changes > 0) {
		forgetAccount(accountId);
		log.info('sessions-capped', { account: accountId, sessions: result.changes });
	}
}

/**
 * Whether the session cookie is `Secure`, and with it which name it carries.
 *
 * On 'auto' the request's own scheme is read first. `process.env.ORIGIN` is
 * not used: with ORIGIN unset adapter-node derives the origin from Host and
 * assumes https, so an https deployment behind a proxy passed the CSRF check
 * while this returned false, and one plain-http request (any page can provoke
 * one with an <img>) sent the token in clear.
 *
 * `NODE_ENV=production` also turns it on, and the Docker image sets that, so a
 * plain-http deployment of the image needs HEDDOHON_COOKIE_SECURE=false. A
 * plain-http deployment with ORIGIN unset did not work before either: there
 * `url.protocol` is https, the browser's Origin is http, and the cross-origin
 * check in hooks.server.ts rejects sign-in.
 *
 * Loopback over plain http is exempt outside production, so `vite dev` works.
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
 * Resolves the request's cookie to a live session and opens the credential.
 * Null for anything expired, unknown or undecryptable.
 */
export async function resolveSession(event: CookieContext): Promise<AuthenticatedSession | null> {
	// Only the name this deployment issues is read. Falling back to the bare
	// name on a Secure deployment reopens the shadowing described on
	// SESSION_COOKIE_HOST. Sessions issued under the other name are not
	// honoured.
	const token = event.cookies.get(
		cookieSecure(event.url) ? SESSION_COOKIE_HOST : SESSION_COOKIE
	);
	if (!token) return null;

	const digest = tokenDigest(token);
	const database = await store();

	const cached = sessionCache.get(digest);
	let row: { account_id: string; created_at: number; expires_at: number; last_seen_at: number } | undefined;
	let account: AccountRow | undefined;
	if (cached && cached.until > now()) {
		({ row, account } = cached);
	} else {
		// Taken before the reads: a sign-out that lands during them bumps it, and
		// the stale rows are then not cached.
		const epoch = sessionEpoch;
		row = await database.get(
			'SELECT account_id, created_at, expires_at, last_seen_at FROM sessions WHERE token_digest = ?',
			digest
		);
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
		// The secret changed, or the row was tampered with.
		await destroySession(event);
		return null;
	}

	// `last_seen_at` is informational and does not extend `expires_at`. Written
	// at most once a minute: per request it was one write for every cover on a
	// library page, queued behind SQLite's single writer.
	const seen = now();
	if (seen - row.last_seen_at >= LAST_SEEN_RESOLUTION_MS) {
		row.last_seen_at = seen;
		await database.run('UPDATE sessions SET last_seen_at = ? WHERE token_digest = ?', seen, digest);
	}

	return {
		account: toAccount(account),
		createdAt: Number(row.created_at),
		expiresAt: Number(row.expires_at),
		credential,
		handle: sessionHandle(digest)
	};
}

const LAST_SEEN_RESOLUTION_MS = 60_000;

/*
 * On PostgreSQL a resolved session is remembered for five seconds.
 *
 * Every request resolves the session, and against a database on the network
 * that was two round trips per cover. Expiry is still checked on every request
 * from the remembered row, and everything in this process that ends a session
 * or changes an account drops the entry. A second Heddohon process on the same
 * database sees a sign-out up to five seconds late. SQLite is in-process and
 * is not cached.
 */
const SESSION_CACHE_MS = 5000;
const SESSION_CACHE_MAX = 5000;
const sessionCache = new Map<
	string,
	{ row: { account_id: string; created_at: number; expires_at: number; last_seen_at: number }; account: AccountRow; until: number }
>();

/**
 * Bumped by everything that ends a session or changes an account. A read that
 * began before a bump is not cached.
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
 * The username throttle runs before the music server is asked, so ten wrong
 * guesses from anywhere refused the owner's right password for fifteen
 * minutes. A browser that has signed in as an account carries this cookie, and
 * its attempts are counted against the device instead (see `loginKeys`).
 *
 * The value is a random id and an HMAC over the id, the backend and the folded
 * username. It carries no session. The backend is signed since one name on the
 * Subsonic and Jellyfin servers can be two people: signed over the name alone,
 * a cookie earned at one counted as known at the other, and signing in to the
 * first again reset the device's counter, so the second could be guessed at
 * without limit.
 */
const DEVICE_COOKIE = 'heddohon_device';
const DEVICE_MAX_AGE_S = 180 * 24 * 60 * 60;
const DEVICE_ID = /^[A-Za-z0-9_-]{22}$/;

function deviceCookieName(url: URL): string {
	return cookieSecure(url) ? `__Host-${DEVICE_COOKIE}` : DEVICE_COOKIE;
}

/*
 * The account's device generation is signed too. It moves on a password change
 * or a new upstream user under the name, so a cookie earned before stops
 * counting as known. Without it the old password's holder kept a guessing
 * budget of their own for 180 days. The username is folded by `foldName`.
 */
function deviceSignature(id: string, kind: BackendKind, username: string, epoch: number): string {
	return deviceDigest(`${id}:${kind}:${foldName(username)}:${epoch}`);
}

async function deviceEpochFor(kind: BackendKind, username: string): Promise<number> {
	const database = await store();
	const row = await database.get<{ device_epoch: number | null }>(
		`SELECT device_epoch FROM accounts WHERE backend = ? AND ${usernameMatch(database.kind)} ORDER BY created_at LIMIT 1`,
		kind,
		username
	);
	return Number(row?.device_epoch ?? 0);
}

function deviceIdIn(event: CookieContext, kind: BackendKind, username: string, epoch: number): string | null {
	const raw = event.cookies.get(deviceCookieName(event.url));
	if (!raw) return null;
	const [id, signature, extra] = raw.split('.');
	if (extra !== undefined || !id || !signature || !DEVICE_ID.test(id)) return null;
	return constantTimeEquals(signature, deviceSignature(id, kind, username, epoch)) ? id : null;
}

/** The id of this browser if it has signed in as `username` on `kind` before, else null. */
export async function knownDevice(event: CookieContext, kind: BackendKind, username: string): Promise<string | null> {
	return deviceIdIn(event, kind, username, await deviceEpochFor(kind, username));
}

/** Marks this browser as known for the account, after a successful sign-in. */
export function rememberDevice(event: CookieContext, account: Account): void {
	const { backend: kind, username, deviceEpoch } = account;
	const id = deviceIdIn(event, kind, username, deviceEpoch) ?? randomBytes(16).toString('base64url');
	const secure = cookieSecure(event.url);
	event.cookies.set(deviceCookieName(event.url), `${id}.${deviceSignature(id, kind, username, deviceEpoch)}`, {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		secure,
		maxAge: DEVICE_MAX_AGE_S
	});
}

export async function destroySession(event: CookieContext): Promise<void> {
	// Both names, so a deployment that changed scheme since sign-in still
	// clears the row and the cookie.
	for (const name of [SESSION_COOKIE_HOST, SESSION_COOKIE]) {
		const token = event.cookies.get(name);
		if (token) {
			const digest = tokenDigest(token);
			await (await store()).run('DELETE FROM sessions WHERE token_digest = ?', digest);
			// After the delete, so a read that began before it cannot cache the row.
			sessionEpoch++;
			sessionCache.delete(digest);
			cutSessionStreams([digest]);
		}
		// `secure` as the cookie was set. Left out, SvelteKit marks the deletion
		// Secure on any host but localhost, and a browser ignores that over plain
		// http, so the dead token stayed.
		event.cookies.delete(name, { path: '/', secure: name === SESSION_COOKIE_HOST || cookieSecure(event.url) });
	}
}

/** Signs the account out everywhere, as when the upstream rejects the stored credential. */
export async function destroyAllSessions(accountId: string): Promise<void> {
	const database = await store();
	const ending = await database.all<{ token_digest: string }>(
		'SELECT token_digest FROM sessions WHERE account_id = ?',
		accountId
	);
	const result = await database.run('DELETE FROM sessions WHERE account_id = ?', accountId);
	cutSessionStreams(ending.map((row) => row.token_digest));
	forgetAccount(accountId);
	forgetListings(accountId);
	forgetDetails(accountId);
	forgetSuggestions(accountId);
	forgetTranscodes(accountId);
	forgetSharedItems(accountId);
	stopFill(accountId);
	// Nobody asked for this sign-out: the password changed upstream or the token
	// was revoked there. It explains "it logged me out on its own".
	log.warn('sessions-destroyed', { account: accountId, sessions: result.changes });
}

let lastPrune = 0;

async function pruneExpiredSessions(): Promise<void> {
	// At most once a minute.
	const timestamp = now();
	if (timestamp - lastPrune < 60_000) return;
	lastPrune = timestamp;
	await (await store()).run('DELETE FROM sessions WHERE expires_at <= ?', timestamp);
}

/**
 * The name a session goes by in Settings: 16 hex characters of a hash of the
 * stored digest, itself an HMAC of the token, so a handle leads back to
 * neither. A request to end one is matched against the account's own sessions.
 */
function sessionHandle(digest: string): string {
	return createHash('sha256').update(`session-handle:${digest}`).digest('hex').slice(0, 16);
}

export interface SessionSummary {
	handle: string;
	/** "Firefox on Android", or null for a header `deviceLabel` did not know, or a session from before it. */
	device: string | null;
	createdAt: number;
	/** To the minute; see `LAST_SEEN_RESOLUTION_MS`. */
	lastSeenAt: number;
	expiresAt: number;
	current: boolean;
	/** Whether this browser may sign it out; see `endSessions`. */
	endable: boolean;
}

/**
 * The account's live session named `handle`, for a request with no cookie: a
 * speaker fetching a cast address (`cast.ts`). Writes nothing, `last_seen_at`
 * included.
 */
export async function sessionByHandle(accountId: string, handle: string): Promise<AuthenticatedSession | null> {
	const database = await store();
	const rows = await database.all<{ token_digest: string; created_at: number; expires_at: number }>(
		'SELECT token_digest, created_at, expires_at FROM sessions WHERE account_id = ? AND expires_at > ?',
		accountId,
		now()
	);
	const row = rows.find((candidate) => constantTimeEquals(sessionHandle(candidate.token_digest), handle));
	if (!row) return null;
	const account = await database.get<AccountRow>('SELECT * FROM accounts WHERE id = ?', accountId);
	if (!account) return null;
	let credential: StoredCredential;
	try {
		credential = openJson<StoredCredential>(account.credential);
	} catch {
		return null;
	}
	return {
		account: toAccount(account),
		createdAt: Number(row.created_at),
		expiresAt: Number(row.expires_at),
		credential,
		handle
	};
}

/** The account's sessions that have not expired, most recently used first. */
export async function listSessions(session: AuthenticatedSession): Promise<SessionSummary[]> {
	const rows = await (await store()).all<{
		token_digest: string;
		created_at: number;
		last_seen_at: number;
		expires_at: number;
		device: string | null;
	}>(
		`SELECT token_digest, created_at, last_seen_at, expires_at, device FROM sessions
		 WHERE account_id = ? AND expires_at > ? ORDER BY last_seen_at DESC`,
		session.account.id,
		now()
	);
	return rows.map((row) => {
		const handle = sessionHandle(row.token_digest);
		return {
			handle,
			device: row.device,
			createdAt: Number(row.created_at),
			lastSeenAt: Number(row.last_seen_at),
			expiresAt: Number(row.expires_at),
			current: handle === session.handle,
			endable: handle !== session.handle && Number(row.created_at) <= session.createdAt
		};
	});
}

/**
 * Ends the account's sessions named by `handles`, or with `'others'` all but
 * the current one. Returns how many ended.
 *
 * Only sessions that began no later than this one. Otherwise a stolen session
 * could sign its owner out after every fresh sign-in. The owner's newer
 * session is out of its reach and can end it.
 */
export async function endSessions(session: AuthenticatedSession, handles: string[] | 'others'): Promise<number> {
	const database = await store();
	const rows = await database.all<{ token_digest: string; created_at: number }>(
		'SELECT token_digest, created_at FROM sessions WHERE account_id = ?',
		session.account.id
	);
	const targets = rows
		.filter((row) => Number(row.created_at) <= session.createdAt)
		.map((row) => row.token_digest)
		.filter((digest) => {
			const handle = sessionHandle(digest);
			if (handle === session.handle) return false;
			return handles === 'others' || handles.includes(handle);
		});

	let ended = 0;
	for (const digest of targets) {
		const result = await database.run(
			'DELETE FROM sessions WHERE token_digest = ? AND account_id = ?',
			digest,
			session.account.id
		);
		ended += result.changes;
		// After the delete, as in `destroySession`.
		sessionEpoch++;
		sessionCache.delete(digest);
	}
	cutSessionStreams(targets);
	if (ended > 0) log.info('sessions-ended', { account: session.account.id, sessions: ended, by: 'settings' });
	return ended;
}

/*
 * Audio in progress, by session, so that ending a session stops it.
 *
 * A browser plays a track as one open-ended range, checked once at its start,
 * so a browser signed out from Settings kept receiving the file. In memory: a
 * restart ends every stream. Shared links have the same registry in shares.ts.
 */
const sessionStreams = new Map<string, Set<AbortController>>();

function cutSessionStreams(digests: string[]): void {
	// A party a session hosts ends with it, as its own audio does.
	endPartiesOf(digests.map(sessionHandle));
	for (const digest of digests) {
		const handle = sessionHandle(digest);
		const streams = sessionStreams.get(handle);
		if (!streams) continue;
		sessionStreams.delete(handle);
		for (const controller of streams) controller.abort(new Error('session ended'));
	}
}

/**
 * The response with its body tied to the session: cut when the session is
 * ended or signed out, and at its expiry, checked as each chunk passes.
 */
export function tiedToSession(session: AuthenticatedSession, signal: AbortSignal, response: Response): Response {
	if (!response.body) return response;
	const controller = new AbortController();
	let streams = sessionStreams.get(session.handle);
	if (!streams) sessionStreams.set(session.handle, (streams = new Set()));
	streams.add(controller);
	const set = streams;
	const release = () => {
		set.delete(controller);
		if (set.size === 0 && sessionStreams.get(session.handle) === set) sessionStreams.delete(session.handle);
	};
	signal.addEventListener('abort', release, { once: true });

	const body = response.body.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, stream) {
				if (Date.now() >= session.expiresAt) {
					controller.abort(new Error('session expired'));
					release();
					stream.error(new Error('session expired'));
					return;
				}
				stream.enqueue(chunk);
			},
			flush: release
		}),
		{ signal: controller.signal }
	);
	return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}
