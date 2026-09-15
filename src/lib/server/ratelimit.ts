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
 * single statement, and better-sqlite3 is synchronous, so nothing interleaves
 * between the read and the write. The cost is that an attempt the upstream
 * never judged has to be handed back explicitly, which is what `refundLoginAttempt`
 * is for.
 *
 * State lives in SQLite rather than in memory so that restarting the container
 * is not a way to clear the counter.
 */
import { db } from './db';
import { log } from './log';

/** How long a run of failures is remembered. */
const WINDOW_MS = 15 * 60 * 1000;
/** Attempts allowed per username before that username is throttled. */
const MAX_PER_USERNAME = 10;
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
 */
export function loginKeys(username: string, address: string): Array<[string, number]> {
	const keys: Array<[string, number]> = [[`user:${username.toLowerCase()}`, MAX_PER_USERNAME]];

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
export function reserveLoginAttempt(keys: Array<[string, number]>): RateVerdict {
	const timestamp = Date.now();
	const statement = db().prepare<
		[string, number, number, number, number],
		{ failures: number; window_from: number }
	>(
		`INSERT INTO login_attempts (key, failures, window_from) VALUES (?, 1, ?)
		 ON CONFLICT(key) DO UPDATE SET
		   failures = CASE WHEN ? - window_from > ${WINDOW_MS} THEN 1 ELSE failures + 1 END,
		   window_from = CASE WHEN ? - window_from > ${WINDOW_MS} THEN ? ELSE window_from END
		 RETURNING failures, window_from`
	);

	let worst = 0;
	for (const [key, limit] of keys) {
		const row = statement.get(key, timestamp, timestamp, timestamp, timestamp);
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
export function refundLoginAttempt(keys: Array<[string, number]>): void {
	const statement = db().prepare<[string]>(
		'UPDATE login_attempts SET failures = MAX(failures - 1, 0) WHERE key = ?'
	);
	for (const [key] of keys) statement.run(key);
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
