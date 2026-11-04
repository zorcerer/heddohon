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
import { ConfigError, config } from './config';
import type { Store } from './db';
import { log } from './log';

const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const VERSION = 'v1';
/** This install's own salt, 32 bytes as hex. */
export const SALT_FILE = 'crypto-salt';
/**
 * The row in `meta` that records which salt the database was sealed with:
 * `constant`, or `own:` and a SHA-256 of this install's salt. It travels with
 * the database (a backup, an import into PostgreSQL), so the salt file can be
 * checked against it wherever the database goes.
 */
const SALT_ROW = 'key_salt';
const CONSTANT = 'constant';

const keyCache = new Map<string, Buffer>();

/**
 * This install's key salt, or `null` for the constant one every build before
 * it used. Settled by `settleKeySalt` as the database opens, before any key
 * can be derived.
 */
let keySaltCache: Buffer | null | undefined;

function keySalt(): Buffer | null {
	if (keySaltCache === undefined) {
		// `store()` settles it, and `hooks.server.ts` waits for `store()` before
		// a request reaches anything that digests or seals.
		throw new Error('A key was asked for before the database was opened');
	}
	return keySaltCache;
}

/** What `meta` holds for an install's own salt. */
function ownRow(salt: Buffer): string {
	return `own:${createHash('sha256').update(salt).digest('hex')}`;
}

/**
 * Decides, once, which salt this install derives its keys with, from the
 * database it is about to use.
 *
 * The constant salt is what an install that predates the salt keeps:
 * everything it sealed and every digest it stored was made with it, and
 * deriving with a new salt would lock it out of its own database. The first
 * version of this decided from the data directory (`setup.json`, accounts in
 * `heddohon.db`). That took a PostgreSQL install for a new one and gave it a
 * new salt, kept every install made through the setup page on the constant
 * one, and fell back to the constant one when a salted install lost its file.
 * The database holds the accounts, so it is what is asked, and once decided
 * the answer is written into it.
 *
 * A salt file that the database does not match is refused, never replaced and
 * never worked around: deriving with any other salt seals new values that the
 * right one cannot open.
 */
export async function settleKeySalt(database: Store): Promise<void> {
	if (keySaltCache !== undefined) return;
	const file = join(config().dataDir, SALT_FILE);
	const salt = readSalt(file);
	const row = (await database.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', SALT_ROW))?.value;

	if (row === CONSTANT) {
		if (salt) {
			throw new ConfigError(
				`${file} is there, but this database was sealed with the constant salt of an install that ` +
					'predates the file. Move the file out of HEDDOHON_DATA_DIR; it belongs to another install.'
			);
		}
		keySaltCache = null;
		return;
	}
	if (row !== undefined) {
		if (!salt) {
			throw new ConfigError(
				`${file} is missing, and this database was sealed with it. Restore it from a backup of the ` +
					'data directory (a backup archive holds it beside heddohon.db). It cannot be replaced.'
			);
		}
		if (ownRow(salt) !== row) {
			throw new ConfigError(
				`${file} is not the salt this database was sealed with. Restore the one from the same backup ` +
					'as the database (a backup archive holds both).'
			);
		}
		keySaltCache = salt;
		return;
	}

	// No record yet: the first start of this build. Every sealed value and
	// digest belongs to an account (sessions, links, tokens and codes refer to
	// one), so a database with no account has nothing a salt could lock out.
	const accounts = (await database.get<{ count: number }>('SELECT COUNT(*) AS count FROM accounts'))?.count ?? 0;
	let chosen: Buffer | null;
	if (salt) {
		// Made by the first version of this, which wrote no row.
		chosen = salt;
	} else if (accounts > 0) {
		chosen = null;
		log.warn('crypto-salt-kept-constant', { accounts });
	} else {
		chosen = randomBytes(32);
		// The file before the row: a start that stops between them finds a salt
		// and no row, and keeps the salt.
		writeFileAtomically(file, `${chosen.toString('hex')}\n`);
		log.info('crypto-salt-made', { file: SALT_FILE });
	}
	await database.run(
		'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING',
		SALT_ROW,
		chosen ? ownRow(chosen) : CONSTANT
	);
	keySaltCache = chosen;
}

/** The salt file, `null` when there is none, and refused when it cannot be read. */
function readSalt(file: string): Buffer | null {
	if (!existsSync(file)) return null;
	const hex = readFileSync(file, 'utf8').trim();
	if (!/^[0-9a-f]{64}$/.test(hex)) {
		// Never replaced by a new one: a salt that cannot be read is a restore,
		// not a fresh install. A new salt would make every sealed value and
		// digest this install holds unreadable.
		throw new ConfigError(
			`${file} is not 32 bytes written as hex. Restore it from a backup of the data directory ` +
				'(a backup archive holds it beside heddohon.db). It is what every stored credential is ' +
				'sealed with, so it cannot be replaced.'
		);
	}
	return Buffer.from(hex, 'hex');
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
