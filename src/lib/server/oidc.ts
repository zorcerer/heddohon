/**
 * Signing in through an OpenID Connect provider: Authelia, Authentik,
 * Keycloak, Pocket ID (issue #202).
 *
 *  1. Heddohon holds no password of its own, and the provider holds none of
 *     the music server's. An identity at the provider is therefore linked to
 *     an account once, from Settings, by a session of that account that has
 *     given a proof (`checkProof` in twofactor.ts). A sign-in through the
 *     provider then reaches the account through the credential stored at its
 *     last password sign-in, as a passkey on its own does, and the music
 *     server is asked first whether it still takes that credential.
 *  2. An identity is the ID token's `iss` and `sub`, which the provider gives
 *     to one person for good. Claims a person can change at the provider (a
 *     user name, an email address) are not read, and only the `openid` scope
 *     is asked for.
 *  3. The authorization code flow with PKCE (S256), `state` and `nonce`,
 *     held until the browser comes back in a cookie sealed under a key of its
 *     own. The ID token's signature is checked against the keys the provider
 *     publishes, by hand with node:crypto, as WebAuthn is in webauthn.ts.
 *  4. A link goes when the music server has another person under the
 *     account's name, and when the password changes (`storeAccount` in
 *     auth.ts): on Subsonic the two look the same.
 */
import { constants, createPublicKey, randomBytes, verify, createHash, type KeyObject } from 'node:crypto';
import { config, type OidcConfig } from './config';
import { cookieSecure, type CookieContext } from './auth';
import { constantTimeEquals, openJson, sealJson } from './crypto';
import { now, store } from './db';
import { log } from './log';
import { APP_VERSION } from './version';

const COOKIE = 'heddohon_oidc';
const PURPOSE = 'oidc-pending';
/** How long a browser has at the provider before the sign-in has to start again. */
const PENDING_TTL_MS = 10 * 60 * 1000;
const TIMEOUT_MS = 10_000;
/** The discovery document, the keys and a token answer are each a few KB. */
const MAX_BYTES = 256 * 1024;
const DISCOVERY_TTL_MS = 60 * 60 * 1000;
/**
 * The keys are read again when a token names one not held, at most this
 * often: a provider rotates its keys rarely, and an unknown `kid` is
 * otherwise a request to the provider for anyone with a pending sign-in.
 */
const JWKS_REFRESH_MS = 60_000;
/** The clock difference allowed between this server and the provider. */
const SKEW_MS = 60_000;
/** OpenID Connect Core 1.0, section 2: a `sub` is at most 255 ASCII characters. */
const MAX_SUBJECT = 255;
const MAX_TOKEN = 16 * 1024;

export type OidcPurpose = 'sign-in' | 'link';

/**
 * Why a return from the provider did not complete: it took longer than
 * `PENDING_TTL_MS` or came to another browser (`expired`), the person
 * turned it down there (`cancelled`), the provider could not be read
 * (`unreachable`), or something in it did not check out (`refused`).
 */
export type OidcFailure = 'expired' | 'cancelled' | 'unreachable' | 'refused';

class OidcError extends Error {
	constructor(
		message: string,
		readonly failure: OidcFailure
	) {
		super(message);
	}
}

// ---------------------------------------------------------------------------
// The provider

interface Provider {
	/** As the discovery document gives it, which is what a token's `iss` is compared with. */
	issuer: string;
	authorizationEndpoint: string;
	tokenEndpoint: string;
	jwksUri: string;
	/** `client_secret_basic` unless the provider lists only `client_secret_post`. */
	secretInBody: boolean;
}

let discovered: { issuer: string; provider: Provider; until: number } | null = null;

function httpUrl(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	try {
		const url = new URL(value);
		return (url.protocol === 'https:' || url.protocol === 'http:') && !url.hash ? url.toString() : null;
	} catch {
		return null;
	}
}

/**
 * A JSON object from the provider, read up to `MAX_BYTES`. Redirects are
 * refused: a token request followed to another host would take the client
 * secret with it.
 */
