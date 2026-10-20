/**
 * The browser's half of passkeys. The server sends options with binary
 * fields in base64url and reads the answer the same way (`webauthn.ts` on
 * the server). `PublicKeyCredential.parseCreationOptionsFromJSON` does this
 * conversion in Chrome 129 and Firefox 119, but not in Safari before 18.4,
 * which is under the browser floor (16.4), so it is done by hand.
 */

function toBytes(value: string): Uint8Array<ArrayBuffer> {
	const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
	const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

function fromBytes(buffer: ArrayBuffer | null): string | null {
	if (!buffer) return null;
	let binary = '';
	for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Whether this browser can use passkeys at all. */
export function passkeysAvailable(): boolean {
	return typeof window !== 'undefined' && typeof window.PublicKeyCredential === 'function' && !!navigator.credentials;
}

interface Descriptor {
	type: 'public-key';
	id: string;
}

interface CreationJson {
	challenge: string;
	rp: PublicKeyCredentialRpEntity;
	user: { id: string; name: string; displayName: string };
	pubKeyCredParams: PublicKeyCredentialParameters[];
	timeout: number;
	attestation: AttestationConveyancePreference;
	authenticatorSelection: AuthenticatorSelectionCriteria;
	excludeCredentials: Descriptor[];
}

interface RequestJson {
	challenge: string;
	rpId: string;
	timeout: number;
	userVerification: UserVerificationRequirement;
	allowCredentials: Descriptor[];
}

const descriptors = (list: Descriptor[]): PublicKeyCredentialDescriptor[] =>
	list.map((entry) => ({ type: 'public-key', id: toBytes(entry.id) }));

/** Makes a passkey with the options the server sent, and answers what it should store. */
export async function createPasskey(options: CreationJson): Promise<unknown> {
	const credential = (await navigator.credentials.create({
		publicKey: {
			...options,
			challenge: toBytes(options.challenge),
			user: { ...options.user, id: toBytes(options.user.id) },
			excludeCredentials: descriptors(options.excludeCredentials)
		}
	})) as PublicKeyCredential | null;
	if (!credential) throw new Error('No passkey was made.');
	const response = credential.response as AuthenticatorAttestationResponse;
	return {
		id: credential.id,
		type: credential.type,
		response: {
			clientDataJSON: fromBytes(response.clientDataJSON),
			attestationObject: fromBytes(response.attestationObject)
		}
	};
}

/** Signs the server's challenge with a passkey, and answers what it checks. */
export async function usePasskey(options: RequestJson): Promise<unknown> {
	const credential = (await navigator.credentials.get({
		publicKey: {
			...options,
			challenge: toBytes(options.challenge),
			allowCredentials: descriptors(options.allowCredentials)
		}
	})) as PublicKeyCredential | null;
	if (!credential) throw new Error('No passkey was used.');
	const response = credential.response as AuthenticatorAssertionResponse;
	return {
		id: credential.id,
		type: credential.type,
		response: {
			clientDataJSON: fromBytes(response.clientDataJSON),
			authenticatorData: fromBytes(response.authenticatorData),
			signature: fromBytes(response.signature),
			userHandle: fromBytes(response.userHandle)
		}
	};
}

/**
 * Words for what the browser threw. Closing its dialog is a `NotAllowedError`
 * and is not reported as a fault.
 */
export function passkeyFailure(err: unknown): string | null {
	if (err instanceof DOMException) {
		if (err.name === 'NotAllowedError' || err.name === 'AbortError') return null;
		if (err.name === 'InvalidStateError') return 'This device already holds a passkey for this account.';
		if (err.name === 'SecurityError') return 'This address cannot use passkeys. Open the server on its https address.';
	}
	return err instanceof Error && err.message ? err.message : 'The passkey did not work. Try again.';
}
