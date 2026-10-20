/**
 * Passkeys (WebAuthn Level 2), checked here without a library: the two
 * ceremonies need SHA-256, a signature check and a CBOR reader, and Node has
 * the first two. `@simplewebauthn/server` would have been the third runtime
 * dependency, with its own CBOR and ASN.1 packages behind it.
 *
 * Pure functions over what the browser sends. Which challenges are live, and
 * which passkeys an account holds, are in `twofactor.ts`.
 *
 * Attestation is not asked for (`attestation: 'none'`) and not checked: it
 * says which make of authenticator holds the key, which nothing here decides
 * by. What is checked, on both ceremonies: the type and the origin in the
 * client data, the challenge (by the caller), the relying party's id hash,
 * user presence, and on sign-in the signature over the authenticator data and
 * the client data's hash.
 */
import { createHash, createPublicKey, verify, type KeyObject } from 'node:crypto';
import { decodeCbor, type CborValue } from './cbor';

/** ES256, EdDSA (Ed25519) and RS256, in the order offered. */
export const ALGORITHMS = [-7, -8, -257] as const;
export type Algorithm = (typeof ALGORITHMS)[number];

/** A credential id is at most 1023 bytes (WebAuthn Level 3, section 4). */
const MAX_CREDENTIAL_ID_BYTES = 1023;
/** Generous bounds on the rest: a passkey's answer is a few hundred bytes. */
const MAX_CLIENT_DATA_BYTES = 4096;
const MAX_ATTESTATION_BYTES = 16 * 1024;
const MAX_AUTH_DATA_BYTES = 4096;
const MAX_SIGNATURE_BYTES = 1024;

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_AT = 0x40;

export class WebAuthnError extends Error {}

export function toBase64url(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString('base64url');
}

/** Decodes base64url text of at most `max` bytes, or throws. */
function bytesOf(value: unknown, max: number, what: string): Buffer {
	if (typeof value !== 'string' || !/^[A-Za-z0-9_-]*$/.test(value) || value.length > Math.ceil((max * 4) / 3)) {
		throw new WebAuthnError(`${what} is not base64url`);
	}
	const bytes = Buffer.from(value, 'base64url');
	if (bytes.length === 0 || bytes.length > max) throw new WebAuthnError(`${what} has the wrong length`);
	return bytes;
}

function sha256(data: Uint8Array | string): Buffer {
	return createHash('sha256').update(data).digest();
}

export interface ClientData {
	challenge: string;
}

/**
 * The client data's type, origin and challenge. `crossOrigin` true means the
 * ceremony ran in a frame on another site, which this app never does.
 */
function readClientData(raw: Buffer, type: 'webauthn.create' | 'webauthn.get', origin: string): ClientData {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw.toString('utf8'));
	} catch {
		throw new WebAuthnError('client data is not JSON');
	}
	const data = parsed as { type?: unknown; challenge?: unknown; origin?: unknown; crossOrigin?: unknown };
	if (data.type !== type) throw new WebAuthnError('client data type');
	if (data.origin !== origin) throw new WebAuthnError('client data origin');
	if (data.crossOrigin === true) throw new WebAuthnError('cross-origin ceremony');
	if (typeof data.challenge !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(data.challenge)) {
		throw new WebAuthnError('client data challenge');
	}
	return { challenge: data.challenge };
}

interface AuthData {
	flags: number;
	signCount: number;
	credentialId: Buffer | null;
	publicKey: Map<CborValue, CborValue> | null;
}

function readAuthData(authData: Buffer, rpId: string): AuthData {
	if (authData.length < 37) throw new WebAuthnError('authenticator data is short');
	if (!authData.subarray(0, 32).equals(sha256(rpId))) throw new WebAuthnError('relying party id');
	const flags = authData[32];
	if (!(flags & FLAG_UP)) throw new WebAuthnError('user not present');
	const signCount = authData.readUInt32BE(33);
	if (!(flags & FLAG_AT)) return { flags, signCount, credentialId: null, publicKey: null };

	// The attested credential: an AAGUID, the id's length and the id, then the
	// key in COSE. Extensions may follow the key; they are not read.
	if (authData.length < 55) throw new WebAuthnError('attested credential data is short');
	const idLength = authData.readUInt16BE(53);
	if (idLength === 0 || idLength > MAX_CREDENTIAL_ID_BYTES || 55 + idLength > authData.length) {
		throw new WebAuthnError('credential id length');
	}
	const credentialId = authData.subarray(55, 55 + idLength);
	const { value } = decodeCbor(authData, 55 + idLength);
	if (!(value instanceof Map)) throw new WebAuthnError('public key is not a COSE key');
	return { flags, signCount, credentialId, publicKey: value };
}

function bytesAt(key: Map<CborValue, CborValue>, label: number, length?: number): Buffer {
	const value = key.get(label);
	if (!(value instanceof Uint8Array) || (length !== undefined && value.length !== length)) {
		throw new WebAuthnError(`COSE key parameter ${label}`);
	}
	return Buffer.from(value);
}

/**
 * A COSE key (RFC 9053) as a key Node verifies with, for the three algorithms
 * offered. The key type and curve have to be the algorithm's.
 */
