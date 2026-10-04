/**
 * Credential sealing and token digests. Upstream credentials are sealed with
 * AES-256-GCM under a scrypt key derived from HEDDOHON_SECRET, and opened only
 * in memory, per request.
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
	// A fixed salt per purpose: the same key after a restart, and a different
	// key for each purpose.
	const salt = createHash('sha256').update(`heddohon:${VERSION}:${purpose}`).digest();
	// N=2^15 needs 128*N*r = 32 MiB, Node's default `maxmem`, which throws. The
	// ceiling is raised instead of lowering N.
	const derived = scryptSync(config().secret, salt, KEY_LENGTH, {
		N: 2 ** 15,
		r: 8,
		p: 1,
		maxmem: 96 * 1024 * 1024
	});
	keyCache.set(purpose, derived);
	return derived;
}

/** Encrypts a UTF-8 string into text that fits a TEXT column. */
function seal(plaintext: string, purpose = 'credential'): string {
	const iv = randomBytes(IV_LENGTH);
	const cipher = createCipheriv('aes-256-gcm', keyFor(purpose), iv);
	const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
	const tag = cipher.getAuthTag();
	return `${VERSION}.${iv.toString('base64url')}.${tag.toString('base64url')}.${ciphertext.toString('base64url')}`;
}

/** Reverses `seal`. Throws on a tampered blob or a changed secret. */
function open(blob: string, purpose = 'credential'): string {
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

/** 256 random bits, URL-safe. */
export function randomToken(): string {
	return randomBytes(32).toString('base64url');
}

/**
 * The cookie holds the raw token and the database this digest, so a database
 * leak yields no usable session.
 */
export function tokenDigest(token: string): string {
	return createHmac('sha256', keyFor('session')).update(token).digest('base64url');
}

/**
 * The digest of a share token. Keyed apart from sessions, so neither token
 * digests to a value in the other's table.
 */
export function shareDigest(token: string): string {
	return createHmac('sha256', keyFor('share')).update(token).digest('base64url');
}

/** Signs a known-device cookie; see `rememberDevice` in auth.ts. */
export function deviceDigest(value: string): string {
	return createHmac('sha256', keyFor('device')).update(value).digest('base64url');
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
 * Ties a Last.fm link to the account that started it. Covers the account id
 * and Navidrome's link token, and travels in the callback URL beside the
 * token; see `routes/settings/lastfm`.
 */
export function linkStateDigest(value: string): string {
	return createHmac('sha256', keyFor('link-state')).update(value).digest('base64url');
}

/** Signs a cast address; see `cast.ts`. */
export function castDigest(value: string): string {
	return createHmac('sha256', keyFor('cast')).update(value).digest('base64url');
}
