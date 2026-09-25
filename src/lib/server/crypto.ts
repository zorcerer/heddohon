/**
 * Credential sealing and session token primitives.
 *
 * Upstream credentials are never written to disk in the clear. They are sealed
 * with AES-256-GCM under a key derived from HEDDOHON_SECRET via scrypt, and
 * only ever opened into memory for the lifetime of a single request.
 */
import {
	createHash,
	createHmac,
	createCipheriv,
	createDecipheriv,
	randomBytes,
	scryptSync,
	timingSafeEqual
} from 'node:crypto';
import { config } from './config';

const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const VERSION = 'v1';

const keyCache = new Map<string, Buffer>();

function keyFor(purpose: string): Buffer {
	const cached = keyCache.get(purpose);
	if (cached) return cached;
	// A fixed, purpose-scoped salt keeps derivation deterministic across
	// restarts while ensuring the credential key and the token key differ.
	const salt = createHash('sha256').update(`heddohon:${VERSION}:${purpose}`).digest();
	// N=2^15 needs 128*N*r = 32 MiB, which is exactly Node's default `maxmem`
	// ceiling and therefore throws; raise the ceiling rather than weaken N.
	const derived = scryptSync(config().secret, salt, KEY_LENGTH, {
		N: 2 ** 15,
		r: 8,
		p: 1,
		maxmem: 96 * 1024 * 1024
	});
	keyCache.set(purpose, derived);
	return derived;
}

/** Encrypts a UTF-8 string. Output is safe to store in a TEXT column. */
export function seal(plaintext: string, purpose = 'credential'): string {
	const iv = randomBytes(IV_LENGTH);
	const cipher = createCipheriv('aes-256-gcm', keyFor(purpose), iv);
	const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
	const tag = cipher.getAuthTag();
	return `${VERSION}.${iv.toString('base64url')}.${tag.toString('base64url')}.${ciphertext.toString('base64url')}`;
}

/** Reverses `seal`. Throws if the blob was tampered with or the secret changed. */
export function open(blob: string, purpose = 'credential'): string {
	const parts = blob.split('.');
	if (parts.length !== 4 || parts[0] !== VERSION) {
		throw new Error('Sealed value has an unrecognised format');
	}
	const iv = Buffer.from(parts[1], 'base64url');
	const tag = Buffer.from(parts[2], 'base64url');
	const ciphertext = Buffer.from(parts[3], 'base64url');
	if (iv.length !== IV_LENGTH || tag.length !== TAG_LENGTH) {
		throw new Error('Sealed value has an invalid header');
	}
	const decipher = createDecipheriv('aes-256-gcm', keyFor(purpose), iv);
	decipher.setAuthTag(tag);
	return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

export function sealJson(value: unknown, purpose = 'credential'): string {
	return seal(JSON.stringify(value), purpose);
}

export function openJson<T>(blob: string, purpose = 'credential'): T {
	return JSON.parse(open(blob, purpose)) as T;
}

/** 256 bits of entropy, URL-safe. Used for session tokens. */
export function randomToken(): string {
	return randomBytes(32).toString('base64url');
}

/**
 * Session cookies hold the raw token; the database holds only this digest, so a
 * database leak alone does not yield usable sessions.
 */
export function tokenDigest(token: string): string {
	return createHmac('sha256', keyFor('session')).update(token).digest('base64url');
}

/**
 * Share links carry a raw token the way the session cookie does, and the
 * database holds only this digest. It is keyed apart from the session digest,
 * so a share token presented as a session cookie, or the other way round,
 * digests to a value the other table does not hold.
 */
export function shareDigest(token: string): string {
	return createHmac('sha256', keyFor('share')).update(token).digest('base64url');
}

/**
 * The signature on a known-device cookie; see `rememberDevice` in auth.ts.
 * Keyed on its own, like every other digest here.
 */
export function deviceDigest(value: string): string {
	return createHmac('sha256', keyFor('device')).update(value).digest('base64url');
}

/** Stable pseudonymous digest, used for audit fields that must not be reversible. */
export function pseudonym(value: string): string {
	return createHmac('sha256', keyFor('pseudonym')).update(value).digest('base64url').slice(0, 22);
}

export function constantTimeEquals(a: string, b: string): boolean {
	const bufA = Buffer.from(a);
	const bufB = Buffer.from(b);
	if (bufA.length !== bufB.length) return false;
	return timingSafeEqual(bufA, bufB);
}

/** Subsonic's `t` parameter: md5(password + salt). */
export function subsonicToken(password: string, salt: string): string {
	return createHash('md5').update(password + salt, 'utf8').digest('hex');
}

export function randomSalt(bytes = 12): string {
	return randomBytes(bytes).toString('hex');
}

/**
 * Ties a Last.fm link to the Heddohon account that started it. The value is
 * the account id and Navidrome's link token, and the digest travels in the
 * callback URL beside the link token; see `routes/settings/lastfm`. Keyed on
 * its own, like every other digest here.
 */
export function linkStateDigest(value: string): string {
	return createHmac('sha256', keyFor('link-state')).update(value).digest('base64url');
}
