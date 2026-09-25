/**
 * Navidrome's own API, for linking an account to Last.fm and ListenBrainz.
 *
 * The Subsonic API has no call for this. Navidrome's web interface does it
 * through `/api/lastfm/link` and `/api/listenbrainz/link`, which take the JWT
 * that `POST /auth/login` issues rather than Subsonic's salted token, and this
 * module calls the same endpoints. They are the interface's own API and are
 * not documented as stable; checked against Navidrome's source on 2026-09-25
 * (`adapters/lastfm/auth_router.go`, `adapters/listenbrainz/auth_router.go`).
 *
 * What Heddohon holds: nothing it did not hold before. A ListenBrainz token is
 * passed to Navidrome once and not stored here. Last.fm needs no key from the
 * user: the API key and secret are Navidrome's own configuration, and the user
 * approves access on last.fm, which returns to Heddohon (see
 * `routes/settings/lastfm/+server.ts`) and is handed on to Navidrome.
 *
 * Another Subsonic server answers `/auth/login` with something other than a
 * Navidrome token, and is reported as having neither service.
 */
import { upstreamFor } from '../config';
import { tokenDigest } from '../crypto';
import { UpstreamError, upstreamFetch, upstreamUrl } from './http';
import type { StoredCredential } from './types';

export type ScrobblerService = 'lastfm' | 'listenbrainz';

/** One service as this account sees it. `available` is false where the server has it turned off. */
export type ServiceLink = { available: false } | { available: true; linked: boolean };

export type ScrobblerLinks = Record<ScrobblerService, ServiceLink>;

/** What starting a Last.fm link returns: the two values the last.fm approval page needs. */
export interface LastfmStart {
	apiKey: string;
	/** Navidrome's signed token for this user, valid for 5 minutes. It comes back in the callback. */
	linkToken: string;
}

/**
 * How long a Navidrome session token is reused.
 *
 * Navidrome limits `POST /auth/login` to 5 requests per 20 seconds per client
 * address by default (`AuthRequestLimit`, `AuthWindowLength`), and every
 * account signed in to Heddohon reaches it from Heddohon's one address. A
 * token per settings page load would lock the whole deployment out of the
 * endpoint after five loads. Navidrome's tokens last 48 hours
 * (`SessionTimeout`); 30 minutes keeps one far inside that.
 */
const SESSION_TTL_MS = 30 * 60_000;
const MAX_SESSIONS = 1000;

/**
 * Session tokens, keyed by a digest of the username and password rather than
 * by account, so a password change finds no entry and signs in afresh. The
 * promise is held, so concurrent callers share one login, and a rejected one
 * is dropped.
 */
const sessions = new Map<string, { token: Promise<string | null>; until: number }>();

function subsonicCreds(cred: StoredCredential): { username: string; password: string } {
	if (cred.kind !== 'subsonic') throw new Error('Wrong credential kind for Navidrome');
	return cred;
}

function base(): string {
	return upstreamFor('subsonic').url;
}

/** A Navidrome session token, or null when the server is not Navidrome. */
function session(cred: StoredCredential, fresh = false): Promise<string | null> {
	const { username, password } = subsonicCreds(cred);
	const key = tokenDigest(`navidrome\u0000${username}\u0000${password}`);
	const held = sessions.get(key);
	if (!fresh && held && held.until > Date.now()) return held.token;

	const token = login(username, password);
	sessions.delete(key);
	sessions.set(key, { token, until: Date.now() + SESSION_TTL_MS });
	if (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value!);
	token.catch(() => {
		if (sessions.get(key)?.token === token) sessions.delete(key);
	});
	return token;
}

async function login(username: string, password: string): Promise<string | null> {
	const response = await upstreamFetch(upstreamUrl(base(), '/auth/login'), {
		method: 'POST',
		headers: { 'content-type': 'application/json', accept: 'application/json' },
		body: JSON.stringify({ username, password })
	});
	if (response.status === 401) {
		throw new UpstreamError('The music server rejected these credentials', 401, 'auth');
	}
	if (response.status === 429) {
		throw new UpstreamError('The music server is limiting sign-ins; try again shortly', 429);
	}
	const body = (await response.json().catch(() => null)) as { token?: unknown } | null;
	if (!response.ok || typeof body?.token !== 'string' || body.token === '') return null;
	return body.token;
}

/**
 * One call to Navidrome's API with the session token, signing in again once
 * if Navidrome no longer accepts a remembered token. Resolves to null when
 * the server is not Navidrome.
 */
