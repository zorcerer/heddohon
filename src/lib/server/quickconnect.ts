/**
 * The pending half of a Quick Connect sign-in.
 *
 * Between starting a request and the user approving it, this server holds the
 * secret the music server issued. That secret completes the sign-in for whoever
 * presents it, so it never reaches the browser: the browser shows the code and
 * carries the secret only inside a cookie sealed with AES-256-GCM under a key
 * of its own purpose. Keeping it in a cookie rather than a table means nothing
 * is written to disk for a request that is never approved.
 *
 * The cookie follows the session cookie's naming, `__Host-` wherever it is
 * `Secure`, for the same reason: a sibling origin could otherwise plant a
 * pending request of its own. The browser also sends back the code it is
 * showing, and a cookie whose code differs is refused, which covers the
 * deployments where the cookie cannot carry the prefix.
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
 * The pending request for the code the browser is showing, or null when there
 * is none, it has expired, or it belongs to a different code.
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
 * `secure` is passed explicitly. SvelteKit's default marks a deletion `Secure`
 * on every plain-http host except `localhost`, and a browser drops a `Secure`
 * cookie sent over plain http, so on a deployment with
 * HEDDOHON_COOKIE_SECURE=false the cookie outlived the sign-in it was for.
 */
export function clearPending(event: CookieContext): void {
	event.cookies.delete(COOKIE_HOST, { path: '/', secure: true });
	event.cookies.delete(COOKIE, { path: '/', secure: cookieSecure(event.url) });
}

/**
 * The least time between two upstream checks of one request.
 *
 * The browser polls every 3 seconds. Nothing stops a script replaying the
 * cookie faster, and every check is a request to the music server, so checks
 * that arrive sooner than this are answered `waiting` without asking it.
 */
const MIN_CHECK_INTERVAL_MS = 2_000;
const lastChecked = new Map<string, number>();

/**
 * Secrets that have completed a sign-in, or are completing one now.
 *
 * Jellyfin 10.10 mints the token when the user approves, and
 * `AuthenticateWithQuickConnect` returns that same token for every call with
 * the secret until 10 minutes after approval. The secret is not spent by use
 * upstream, so it is spent here: a copy of the sealed cookie replayed after
 * the sign-in, or a second poll racing the first, gets `expired` and not a
 * second session. Memory only, so a restart forgets it; the cookie's own
 * 10-minute limit still applies after one.
 */
const claimed = new Map<string, number>();

function sweep(map: Map<string, number>, timestamp: number): void {
	// Only swept once there is something worth sweeping. Both maps grow at most
	// one entry per start, and starts are rate limited.
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
