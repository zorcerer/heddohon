/**
 * Time-based one-time passwords (RFC 6238) as authenticator apps make them:
 * HMAC-SHA1, six digits, a 30-second step. Those are the values every app
 * reads from an `otpauth://` address without asking, and the only ones Google
 * Authenticator honours.
 *
 * Pure functions. What is stored, and the replay check, are in `twofactor.ts`.
 */
import { createHmac, randomBytes } from 'node:crypto';

export const TOTP_DIGITS = 6;
export const TOTP_STEP_S = 30;

/**
 * Steps either side of the current one a code is taken from: a phone's clock
 * a little off, or a code typed as it turns over. One step each way is what
 * RFC 6238 section 5.2 recommends; three codes are valid at any moment.
 */
const DRIFT_STEPS = 1;

/** 160 bits, the length of an HMAC-SHA1 key and what RFC 4226 recommends. */
const SECRET_BYTES = 20;

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32(bytes: Uint8Array): string {
	let bits = 0;
	let value = 0;
	let out = '';
	for (const byte of bytes) {
		value = (value << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			out += BASE32[(value >>> (bits - 5)) & 31];
			bits -= 5;
		}
	}
	if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
	return out;
}

export function fromBase32(text: string): Buffer {
	const clean = text.replace(/[\s=]/g, '').toUpperCase();
	const out: number[] = [];
	let bits = 0;
	let value = 0;
	for (const char of clean) {
		const index = BASE32.indexOf(char);
		if (index < 0) throw new Error('not base32');
		value = (value << 5) | index;
		bits += 5;
		if (bits >= 8) {
			out.push((value >>> (bits - 8)) & 0xff);
			bits -= 8;
		}
	}
	return Buffer.from(out);
}

/** A new secret, in base32 as the apps take it. */
export function newTotpSecret(): string {
	return base32(randomBytes(SECRET_BYTES));
}

export function totpStep(at = Date.now()): number {
	return Math.floor(at / 1000 / TOTP_STEP_S);
}

/** The code for one step (RFC 4226 section 5.3, dynamic truncation). */
export function totpCode(secret: string, step: number): string {
	const counter = Buffer.alloc(8);
	counter.writeBigUInt64BE(BigInt(step));
	const mac = createHmac('sha1', fromBase32(secret)).update(counter).digest();
	const offset = mac[mac.length - 1] & 0x0f;
	const number = mac.readUInt32BE(offset) & 0x7fffffff;
	return String(number % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0');
}

/**
 * The step whose code `code` is, within the drift either side of now, or
 * null. Every step in the window is computed and compared, so the time taken
 * does not say which one matched.
 */
export function matchingStep(secret: string, code: string, at = Date.now()): number | null {
	if (!/^\d{6}$/.test(code)) return null;
	const current = totpStep(at);
	let found: number | null = null;
	for (let step = current - DRIFT_STEPS; step <= current + DRIFT_STEPS; step++) {
		const expected = Buffer.from(totpCode(secret, step));
		const given = Buffer.from(code);
		let diff = 0;
		for (let i = 0; i < expected.length; i++) diff |= expected[i] ^ given[i];
		if (diff === 0 && found === null) found = step;
	}
	return found;
}

/**
 * The address an authenticator app reads from the QR code. The label is the
 * issuer and the account name, as the Key Uri Format asks; the name is cut
 * so the QR code stays small enough to scan from a screen.
 */
export function totpUri(secret: string, issuer: string, account: string): string {
	const name = [...account].slice(0, 64).join('');
	const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(name)}`;
	const params = new URLSearchParams({
		secret,
		issuer,
		algorithm: 'SHA1',
		digits: String(TOTP_DIGITS),
		period: String(TOTP_STEP_S)
	});
	return `otpauth://totp/${label}?${params.toString()}`;
}
