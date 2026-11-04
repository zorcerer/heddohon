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
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigError, SETUP_FILE, config } from './config';
import { sqliteFile, storedAccounts } from './db';
import { log } from './log';

const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const VERSION = 'v1';
/** This install's own salt, 32 bytes as hex. */
const SALT_FILE = 'crypto-salt';
/** An empty file beside it, saying this install keeps the constant salt. */
const LEGACY_FILE = 'crypto-salt.legacy';

const keyCache = new Map<string, Buffer>();

/**
 * This install's key salt, or `null` for the constant one every build before
 * it used.
 *
 * The constant one is what an install that predates the salt keeps: everything
 * it sealed and every digest it stored was made with it, and deriving with a
 * new salt would lock it out of its own database. So the choice is made once,
 * here, before the first key exists, and it is never revisited: a salt file
 * means this install's own, a marker file means the constant, and with neither
 * the data directory itself says which install this is.
 */
let keySaltCache: Buffer | null | undefined;

function keySalt(): Buffer | null {
	if (keySaltCache !== undefined) return keySaltCache;
	const dir = config().dataDir;
	const file = join(dir, SALT_FILE);
	if (existsSync(file)) {
		const hex = readFileSync(file, 'utf8').trim();
		if (!/^[0-9a-f]{64}$/.test(hex)) {
			// Never replaced by a new one: a salt that cannot be read is a
			// restore, not a fresh install. A new salt would make every sealed
			// value and digest this install holds unreadable.
			throw new ConfigError(
				`${file} is not 32 bytes written as hex. Restore it from a backup of the data directory ` +
					'(a backup archive holds it beside heddohon.db). It is what every stored credential is ' +
					'sealed with, so it cannot be replaced.'
			);
		}
		return (keySaltCache = Buffer.from(hex, 'hex'));
	}
	if (existsSync(join(dir, LEGACY_FILE))) return (keySaltCache = null);
	// Neither file. An install from before the salt existed has data here; a new
	// one does not. `setup.json` is written by the first setup, and accounts are
	// sealed rows, so either one is proof of an install older than this file.
	if (existsSync(join(dir, SETUP_FILE)) || storedAccounts(sqliteFile()) > 0) {
		writeFileAtomically(join(dir, LEGACY_FILE), '');
		log.warn('crypto-salt-kept-constant', { file: LEGACY_FILE });
		return (keySaltCache = null);
	}
	const salt = randomBytes(32);
	writeFileAtomically(file, `${salt.toString('hex')}\n`);
	log.info('crypto-salt-made', { file: SALT_FILE });
	return (keySaltCache = salt);
}

/** Written beside the file and renamed over the target, as `saveSetup` does. */
function writeFileAtomically(path: string, text: string): void {
	const scratch = `${path}.${process.pid}.tmp`;
	writeFileSync(scratch, text, { mode: 0o600 });
	// The mode above is masked by the umask, and does nothing to a file that
	// was already there.
	chmodSync(scratch, 0o600);
	renameSync(scratch, path);
}

function keyFor(purpose: string): Buffer {
	const cached = keyCache.get(purpose);
	if (cached) return cached;
	// A different key for each purpose, and the same one after a restart. With
	// this install's own salt the derivation adds the purpose to it; the
	// constant path is left exactly as it was, because an install that still
	// uses it has digests and sealed values made that way.
	const own = keySalt();
	const salt = own
		? createHash('sha256').update(own).update(`:${VERSION}:${purpose}`).digest()
		: createHash('sha256').update(`heddohon:${VERSION}:${purpose}`).digest();
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
	try {
		return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
	} catch {
		// A tag that does not check out is a different secret, or a different key
		// salt, than the one this value was written with.
		throw new Error(
			'A sealed value did not open: HEDDOHON_SECRET or this install’s key salt (crypto-salt) is not the one it was written with'
		);
	}
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

/**
 * The digest the Navidrome plugin's token is compared by; see `plugin.ts`.
 * Two digests are the same length whatever was sent, which is what
 * `constantTimeEquals` needs to take the same time for any guess.
 */
export function pluginDigest(token: string): string {
	return createHmac('sha256', keyFor('navidrome-plugin')).update(token).digest('base64url');
}

/**
 * The digest of an MCP token; see `mcp.ts`. Keyed apart from sessions and
 * links, so no token digests to a value in another's table.
 */
export function mcpDigest(token: string): string {
	return createHmac('sha256', keyFor('mcp')).update(token).digest('base64url');
}

/**
 * The digest of a now-playing link's token; see `nowplaying.ts`. Keyed apart
 * from the other tokens, so none digests to a value in another's table.
 */
export function nowPlayingDigest(token: string): string {
	return createHmac('sha256', keyFor('now-playing')).update(token).digest('base64url');
}

/**
 * The digest of a recovery code, over the account and the code; see
 * `twofactor.ts`. Keyed apart from the tokens, as each of them is.
 */
export function recoveryDigest(accountId: string, code: string): string {
	return createHmac('sha256', keyFor('recovery-code')).update(`${accountId}:${code}`).digest('base64url');
}

/** The digest of a sign-in waiting for its second factor; see `twofactor.ts`. */
export function signInStepDigest(token: string): string {
	return createHmac('sha256', keyFor('sign-in-step')).update(token).digest('base64url');
}

/** The digest a WebAuthn challenge is stored by; see `twofactor.ts`. */
export function passkeyChallengeDigest(challenge: string): string {
	return createHmac('sha256', keyFor('passkey-challenge')).update(challenge).digest('base64url');
}

/**
 * The digest of a public profile link's token; see `profilepage.ts`. Keyed
 * apart from the other tokens, so none digests to a value in another's table.
 */
export function profileLinkDigest(token: string): string {
	return createHmac('sha256', keyFor('profile-link')).update(token).digest('base64url');
}
