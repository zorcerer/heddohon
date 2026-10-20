/**
 * Rate limiting for sign-in.
 *
 * Heddohon proxies every login to the music server, so the attacker's address
 * never reaches it: its own lockout sees this container's IP and either does
 * nothing or locks everybody out. Unlimited here, a public deployment is a
 * credential-stuffing oracle.
 *
 * Two keys are counted. The username key is the one that stops credential
 * stuffing. It is throttled, not locked: the window rolls off and a successful
 * sign-in clears it. The address key is a backstop with a high limit, counted
 * only when the address identifies a visitor; see `perVisitorAddress`.
 *
 * Attempts are counted before the upstream is called. Counted afterwards, the
 * read and the increment sat either side of a network round trip, and 500
 * concurrent POSTs all read the same total and reached the music server: 500
 * guesses through a limit of 10. The reservation is one upsert that returns
 * the new count: SQLite runs one statement at a time, and PostgreSQL locks the
 * row for the `ON CONFLICT` update. An attempt the upstream never judged is
 * handed back by `refundLoginAttempt`.
 *
 * State is in the database, so a restart does not clear the counters.
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
/** Attempts allowed per source address; a backstop, see above. */
const MAX_PER_ADDRESS = 60;

export interface RateVerdict {
	allowed: boolean;
	/** Seconds until the caller may try again. Zero when allowed. */
	retryAfter: number;
}

const ALLOWED: RateVerdict = { allowed: true, retryAfter: 0 };

/** Headers a proxy adds with the visitor's address. */
const FORWARDING = ['x-forwarded-for', 'forwarded', 'x-real-ip'];

let warnedForwarding = false;

/**
 * The address to count a visitor by: `getClientAddress()`, which is the
 * connection's own unless the operator names a header in ADDRESS_HEADER.
 *
 * A forwarding header that ADDRESS_HEADER does not name is never read, nor
 * taken as a sign of anything: anyone can send one. Taking its presence to
 * mean "behind a proxy, count no address" let a client reaching the server
 * directly send `X-Forwarded-For: x` and leave the sign-in backstop per
 * address, which stops a password tried against many usernames. Behind a
 * proxy adapter-node was not told about, every visitor then shares the
 * proxy's address, and the counts are shared with it; it fails closed, and
 * the log says once what to set.
 */
export function visitorAddress(event: { getClientAddress(): string; request: Request }): string {
	if (!warnedForwarding && !process.env.ADDRESS_HEADER && FORWARDING.some((name) => event.request.headers.has(name))) {
		warnedForwarding = true;
		log.warn('address-header-unset', {
			detail:
				'A request arrived with a forwarding header and ADDRESS_HEADER is not set, so visitors are counted by the address of the connection. Behind a proxy, every visitor then shares its address for the sign-in and listen-together limits. Set ADDRESS_HEADER (and XFF_DEPTH) to the header the proxy overwrites.'
		});
	}
	return event.getClientAddress();
}

/**
 * Whether `getClientAddress()` distinguishes one visitor from another.
 *
 * adapter-node returns the socket peer unless ADDRESS_HEADER names a header
 * the proxy sets. Behind a proxy without it every visitor is the proxy, so 60
 * failures in 15 minutes refused sign-in to everybody, and a correct password
 * does not clear the address key. A proxy on the same host or Docker network
 * presents a loopback or RFC1918 address, so those are not counted. A
 * deployment exposed directly sees public addresses and keeps the backstop.
 */