async function nativeCall(
	cred: StoredCredential,
	path: string,
	init: { method?: string; body?: unknown } = {}
): Promise<Response | null> {
	for (const fresh of [false, true]) {
		const token = await session(cred, fresh);
		if (token === null) return null;
		const response = await upstreamFetch(upstreamUrl(base(), path), {
			method: init.method ?? 'GET',
			headers: {
				accept: 'application/json',
				'x-nd-authorization': `Bearer ${token}`,
				...(init.body === undefined ? {} : { 'content-type': 'application/json' })
			},
			body: init.body === undefined ? undefined : JSON.stringify(init.body)
		});
		if (response.status !== 401 || fresh) return response;
		await response.body?.cancel().catch(() => undefined);
	}
	return null;
}

async function jsonOf(response: Response): Promise<Record<string, unknown>> {
	const body = await response.json().catch(() => null);
	return body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
}

/**
 * Where each service stands for this account, or null when the server is not
 * Navidrome.
 *
 * Navidrome mounts each router only when the service is enabled, so a 404 is
 * a service turned off. Last.fm also needs an API key and secret configured,
 * and reports its key as empty without them. A Navidrome before 0.62.0,
 * which had no signed link token and sent the user id in the callback, is
 * treated as not offering Last.fm, since Heddohon passes back only what Navidrome
 * signed.
 */
export async function scrobblerLinks(cred: StoredCredential): Promise<ScrobblerLinks | null> {
	const [lastfm, listenbrainz] = await Promise.all([
		nativeCall(cred, '/api/lastfm/link'),
		nativeCall(cred, '/api/listenbrainz/link')
	]);
	if (lastfm === null || listenbrainz === null) return null;

	const read = async (response: Response, needsKey: boolean): Promise<ServiceLink> => {
		if (!response.ok) {
			await response.body?.cancel().catch(() => undefined);
			return { available: false };
		}
		const body = await jsonOf(response);
		if (needsKey && (!body.apiKey || !body.linkToken)) return { available: false };
		return { available: true, linked: body.status === true };
	};
	return { lastfm: await read(lastfm, true), listenbrainz: await read(listenbrainz, false) };
}

/**
 * Hands a ListenBrainz user token to Navidrome, which checks it with
 * ListenBrainz before storing it. Resolves to false when ListenBrainz says the
 * token is not valid.
 */
export async function linkListenBrainz(cred: StoredCredential, token: string): Promise<boolean> {
	const response = await nativeCall(cred, '/api/listenbrainz/link', { method: 'PUT', body: { token } });
	if (response === null) throw new UpstreamError('This music server cannot link ListenBrainz', 404, 'not_found');
	const body = await jsonOf(response);
	if (response.status === 400) return false;
	if (!response.ok) throw new UpstreamError(`Music server returned HTTP ${response.status}`, 502);
	return body.status === true;
}

export async function unlinkScrobbler(cred: StoredCredential, service: ScrobblerService): Promise<void> {
	const response = await nativeCall(cred, `/api/${service}/link`, { method: 'DELETE' });
	if (response === null || response.status === 404) {
		throw new UpstreamError('This music server cannot link that service', 404, 'not_found');
	}
	await response.body?.cancel().catch(() => undefined);
	if (!response.ok) throw new UpstreamError(`Music server returned HTTP ${response.status}`, 502);
}

/** The API key and a fresh signed link token, or null when Last.fm is off. */
export async function startLastfm(cred: StoredCredential): Promise<LastfmStart | null> {
	const response = await nativeCall(cred, '/api/lastfm/link');
	if (response === null || !response.ok) {
		await response?.body?.cancel().catch(() => undefined);
		return null;
	}
	const body = await jsonOf(response);
	if (typeof body.apiKey !== 'string' || body.apiKey === '') return null;
	if (typeof body.linkToken !== 'string' || body.linkToken === '') return null;
	return { apiKey: body.apiKey, linkToken: body.linkToken };
}

/**
 * Hands the token last.fm returned to Navidrome, with Navidrome's own signed
 * link token, which is how Navidrome knows whose account it is for. The
 * endpoint takes no session. Resolves to false when Navidrome refuses either.
 */
export async function finishLastfm(linkToken: string, token: string): Promise<boolean> {
	const response = await upstreamFetch(
		upstreamUrl(base(), '/api/lastfm/link/callback', { uid: linkToken, token })
	);
	await response.body?.cancel().catch(() => undefined);
	return response.ok;
}