async function fetchJson(url: string, init: RequestInit = {}): Promise<{ status: number; body: Record<string, unknown> | null }> {
	let response: Response;
	try {
		response = await fetch(url, {
			...init,
			headers: {
				accept: 'application/json',
				'user-agent': `Heddohon/${APP_VERSION} (https://github.com/zorcerer/heddohon)`,
				...init.headers
			},
			redirect: 'error',
			signal: AbortSignal.timeout(TIMEOUT_MS)
		});
	} catch {
		throw new OidcError(`${new URL(url).host} did not answer`, 'unreachable');
	}
	const declared = Number(response.headers.get('content-length'));
	if (!response.body || (Number.isFinite(declared) && declared > MAX_BYTES)) {
		await response.body?.cancel().catch(() => undefined);
		return { status: response.status, body: null };
	}
	try {
		const reader = response.body.getReader();
		const chunks: Uint8Array[] = [];
		let total = 0;
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > MAX_BYTES) {
				await reader.cancel();
				return { status: response.status, body: null };
			}
			chunks.push(value);
		}
		const body: unknown = JSON.parse(Buffer.concat(chunks, total).toString('utf8'));
		return { status: response.status, body: body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null };
	} catch {
		return { status: response.status, body: null };
	}
}

/**
 * The provider's endpoints from its discovery document, held for an hour.
 * The document's `issuer` has to be the configured one, a trailing slash
 * aside, as OpenID Connect Discovery 1.0 section 4.3 asks.
 */
function provider(cfg: OidcConfig): Promise<Provider> {
	if (discovered && discovered.issuer === cfg.issuer && discovered.until > Date.now()) return Promise.resolve(discovered.provider);
	if (failedUntil > Date.now()) return Promise.reject(new OidcError('discovery failed a moment ago', 'unreachable'));
	discovering ??= discover(cfg)
		.catch((err) => {
			failedUntil = Date.now() + DISCOVERY_FAILED_MS;
			throw err;
		})
		.finally(() => (discovering = null));
	return discovering;
}

/**
 * A start is anonymous and unthrottled, so while the provider is down each
 * one would otherwise wait out `TIMEOUT_MS` on a request of its own. Starts
 * at the same moment share one, and a failure is held this long.
 */
const DISCOVERY_FAILED_MS = 30_000;
let discovering: Promise<Provider> | null = null;
let failedUntil = 0;

async function discover(cfg: OidcConfig): Promise<Provider> {
	const base = cfg.issuer.replace(/\/+$/, '');
	const { status, body } = await fetchJson(`${base}/.well-known/openid-configuration`);
	if (status !== 200 || !body) throw new OidcError(`discovery answered ${status}`, 'unreachable');
	const issuer = typeof body.issuer === 'string' ? body.issuer : '';
	if (issuer.replace(/\/+$/, '') !== base) throw new OidcError('discovery names another issuer', 'unreachable');
	const authorizationEndpoint = httpUrl(body.authorization_endpoint);
	const tokenEndpoint = httpUrl(body.token_endpoint);
	const jwksUri = httpUrl(body.jwks_uri);
	if (!authorizationEndpoint || !tokenEndpoint || !jwksUri) throw new OidcError('discovery is missing an endpoint', 'unreachable');
	const methods = Array.isArray(body.token_endpoint_auth_methods_supported) ? body.token_endpoint_auth_methods_supported : null;
	const found: Provider = {
		issuer,
		authorizationEndpoint,
		tokenEndpoint,
		jwksUri,
		secretInBody: methods !== null && !methods.includes('client_secret_basic') && methods.includes('client_secret_post')
	};
	discovered = { issuer: cfg.issuer, provider: found, until: Date.now() + DISCOVERY_TTL_MS };
	return found;
}

// ---------------------------------------------------------------------------
// The ID token

/**
 * The JWS algorithms taken (RFC 7518), by the key each needs. `none` and the
 * HMAC ones are not: an HMAC token would be signed with the client secret,
 * which a public client does not have.
 */
const ALGORITHMS: Record<string, { hash: string | null; type: 'rsa' | 'ec' | 'ed25519'; curve?: string; pss?: boolean }> = {
	RS256: { hash: 'sha256', type: 'rsa' },
	RS384: { hash: 'sha384', type: 'rsa' },
	RS512: { hash: 'sha512', type: 'rsa' },
	PS256: { hash: 'sha256', type: 'rsa', pss: true },
	PS384: { hash: 'sha384', type: 'rsa', pss: true },
	PS512: { hash: 'sha512', type: 'rsa', pss: true },
	ES256: { hash: 'sha256', type: 'ec', curve: 'prime256v1' },
	ES384: { hash: 'sha384', type: 'ec', curve: 'secp384r1' },
	ES512: { hash: 'sha512', type: 'ec', curve: 'secp521r1' },
	EdDSA: { hash: null, type: 'ed25519' }
};

type Algorithm = (typeof ALGORITHMS)[string];

let keySet: { uri: string; keys: Record<string, unknown>[]; fetchedAt: number } | null = null;

