/**
 * The pending half of a Quick Connect sign-in.
 *
 * Between starting a request and its approval this server holds the secret the
 * music server issued, which completes the sign-in for whoever presents it.
 * The browser shows the code and carries the secret only inside a cookie
 * sealed with AES-256-GCM under its own key. A cookie, not a table, so nothing
 * is written to disk for a request never approved.
 *
 * The cookie is named as the session cookie is, `__Host-` wherever it is
 * `Secure`, so a sibling origin cannot plant a pending request. The browser
 * also sends back the code it shows, and a cookie with a different code is
 * refused, which covers deployments where the prefix cannot be used.
 */
import type { BackendKind } from '$lib/types';
import { cookieSecure, type CookieContext } from './auth';
import { constantTimeEquals, openJson, sealJson } from './crypto';

const COOKIE = 'heddohon_quick_connect';
const COOKIE_HOST = `__Host-${COOKIE}`;
const PURPOSE = 'quick-connect';

/** Jellyfin forgets a pending request after 10 minutes. */
export const QUICK_CONNECT_TTL_MS = 10 * 60 * 1000;

export interface PendingQuickConnect {
	backend: BackendKind;
	secret: string;
	code: string;
	deviceId: string;
	startedAt: number;
}

function cookieName(event: CookieContext): string {
	return cookieSecure(event.url) ? COOKIE_HOST : COOKIE;
}

export function savePending(event: CookieContext, pending: PendingQuickConnect): void {
	const secure = cookieSecure(event.url);
	event.cookies.set(secure ? COOKIE_HOST : COOKIE, sealJson(pending, PURPOSE), {
		path: '/',
		httpOnly: true,
		sameSite: 'strict',
		secure,
		maxAge: Math.floor(QUICK_CONNECT_TTL_MS / 1000)
	});
}

/**
 * The pending request for the code the browser is showing. Null when there is
 * none, it has expired, or it belongs to a different code.
 */
export function readPending(event: CookieContext, code: string): PendingQuickConnect | null {
	const blob = event.cookies.get(cookieName(event));
	if (!blob) return null;

	let pending: PendingQuickConnect;
	try {
		pending = openJson<PendingQuickConnect>(blob, PURPOSE);
	} catch {
		return null;
	}
	if (typeof pending.code !== 'string' || !constantTimeEquals(pending.code, code)) return null;
	if (Date.now() - pending.startedAt > QUICK_CONNECT_TTL_MS) return null;
	return pending;
}

/**
 * `secure` is passed explicitly. SvelteKit marks a deletion `Secure` on every
 * plain-http host except `localhost`, and a browser drops that, so with
 * HEDDOHON_COOKIE_SECURE=false the cookie outlived its sign-in.
 */
export function clearPending(event: CookieContext): void {
	event.cookies.delete(COOKIE_HOST, { path: '/', secure: true });
	event.cookies.delete(COOKIE, { path: '/', secure: cookieSecure(event.url) });
}

/**
 * The least time between two upstream checks of one request. The browser polls
 * every 3 seconds, and a script can replay the cookie faster. A check that
 * arrives sooner is answered `waiting` without asking the music server.
 */
const MIN_CHECK_INTERVAL_MS = 2_000;
const lastChecked = new Map<string, number>();

/**
 * Secrets that have completed a sign-in, or are completing one now.
 *
 * Jellyfin 10.10 mints the token on approval, and
 * `AuthenticateWithQuickConnect` returns it for every call with the secret
 * until 10 minutes after. The secret is not spent upstream, so it is spent
 * here: a replayed cookie, or a second poll racing the first, gets `expired`
 * and not a second session. In memory, so a restart forgets it, and the
 * cookie's own 10-minute limit still applies.
 */
const claimed = new Map<string, number>();

function sweep(map: Map<string, number>, timestamp: number): void {
	// Swept only past 1000 entries. Both maps grow by at most one entry per
	// start, and starts are rate limited.
	if (map.size <= 1000) return;
	for (const [key, at] of map) {
		if (timestamp - at > QUICK_CONNECT_TTL_MS) map.delete(key);
	}
}

export function mayCheckUpstream(secret: string): boolean {
	const timestamp = Date.now();
	const previous = lastChecked.get(secret);
	if (previous !== undefined && timestamp - previous < MIN_CHECK_INTERVAL_MS) return false;
	lastChecked.set(secret, timestamp);
	sweep(lastChecked, timestamp);
	return true;
}

/** Whether the secret has already been used, or is being used now. */
export function isClaimed(secret: string): boolean {
	return claimed.has(secret);
}

/**
 * Takes the secret for one sign-in. False when another request already has it.
 * Synchronous, so two polls cannot both pass between the check and the set.
 */
export function claim(secret: string): boolean {
	if (claimed.has(secret)) return false;
	const timestamp = Date.now();
	claimed.set(secret, timestamp);
	lastChecked.delete(secret);
	sweep(claimed, timestamp);
	return true;
}

/** Hands a secret back after a sign-in that failed on a fault worth retrying. */
export function release(secret: string): void {
	claimed.delete(secret);
}

export function forgetChecks(secret: string): void {
	lastChecked.delete(secret);
}
