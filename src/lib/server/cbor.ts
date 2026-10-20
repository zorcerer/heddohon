/**
 * A CBOR reader (RFC 8949) for the two things WebAuthn encodes in it: the
 * attestation object a new passkey arrives in, and the COSE public key inside
 * its authenticator data.
 *
 * Only what those use: integers, byte and text strings, arrays, maps, and the
 * simple values false, true and null. Indefinite lengths, tags and floats are
 * refused; a browser does not send them in either structure. The input comes
 * from a signed-in browser, so it is bounded: 32 levels deep, and every length
 * checked against the bytes that are left before anything is allocated.
 */

export type CborValue = number | bigint | string | boolean | null | Uint8Array | CborValue[] | Map<CborValue, CborValue>;

export class CborError extends Error {}

const MAX_DEPTH = 32;

/** Reads one item from `bytes` at `offset`, and says where it ended. */
export function decodeCbor(bytes: Uint8Array, offset = 0): { value: CborValue; end: number } {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let at = offset;

	function need(count: number): void {
		if (count < 0 || at + count > bytes.length) throw new CborError('truncated');
	}

	function argument(info: number): number {
		if (info < 24) return info;
		if (info === 24) {
			need(1);
			return bytes[at++];
		}
		if (info === 25) {
			need(2);
			const value = view.getUint16(at);
			at += 2;
			return value;
		}
		if (info === 26) {
			need(4);
			const value = view.getUint32(at);
			at += 4;
			return value;
		}
		if (info === 27) {
			need(8);
			const value = view.getBigUint64(at);
			at += 8;
			if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new CborError('integer too large');
			return Number(value);
		}
		throw new CborError('indefinite length or reserved value');
	}

	function item(depth: number): CborValue {
		if (depth > MAX_DEPTH) throw new CborError('too deep');
		need(1);
		const initial = bytes[at++];
		const major = initial >> 5;
		const info = initial & 0x1f;
		switch (major) {
			case 0:
				return argument(info);
			case 1:
				return -1 - argument(info);
			case 2: {
				const length = argument(info);
				need(length);
				const value = bytes.slice(at, at + length);
				at += length;
				return value;
			}
			case 3: {
				const length = argument(info);
				need(length);
				const value = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(at, at + length));
				at += length;
				return value;
			}
			case 4: {
				const length = argument(info);
				// Each element takes at least a byte.
				need(length);
				const out: CborValue[] = [];
				for (let i = 0; i < length; i++) out.push(item(depth + 1));
				return out;
			}
			case 5: {
				const length = argument(info);
				need(length * 2);
				const out = new Map<CborValue, CborValue>();
				for (let i = 0; i < length; i++) {
					const key = item(depth + 1);
					if (typeof key !== 'number' && typeof key !== 'string') throw new CborError('map key');
					if (out.has(key)) throw new CborError('duplicate map key');
					out.set(key, item(depth + 1));
				}
				return out;
			}
			case 7:
				if (info === 20) return false;
				if (info === 21) return true;
				if (info === 22) return null;
				throw new CborError('unsupported simple value');
			default:
				throw new CborError('tags are not read');
		}
	}

	const value = item(0);
	return { value, end: at };
}
