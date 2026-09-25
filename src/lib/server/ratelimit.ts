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
 * user out. The window rolls off on its own and a successful sign-in clears it
 * immediately.
 *
 * The address key is a backstop and is deliberately generous. It is also only
 * counted when the address identifies a visitor; see `perVisitorAddress`.
 *
 * Attempts are counted before the upstream is called rather than after it
 * answers. Counting failures afterwards read the counter and incremented it on
 * either side of an `await` that takes a network round trip, so 500 concurrent
 * POSTs all read the same pre-burst total, all passed, and all reached the
 * music server: 500 guesses through a limit of 10. The reservation below is a
 * single upsert that returns the new count, so nothing interleaves between the
 * read and the write: SQLite runs one statement at a time, and PostgreSQL locks
 * the row for the length of the `ON CONFLICT` update. The cost is that an attempt the upstream
 * never judged has to be handed back explicitly, which is what `refundLoginAttempt`
 * is for.
 *
 * State lives in SQLite rather than in memory so that restarting the container
 * is not a way to clear the counter.
 */
import type { BackendKind } from '$lib/types';
import { store } from './db';
import { log } from './log';

/** How long a run of failures is remembered. */
const WINDOW_MS = 15 * 60 * 1000;
/** Attempts allowed per username before that username is throttled. */
const MAX_PER_USERNAME = 10;
/** Attempts allowed per known device, at the account it is known for. */
const MAX_PER_DEVICE = 10;
/** Attempts allowed per source address. Generous, see the note above. */
const MAX_PER_ADDRESS = 60;

export interface RateVerdict {
	allowed: boolean;
	/** Seconds until the caller may try again. Zero when allowed. */
	retryAfter: number;
}

const ALLOWED: RateVerdict = { allowed: true, retryAfter: 0 };

/**
 * Whether `getClientAddress()` distinguishes one visitor from another.
 *
 * adapter-node returns the socket peer unless ADDRESS_HEADER names a header the
 * proxy sets. Behind a reverse proxy without it, every visitor arrives as the
 * proxy, so the address bucket is one bucket for the whole deployment: 60
 * deliberate failures in 15 minutes then refuse sign-in to everybody, and
 * `clearLoginFailures` does not clear the address key, so a user with the right
 * password cannot recover it. A proxy on the same host or the same Docker
 * network always presents a loopback or RFC1918 address, so that is the shape
 * to drop. A deployment exposed directly sees real public addresses and keeps
 * the backstop.
 */
function perVisitorAddress(address: string): boolean {
	if (process.env.ADDRESS_HEADER) return true;
	if (!address) return false;

	const plain = address.startsWith('::ffff:') ? address.slice(7) : address;
	if (plain === '127.0.0.1' || plain === '::1' || plain === 'localhost') return false;
	if (/^10\./.test(plain)) return false;
	if (/^192\.168\./.test(plain)) return false;
	if (/^172\.(1[6-9]|2\d|3[01])\./.test(plain)) return false;
	// Link-local, and the IPv6 unique-local range fc00::/7.
	if (/^169\.254\./.test(plain)) return false;
	if (/^f[cd][0-9a-f]{2}:/i.test(plain)) return false;
	if (/^fe80:/i.test(plain)) return false;
	return true;
}

let warnedSharedAddress = false;

/**
 * The keys a single attempt counts against. Usernames are lower-cased so that
 * `Alice` and `alice` cannot be used as two separate budgets against one
 * account, and prefixed so a username can never collide with an address.
 *
 * The backend is part of the username key. With both servers configured,
 * `alice` on Navidrome and `alice` on Jellyfin are two accounts that may
 * belong to two people, and a success clears the key. Shared, nine guesses at
 * one followed by a correct sign-in to the other reset the count, and the
 * guessing went on without limit.
 */
export function loginKeys(
	backend: BackendKind,
	username: string,
	address: string,
	device: string | null = null
): Array<[string, number]> {
	// A browser that has signed in as this account before is counted on its
	// own, and not against the username or the address, which anybody can
	// run up. See `rememberDevice` in auth.ts.
	if (device) return [[`device:${device}`, MAX_PER_DEVICE]];

	const keys: Array<[string, number]> = [[`user:${backend}:${username.toLowerCase()}`, MAX_PER_USERNAME]];

	if (perVisitorAddress(address)) {
		keys.push([`addr:${address}`, MAX_PER_ADDRESS]);
	} else if (!warnedSharedAddress) {
		warnedSharedAddress = true;
		// Printed once. It is the line that explains why the address backstop is
		// not in effect, and what to set to get it back.
		log.warn('login-address-backstop-off', {
			address,
			detail: 'every visitor reports the same address; set ADDRESS_HEADER and XFF_DEPTH to limit per visitor'
		});
	}

	return keys;
}