export function perVisitorAddress(address: string): boolean {
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

/**
 * The bucket an address is counted in: an IPv4 address as it is, an IPv6
 * address by its /64, the smallest block routed to one customer. Keyed on the
 * full address, 300 attempts from one /64 were all allowed where one IPv4
 * address stopped at 60.
 */
export function addressBucket(address: string): string {
	const plain = (address.startsWith('::ffff:') ? address.slice(7) : address).split('%')[0];
	if (!plain.includes(':')) return plain;
	const [head, tail] = plain.split('::');
	const left = head ? head.split(':') : [];
	const right = tail ? tail.split(':') : [];
	const groups =
		tail === undefined ? left : [...left, ...Array<string>(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right];
	return `${groups
		.slice(0, 4)
		.map((group) => parseInt(group, 16).toString(16))
		.join(':')}::/64`;
}

let warnedSharedAddress = false;

/**
 * The keys one attempt counts against, prefixed so a username cannot collide
 * with an address.
 *
 * The backend is part of the username key: `alice` on Navidrome and on
 * Jellyfin can be two people, and a success clears the key. Shared, nine
 * guesses at one and a correct sign-in to the other reset the count, without
 * limit.
 */
export function loginKeys(
	backend: BackendKind,
	username: string,
	address: string,
	device: string | null = null
): Array<[string, number]> {
	// A known browser is counted on its own, not against the username or the
	// address, which anybody can run up. See `rememberDevice` in auth.ts.
	if (device) return [[`device:${device}`, MAX_PER_DEVICE]];

	// Folded up then down, as .NET's OrdinalIgnoreCase does for Jellyfin: σ, ς
	// and Σ are one letter there, and `toLowerCase()` alone gave such a name
	// several buckets. For Navidrome, which folds ASCII only, this can only
	// join buckets.
	const keys: Array<[string, number]> = [
		[`user:${backend}:${username.toUpperCase().toLowerCase()}`, MAX_PER_USERNAME]
	];

	if (perVisitorAddress(address)) {
		keys.push([`addr:${addressBucket(address)}`, MAX_PER_ADDRESS]);
	} else if (!warnedSharedAddress) {
		warnedSharedAddress = true;
		// Printed once: why the address backstop is off, and what to set.
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
 * from the music server. It does hold a 6-digit code (900,000 values in
 * Jellyfin 10.10), and Jellyfin grants whichever pending request matches the
 * code a signed-in user types, so a mistyped code approves somebody else's
 * request if one is pending under the typo. The chance is the number of
 * pending requests over 900,000, so the deployment's total is capped as well
 * as each address: at most 100 in 15 minutes, about 1 in 9,000 at worst.
 *
 * The total is shared, so exhausting it stops Quick Connect for everybody
 * until the window rolls off. Password sign-in uses other keys. A Jellyfin
 * server reachable directly takes `Initiate` from anybody, outside this cap.
 */
export function quickConnectKeys(address: string): Array<[string, number]> {
	const keys: Array<[string, number]> = [['qc:all', MAX_QUICK_CONNECT_TOTAL]];
	if (perVisitorAddress(address)) keys.push([`qc:${addressBucket(address)}`, MAX_QUICK_CONNECT_PER_ADDRESS]);
	return keys;
}

function retryAfterFor(windowFrom: number, timestamp: number): number {
	return Math.max(1, Math.ceil((WINDOW_MS - (timestamp - windowFrom)) / 1000));
}

/**
 * Counts one attempt against every key and says whether it may proceed.
 *
 * Read and write are one statement, so concurrent attempts cannot see the same
 * total. Every key is incremented even after an earlier one refused, so a
 * throttled username still costs its address.
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
 * Hands an attempt back. Only a rejected credential counts: counting an
 * unreachable music server would let an outage lock every user out.
 */
export async function refundLoginAttempt(keys: Array<[string, number]>): Promise<void> {
	const database = await store();
	// A CASE, since SQLite's two-argument MAX() is GREATEST in PostgreSQL.
	for (const [key] of keys) {
		await database.run(
			'UPDATE login_attempts SET failures = CASE WHEN failures > 0 THEN failures - 1 ELSE 0 END WHERE key = ?',
			key
		);
	}
}

/**
 * Clears the username and device keys after a successful sign-in. The address
 * key is shared by everyone behind a proxy and stays.
 */
export async function clearLoginFailures(keys: Array<[string, number]>): Promise<void> {
	const database = await store();
	for (const [key] of keys) {
		if (key.startsWith('user:') || key.startsWith('device:')) {
			await database.run('DELETE FROM login_attempts WHERE key = ?', key);
		}
	}
}

/** Drops rows whose window ended more than three windows ago. */
export async function pruneLoginAttempts(): Promise<void> {
	await (await store()).run('DELETE FROM login_attempts WHERE window_from < ?', Date.now() - WINDOW_MS * 4);
}

/**
 * Wrong second factors one account may be sent in the window, across every
 * sign-in that reached it. Whoever sends them has the password already, so
 * this is what stands between them and the account: with three six-digit
 * codes valid at a time, 5 guesses in 15 minutes is 480 a day and one chance
 * in about 700 of a day's guessing finding one. Each wrong one is logged
 * (`second-factor-rejected`) for fail2ban.
 */
const MAX_SECOND_FACTOR_FAILURES = 5;

export function secondFactorKeys(accountId: string): Array<[string, number]> {
	return [[`2fa:${accountId}`, MAX_SECOND_FACTOR_FAILURES]];
}

/** Clears the count after a second factor that was right. */
export async function clearSecondFactorFailures(accountId: string): Promise<void> {
	await (await store()).run('DELETE FROM login_attempts WHERE key = ?', `2fa:${accountId}`);
}

/** Passkey sign-ins one visitor, and the whole deployment, may start in the window. */
const MAX_PASSKEY_STARTS_PER_ADDRESS = 30;
const MAX_PASSKEY_STARTS_TOTAL = 600;

/**
 * The keys a sign-in with a passkey alone counts against as it starts. Each
 * start stores a challenge before anybody is known, so the starts are what is
 * bounded: at most 600 challenges live at once from anonymous visitors.
 */
export function passkeyStartKeys(address: string): Array<[string, number]> {
	const keys: Array<[string, number]> = [['pk:all', MAX_PASSKEY_STARTS_TOTAL]];
	if (perVisitorAddress(address)) keys.push([`pk:${addressBucket(address)}`, MAX_PASSKEY_STARTS_PER_ADDRESS]);
	return keys;
}
