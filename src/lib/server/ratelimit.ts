/**
 * Rate limiting for the sign-in door.
 *
 * Heddohon proxies every login to Navidrome or Jellyfin, which makes it the
 * front door to those servers rather than a thing in front of them. Without a
 * limiter here, a public deployment is an unmetered credential-stuffing oracle:
 * the attacker's address never reaches the upstream, so whatever fail2ban or
 * lockout the music server has sees only this container's IP and either does
 * nothing or locks out every legitimate user at once.
 *
 * Two keys are counted, and this is the part worth understanding:
 *
 * The username key is the one that actually defeats credential stuffing, and it
 * is throttled rather than locked, so an attacker cannot use it to keep a real
 * user out — the window rolls off on its own and a successful sign-in clears it
 * immediately.
 *
 * The address key is a backstop and is deliberately generous, because behind a
 * reverse proxy `getClientAddress()` is the proxy, not the visitor: every user
 * shares one bucket unless the operator sets ADDRESS_HEADER and XFF_DEPTH for
 * adapter-node. A tight per-address limit would therefore lock out a household
 * the moment one member typed a password wrong. Per-visitor limiting belongs at
 * the proxy, which is the only place that knows who the visitor is; this is the
 * floor under it, not a replacement for it.
 *
 * State lives in SQLite rather than in memory so that restarting the container
 * is not a way to clear the counter.
 */
import { db } from './db';

/** How long a run of failures is remembered. */
const WINDOW_MS = 15 * 60 * 1000;
/** Failures allowed per username before that username is throttled. */
const MAX_PER_USERNAME = 10;
/** Failures allowed per source address. Generous — see the note above. */
const MAX_PER_ADDRESS = 60;

export interface RateVerdict {
	allowed: boolean;
	/** Seconds until the caller may try again. Zero when allowed. */
	retryAfter: number;
}

const ALLOWED: RateVerdict = { allowed: true, retryAfter: 0 };

/**
 * The keys a single attempt counts against. Usernames are lower-cased so that
 * `Alice` and `alice` cannot be used as two separate budgets against one
 * account, and prefixed so a username can never collide with an address.
 */
export function loginKeys(username: string, address: string): Array<[string, number]> {
	return [
		[`user:${username.toLowerCase()}`, MAX_PER_USERNAME],
		[`addr:${address}`, MAX_PER_ADDRESS]
	];
}

function currentFailures(key: string, now: number): number {
	const row = db()
		.prepare<[string], { failures: number; window_from: number }>(
			'SELECT failures, window_from FROM login_attempts WHERE key = ?'
		)
		.get(key);
	if (!row) return 0;
	// A window that has rolled off counts as no failures at all; the row is
	// rewritten on the next failure rather than deleted here, so a read stays a
	// read.
	if (now - row.window_from > WINDOW_MS) return 0;
	return row.failures;
}

/** Whether this attempt may proceed, without recording anything. */
export function checkLoginRate(keys: Array<[string, number]>): RateVerdict {
	const now = Date.now();
	let worst = 0;

	for (const [key, limit] of keys) {
		if (currentFailures(key, now) < limit) continue;
		const row = db()
			.prepare<[string], { window_from: number }>(
				'SELECT window_from FROM login_attempts WHERE key = ?'
			)
			.get(key);
		const remaining = row ? WINDOW_MS - (now - row.window_from) : WINDOW_MS;
		worst = Math.max(worst, remaining);
	}

	if (worst <= 0) return ALLOWED;
	return { allowed: false, retryAfter: Math.ceil(worst / 1000) };
}

/** Records one failed attempt against every key. */
export function recordLoginFailure(keys: Array<[string, number]>): void {
	const now = Date.now();
	const statement = db().prepare<[string, number, number, number, number]>(
		`INSERT INTO login_attempts (key, failures, window_from) VALUES (?, 1, ?)
		 ON CONFLICT(key) DO UPDATE SET
		   failures = CASE WHEN ? - window_from > ${WINDOW_MS} THEN 1 ELSE failures + 1 END,
		   window_from = CASE WHEN ? - window_from > ${WINDOW_MS} THEN ? ELSE window_from END`
	);
	for (const [key] of keys) statement.run(key, now, now, now, now);
}

/**
 * Clears the counters for a successful sign-in. Only the username key is
 * cleared: the address key is shared by everyone behind a proxy, so one correct
 * password must not wipe the backstop for everybody else.
 */
export function clearLoginFailures(keys: Array<[string, number]>): void {
	const statement = db().prepare<[string]>('DELETE FROM login_attempts WHERE key = ?');
	for (const [key] of keys) {
		if (key.startsWith('user:')) statement.run(key);
	}
}

/** Drops rows whose window has long since rolled off. */
export function pruneLoginAttempts(): void {
	db()
		.prepare<[number]>('DELETE FROM login_attempts WHERE window_from < ?')
		.run(Date.now() - WINDOW_MS * 4);
}