/** Quick Connect requests one visitor may start in the window. */
const MAX_QUICK_CONNECT_PER_ADDRESS = 20;
/** Quick Connect requests the whole deployment may start in the window. */
const MAX_QUICK_CONNECT_TOTAL = 100;

/**
 * The keys a Quick Connect start counts against.
 *
 * A start guesses nothing: the secret that completes it is 32 random bytes
 * chosen by the music server. What it does hold is a 6-digit code, 900,000
 * possible values in Jellyfin 10.10, and Jellyfin grants whichever pending
 * request matches the code a signed-in user types. A user who mistypes their
 * own code approves somebody else's request if one is pending under the typo.
 * The chance of that is the number of pending requests over 900,000, so the
 * number this deployment can hold open is capped in total and not only per
 * address: one address or a thousand, at most 100 in 15 minutes, which puts a
 * mistyped code at about 1 in 9,000 at worst.
 *
 * The total is shared, so exhausting it stops Quick Connect for everybody
 * until the window rolls off. Password sign-in counts against other keys and
 * carries on. A Jellyfin server reachable directly takes `Initiate` from
 * anybody, and this cap says nothing about requests made there.
 */
export function quickConnectKeys(address: string): Array<[string, number]> {
	const keys: Array<[string, number]> = [['qc:all', MAX_QUICK_CONNECT_TOTAL]];
	if (perVisitorAddress(address)) keys.push([`qc:${address}`, MAX_QUICK_CONNECT_PER_ADDRESS]);
	return keys;
}

function retryAfterFor(windowFrom: number, timestamp: number): number {
	return Math.max(1, Math.ceil((WINDOW_MS - (timestamp - windowFrom)) / 1000));
}

/**
 * Counts one attempt against every key and says whether it may proceed.
 *
 * Read and write are the same statement, so concurrent attempts cannot all see
 * the same pre-burst total. Every key is incremented even when an earlier one
 * has already refused, so that a throttled username still costs its address.
 */
export async function reserveLoginAttempt(keys: Array<[string, number]>): Promise<RateVerdict> {
	const timestamp = Date.now();
	const database = await store();
	const sql = (
		`INSERT INTO login_attempts (key, failures, window_from) VALUES (?, 1, ?)
		 ON CONFLICT(key) DO UPDATE SET
		   failures = CASE WHEN ? - login_attempts.window_from > ${WINDOW_MS} THEN 1 ELSE login_attempts.failures + 1 END,
		   window_from = CASE WHEN ? - login_attempts.window_from > ${WINDOW_MS} THEN ? ELSE login_attempts.window_from END
		 RETURNING failures, window_from`
	);

	let worst = 0;
	for (const [key, limit] of keys) {
		const row = await database.get<{ failures: number; window_from: number }>(
			sql,
			key,
			timestamp,
			timestamp,
			timestamp,
			timestamp
		);
		if (!row || row.failures <= limit) continue;
		worst = Math.max(worst, retryAfterFor(row.window_from, timestamp));
	}

	if (worst <= 0) return ALLOWED;
	return { allowed: false, retryAfter: worst };
}

/**
 * Hands an attempt back.
 *
 * Only a rejected credential should count. An unreachable music server is not a
 * wrong guess, and counting it would let an upstream outage lock every user out.
 */
export async function refundLoginAttempt(keys: Array<[string, number]>): Promise<void> {
	const database = await store();
	// A CASE rather than SQLite's two-argument MAX(), which PostgreSQL spells
	// GREATEST.
	for (const [key] of keys) {
		await database.run(
			'UPDATE login_attempts SET failures = CASE WHEN failures > 0 THEN failures - 1 ELSE 0 END WHERE key = ?',
			key
		);
	}
}

/**
 * Clears the counters for a successful sign-in. Only the username key is
 * cleared: the address key is shared by everyone behind a proxy, so one correct
 * password must not wipe the backstop for everybody else.
 */
export async function clearLoginFailures(keys: Array<[string, number]>): Promise<void> {
	const database = await store();
	for (const [key] of keys) {
		if (key.startsWith('user:') || key.startsWith('device:')) {
			await database.run('DELETE FROM login_attempts WHERE key = ?', key);
		}
	}
}

/** Drops rows whose window has long since rolled off. */
export async function pruneLoginAttempts(): Promise<void> {
	await (await store()).run('DELETE FROM login_attempts WHERE window_from < ?', Date.now() - WINDOW_MS * 4);
}