function coseKey(key: Map<CborValue, CborValue>): { algorithm: Algorithm; key: KeyObject } {
	const kty = key.get(1);
	const alg = key.get(3);
	if (alg === -7 && kty === 2 && key.get(-1) === 1) {
		const jwk = { kty: 'EC', crv: 'P-256', x: toBase64url(bytesAt(key, -2, 32)), y: toBase64url(bytesAt(key, -3, 32)) };
		return { algorithm: -7, key: createPublicKey({ key: jwk, format: 'jwk' }) };
	}
	if (alg === -8 && kty === 1 && key.get(-1) === 6) {
		const jwk = { kty: 'OKP', crv: 'Ed25519', x: toBase64url(bytesAt(key, -2, 32)) };
		return { algorithm: -8, key: createPublicKey({ key: jwk, format: 'jwk' }) };
	}
	if (alg === -257 && kty === 3) {
		const n = bytesAt(key, -1);
		// 2048 bits at least, as NIST SP 800-131A has it, and 4096 at most.
		if (n.length < 256 || n.length > 512) throw new WebAuthnError('RSA key size');
		const jwk = { kty: 'RSA', n: toBase64url(n), e: toBase64url(bytesAt(key, -2)) };
		return { algorithm: -257, key: createPublicKey({ key: jwk, format: 'jwk' }) };
	}
	throw new WebAuthnError('unsupported key type or algorithm');
}

export interface NewPasskey {
	challenge: string;
	/** base64url, as the browser names it. */
	credentialId: string;
	/** SubjectPublicKeyInfo, DER, base64url. */
	publicKey: string;
	algorithm: Algorithm;
	signCount: number;
	userVerified: boolean;
}

/** What `navigator.credentials.create()` answered, read and checked but for its challenge. */
export function readRegistration(input: unknown, origin: string, rpId: string): NewPasskey {
	const credential = input as { id?: unknown; type?: unknown; response?: { clientDataJSON?: unknown; attestationObject?: unknown } } | null;
	if (!credential || credential.type !== 'public-key' || !credential.response) throw new WebAuthnError('not a public key credential');
	const clientData = readClientData(
		bytesOf(credential.response.clientDataJSON, MAX_CLIENT_DATA_BYTES, 'client data'),
		'webauthn.create',
		origin
	);
	const attestation = decodeCbor(bytesOf(credential.response.attestationObject, MAX_ATTESTATION_BYTES, 'attestation')).value;
	const authDataValue = attestation instanceof Map ? attestation.get('authData') : null;
	if (!(authDataValue instanceof Uint8Array)) throw new WebAuthnError('attestation has no authenticator data');
	const authData = readAuthData(Buffer.from(authDataValue), rpId);
	if (!authData.credentialId || !authData.publicKey) throw new WebAuthnError('no attested credential');
	const id = bytesOf(credential.id, MAX_CREDENTIAL_ID_BYTES, 'credential id');
	if (!id.equals(authData.credentialId)) throw new WebAuthnError('credential id mismatch');
	const { algorithm, key } = coseKey(authData.publicKey);
	return {
		challenge: clientData.challenge,
		credentialId: toBase64url(id),
		publicKey: toBase64url(key.export({ format: 'der', type: 'spki' })),
		algorithm,
		signCount: authData.signCount,
		userVerified: (authData.flags & FLAG_UV) !== 0
	};
}

export interface Assertion {
	challenge: string;
	credentialId: string;
	/** The user handle the passkey was made with, if the authenticator returned it. */
	userHandle: string | null;
	clientData: Buffer;
	authData: Buffer;
	signature: Buffer;
}

/** What `navigator.credentials.get()` answered, read but not yet verified. */
export function readAssertion(input: unknown, origin: string): Assertion {
	const credential = input as {
		id?: unknown;
		type?: unknown;
		response?: { clientDataJSON?: unknown; authenticatorData?: unknown; signature?: unknown; userHandle?: unknown };
	} | null;
	if (!credential || credential.type !== 'public-key' || !credential.response) throw new WebAuthnError('not a public key credential');
	const response = credential.response;
	const clientData = bytesOf(response.clientDataJSON, MAX_CLIENT_DATA_BYTES, 'client data');
	const { challenge } = readClientData(clientData, 'webauthn.get', origin);
	const handle = response.userHandle;
	return {
		challenge,
		credentialId: toBase64url(bytesOf(credential.id, MAX_CREDENTIAL_ID_BYTES, 'credential id')),
		userHandle: typeof handle === 'string' && handle !== '' ? toBase64url(bytesOf(handle, 64, 'user handle')) : null,
		clientData,
		authData: bytesOf(response.authenticatorData, MAX_AUTH_DATA_BYTES, 'authenticator data'),
		signature: bytesOf(response.signature, MAX_SIGNATURE_BYTES, 'signature')
	};
}

/**
 * Checks an assertion's signature with the stored key, and the authenticator
 * data with it. Returns the new signature counter and whether the user was
 * verified (a PIN, a fingerprint), not only present.
 */
export function verifyAssertion(
	assertion: Assertion,
	stored: { publicKey: string; algorithm: number },
	rpId: string
): { signCount: number; userVerified: boolean } {
	const authData = readAuthData(assertion.authData, rpId);
	const key = createPublicKey({ key: Buffer.from(stored.publicKey, 'base64url'), format: 'der', type: 'spki' });
	const signed = Buffer.concat([assertion.authData, sha256(assertion.clientData)]);
	let valid: boolean;
	if (stored.algorithm === -7) valid = verify('sha256', signed, { key, dsaEncoding: 'der' }, assertion.signature);
	else if (stored.algorithm === -257) valid = verify('sha256', signed, key, assertion.signature);
	else if (stored.algorithm === -8) valid = verify(null, signed, key, assertion.signature);
	else throw new WebAuthnError('stored algorithm');
	if (!valid) throw new WebAuthnError('signature');
	return { signCount: authData.signCount, userVerified: (authData.flags & FLAG_UV) !== 0 };
}