/** The published keys a token signed with `alg` could be checked against: the one its `kid` names, or every fitting one. */
function keysFitting(keys: Record<string, unknown>[], kid: string | null, name: string, alg: Algorithm): KeyObject[] {
	const fitting: KeyObject[] = [];
	for (const jwk of keys) {
		if (jwk.use === 'enc' || (jwk.alg !== undefined && jwk.alg !== name) || (kid !== null && jwk.kid !== kid)) continue;
		let key: KeyObject;
		try {
			key = createPublicKey({ key: jwk, format: 'jwk' });
		} catch {
			continue;
		}
		if (key.asymmetricKeyType !== alg.type) continue;
		const details = key.asymmetricKeyDetails;
		if (alg.type === 'ec' && details?.namedCurve !== alg.curve) continue;
		// RFC 7518, section 3.3: 2048 bits or more.
		if (alg.type === 'rsa' && (details?.modulusLength ?? 0) < 2048) continue;
		fitting.push(key);
	}
	return fitting;
}

async function signingKeys(found: Provider, kid: string | null, name: string, alg: Algorithm): Promise<KeyObject[]> {
	const held = keySet?.uri === found.jwksUri ? keySet : null;
	const keys = held ? keysFitting(held.keys, kid, name, alg) : [];
	if (keys.length > 0 || (held && Date.now() - held.fetchedAt < JWKS_REFRESH_MS)) return keys;
	const { status, body } = await fetchJson(found.jwksUri);
	if (status !== 200 || !body || !Array.isArray(body.keys)) throw new OidcError(`the keys answered ${status}`, 'unreachable');
	const published = body.keys.filter((key): key is Record<string, unknown> => !!key && typeof key === 'object').slice(0, 100);
	keySet = { uri: found.jwksUri, keys: published, fetchedAt: Date.now() };
	return keysFitting(published, kid, name, alg);
}

function part(segment: string): Record<string, unknown> {
	const value: unknown = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new OidcError('not an object', 'refused');
	return value as Record<string, unknown>;
}

/**
 * The `sub` of an ID token, once its signature and its claims are checked as
 * OpenID Connect Core 1.0, section 3.1.3.7 asks: the issuer, this client as
 * the audience (and as `azp` where there are several), the expiry, and the
 * nonce this sign-in sent.
 */
async function subjectOf(found: Provider, cfg: OidcConfig, token: string, nonce: string): Promise<string> {
	const segments = token.split('.');
	if (token.length > MAX_TOKEN || segments.length !== 3) throw new OidcError('not a JWS', 'refused');
	let header: Record<string, unknown>;
	let claims: Record<string, unknown>;
	try {
		header = part(segments[0]);
		claims = part(segments[1]);
	} catch {
		throw new OidcError('unreadable', 'refused');
	}
	const name = typeof header.alg === 'string' ? header.alg : '';
	const alg = Object.prototype.hasOwnProperty.call(ALGORITHMS, name) ? ALGORITHMS[name] : null;
	if (!alg) throw new OidcError(`algorithm ${name.slice(0, 16)}`, 'refused');
	// RFC 7515, section 4.1.11: an extension marked critical that is not
	// understood fails the token, and none is.
	if (header.crit !== undefined) throw new OidcError('critical header', 'refused');

	const keys = await signingKeys(found, typeof header.kid === 'string' ? header.kid : null, name, alg);
	const signed = Buffer.from(`${segments[0]}.${segments[1]}`);
	const signature = Buffer.from(segments[2], 'base64url');
	const valid = keys.some((key) => {
		try {
			if (alg.type === 'ec') return verify(alg.hash, signed, { key, dsaEncoding: 'ieee-p1363' }, signature);
			if (alg.pss) {
				return verify(alg.hash, signed, { key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST }, signature);
			}
			return verify(alg.hash, signed, key, signature);
		} catch {
			return false;
		}
	});
	if (!valid) throw new OidcError(keys.length === 0 ? 'no key for the token' : 'signature', 'refused');

	if (claims.iss !== found.issuer) throw new OidcError('issuer', 'refused');
	const audiences = typeof claims.aud === 'string' ? [claims.aud] : Array.isArray(claims.aud) ? claims.aud : [];
	if (!audiences.includes(cfg.clientId)) throw new OidcError('audience', 'refused');
	if ((audiences.length > 1 || claims.azp !== undefined) && claims.azp !== cfg.clientId) throw new OidcError('authorized party', 'refused');
	const moment = Date.now();
	if (typeof claims.exp !== 'number' || claims.exp * 1000 <= moment - SKEW_MS) throw new OidcError('expired', 'refused');
	if (typeof claims.iat !== 'number' || claims.iat * 1000 > moment + SKEW_MS) throw new OidcError('issued in the future', 'refused');
	if (typeof claims.nonce !== 'string' || !constantTimeEquals(claims.nonce, nonce)) throw new OidcError('nonce', 'refused');
	const subject = claims.sub;
	if (typeof subject !== 'string' || subject === '' || subject.length > MAX_SUBJECT) throw new OidcError('subject', 'refused');
	return subject;
}

// ---------------------------------------------------------------------------
// The round trip through the provider

interface Pending {
	state: string;
	nonce: string;
	verifier: string;
	/** The address the provider was told to send the browser back to, which the token request has to repeat. */
	redirectUri: string;
	purpose: OidcPurpose;
	/** The account a link is for; null for a sign-in. */
	accountId: string | null;
	next: string;
	startedAt: number;
}

function cookieName(event: CookieContext): string {
	return cookieSecure(event.url) ? `__Host-${COOKIE}` : COOKIE;
}

function clearPending(event: CookieContext): void {
	event.cookies.delete(`__Host-${COOKIE}`, { path: '/', secure: true });
	event.cookies.delete(COOKIE, { path: '/', secure: cookieSecure(event.url) });
}

/** The provider's name for the sign-in button and the messages, or null when none is configured. */
export function oidcLabel(): string | null {
	return config().oidc?.label ?? null;
}

/**
 * The provider's address to send the browser to, for a sign-in or for
 * linking `accountId`. What the return is checked against is held in this
 * browser's cookie. Null where the provider could not be read.
 */
export async function beginOidc(
	event: CookieContext,
	purpose: OidcPurpose,
	accountId: string | null,
	next: string
): Promise<string | null> {
	const cfg = config().oidc;
	if (!cfg) return null;
	let found: Provider;
	try {
		found = await provider(cfg);
	} catch (err) {
		log.warn('oidc-failed', { step: 'discovery', detail: err instanceof Error ? err.message : 'unknown' });
		return null;
	}
	const pending: Pending = {
		state: randomBytes(32).toString('base64url'),
		nonce: randomBytes(32).toString('base64url'),
		verifier: randomBytes(32).toString('base64url'),
		redirectUri: `${event.url.origin}/login/oidc/callback`,
		purpose,
		accountId,
		next,
		startedAt: Date.now()
	};
	const secure = cookieSecure(event.url);
	event.cookies.set(cookieName(event), sealJson(pending, PURPOSE), {
		path: '/',
		httpOnly: true,
		// Lax: the provider sends the browser back with a navigation from its own
		// site, which a Strict cookie is not sent with.
		sameSite: 'lax',
		secure,
		maxAge: Math.floor(PENDING_TTL_MS / 1000)
	});

	const url = new URL(found.authorizationEndpoint);
	url.searchParams.set('response_type', 'code');
	url.searchParams.set('client_id', cfg.clientId);
	url.searchParams.set('redirect_uri', pending.redirectUri);
	url.searchParams.set('scope', 'openid');
	url.searchParams.set('state', pending.state);
	url.searchParams.set('nonce', pending.nonce);
	url.searchParams.set('code_challenge', createHash('sha256').update(pending.verifier).digest('base64url'));
	url.searchParams.set('code_challenge_method', 'S256');
	return url.toString();
}

export type OidcReturn =
	| { ok: true; purpose: OidcPurpose; accountId: string | null; issuer: string; subject: string; next: string }
	| { ok: false; failure: OidcFailure; purpose: OidcPurpose | null; next: string };

/** RFC 6749, appendix B: the client id and secret are form-encoded before they go into the Basic header. */
function formEncoded(value: string): string {
	return encodeURIComponent(value).replace(/%20/g, '+');
}

/**
 * Completes a return from the provider to `/login/oidc/callback`: the state
 * this browser holds, the code exchanged for an ID token, and the token
 * checked. The pending sign-in is used up whatever the outcome.
 */
export async function finishOidc(event: CookieContext): Promise<OidcReturn> {
	const blob = event.cookies.get(cookieName(event));
	clearPending(event);
	let pending: Pending | null = null;
	try {
		pending = blob ? openJson<Pending>(blob, PURPOSE) : null;
	} catch {
		pending = null;
	}
	if (!pending || Date.now() - pending.startedAt > PENDING_TTL_MS) {
		return { ok: false, failure: 'expired', purpose: pending?.purpose ?? null, next: pending?.next ?? '/' };
	}
	const { purpose, next } = pending;
	const refused = (failure: OidcFailure, step: string, detail: string): OidcReturn => {
		log.warn(failure === 'unreachable' ? 'oidc-failed' : 'oidc-rejected', { purpose, step, detail });
		return { ok: false, failure, purpose, next };
	};

	const params = event.url.searchParams;
	const state = params.get('state') ?? '';
	if (state.length > 128 || !constantTimeEquals(state, pending.state)) return refused('refused', 'state', 'state does not match');
	const error = params.get('error');
	if (error !== null) {
		// `access_denied` where the person said no. Kept short and to the
		// characters RFC 6749 allows in it, since it reaches the log.
		const code = error.slice(0, 64).replace(/[^\x20-\x21\x23-\x5b\x5d-\x7e]/g, '?');
		return refused(code === 'access_denied' ? 'cancelled' : 'refused', 'authorize', code);
	}
	const code = params.get('code') ?? '';
	if (code === '' || code.length > 2048) return refused('refused', 'authorize', 'no code');

	const cfg = config().oidc;
	if (!cfg) return refused('refused', 'config', 'no provider configured');
	try {
		const found = await provider(cfg);
		const form = new URLSearchParams({
			grant_type: 'authorization_code',
			code,
			redirect_uri: pending.redirectUri,
			code_verifier: pending.verifier
		});
		const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
		if (cfg.clientSecret === null) {
			form.set('client_id', cfg.clientId);
		} else if (found.secretInBody) {
			form.set('client_id', cfg.clientId);
			form.set('client_secret', cfg.clientSecret);
		} else {
			headers.authorization = `Basic ${Buffer.from(`${formEncoded(cfg.clientId)}:${formEncoded(cfg.clientSecret)}`).toString('base64')}`;
		}
		const { status, body } = await fetchJson(found.tokenEndpoint, { method: 'POST', headers, body: form });
		if (status !== 200 || typeof body?.id_token !== 'string') {
			const said = typeof body?.error === 'string' ? body.error.slice(0, 64).replace(/[^\x20-\x7e]/g, '?') : 'no id_token';
			return refused(status >= 500 ? 'unreachable' : 'refused', 'token', `HTTP ${status}: ${said}`);
		}
		const subject = await subjectOf(found, cfg, body.id_token, pending.nonce);
		return { ok: true, purpose, accountId: pending.accountId, issuer: found.issuer, subject, next };
	} catch (err) {
		if (err instanceof OidcError) return refused(err.failure, 'token', err.message);
		throw err;
	}
}

// ---------------------------------------------------------------------------
// Links

export interface OidcLink {
	createdAt: number;
	lastUsedAt: number | null;
}

/** The account's link, if it has one to the provider configured now. */
export async function linkOf(accountId: string): Promise<OidcLink | null> {
	const row = await (await store()).get<{ created_at: number; last_used_at: number | null }>(
		'SELECT created_at, last_used_at FROM oidc_links WHERE account_id = ?',
		accountId
	);
	if (!row) return null;
	return { createdAt: Number(row.created_at), lastUsedAt: row.last_used_at === null ? null : Number(row.last_used_at) };
}

/**
 * Links the identity to the account, in place of any it had. False where
 * another account holds the identity: it has to be unlinked there first.
 */
export async function linkIdentity(accountId: string, issuer: string, subject: string): Promise<boolean> {
	const database = await store();
	const holder = await database.get<{ account_id: string }>(
		'SELECT account_id FROM oidc_links WHERE issuer = ? AND subject = ?',
		issuer,
		subject
	);
	if (holder && holder.account_id !== accountId) return false;
	await database.run('DELETE FROM oidc_links WHERE account_id = ?', accountId);
	try {
		await database.run(
			'INSERT INTO oidc_links (account_id, issuer, subject, created_at, last_used_at) VALUES (?, ?, ?, ?, NULL)',
			accountId,
			issuer,
			subject,
			now()
		);
	} catch {
		// The same identity linked to another account in between: the unique
		// key on (issuer, subject) refused this one.
		return false;
	}
	return true;
}

/** Removes the account's link. False where it had none. */
export async function unlinkIdentity(accountId: string): Promise<boolean> {
	return (await (await store()).run('DELETE FROM oidc_links WHERE account_id = ?', accountId)).changes > 0;
}

/** The account an identity is linked to, or null, noting the use. */
export async function accountOfIdentity(issuer: string, subject: string): Promise<string | null> {
	const row = await (await store()).get<{ account_id: string }>(
		'UPDATE oidc_links SET last_used_at = ? WHERE issuer = ? AND subject = ? RETURNING account_id',
		now(),
		issuer,
		subject
	);
	return row?.account_id ?? null;
}
