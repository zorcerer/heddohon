/**
 * Addresses a speaker or a TV can play a track from.
 *
 * A Chromecast or an AirPlay receiver fetches the stream itself, without this
 * browser's session cookie, so `/api/stream/<id>` answers it 401. A cast
 * address carries its authority in the path instead: `/cast/<token>`, where
 * the token names one track, the account and session that asked for it, and
 * when it stops working, signed with a key of its own (`castDigest`).
 *
 * Nothing is stored. A token is checked on every request: the signature, the
 * expiry, and that the session it names is still live, so signing out,
 * being signed out from Settings and the session's own expiry end it. A stream
 * in progress is tied to the session as the browser's own are.
 */
import { castDigest, constantTimeEquals } from './crypto';
import type { AuthenticatedSession } from './auth';

/**
 * How long an address works. A queue cast at bedtime plays for hours; the
 * browser asks again for tracks it reaches after this. Never past the
 * session's own expiry.
 */
export const CAST_TTL_MS = 6 * 60 * 60 * 1000;

export interface CastGrant {
	accountId: string;
	handle: string;
	songId: string;
	expiresAt: number;
}

/** The address a receiver plays `songId` from, for this session. */
export function castPath(session: AuthenticatedSession, songId: string): string {
	const expiresAt = Math.min(Date.now() + CAST_TTL_MS, session.expiresAt);
	const payload = [
		Buffer.from(session.account.id).toString('base64url'),
		session.handle,
		Buffer.from(songId).toString('base64url'),
		expiresAt.toString(36)
	].join('.');
	return `/cast/${payload}.${castDigest(payload)}`;
}

/** What a token grants, or null for one that is malformed, forged or expired. */
export function readCastToken(token: string): CastGrant | null {
	const parts = token.split('.');
	if (parts.length !== 5 || token.length > 1024) return null;
	const [account, handle, song, expiry, signature] = parts;
	const payload = parts.slice(0, 4).join('.');
	if (!constantTimeEquals(signature, castDigest(payload))) return null;
	const expiresAt = Number.parseInt(expiry, 36);
	if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return null;
	return {
		accountId: Buffer.from(account, 'base64url').toString(),
		handle,
		songId: Buffer.from(song, 'base64url').toString(),
		expiresAt
	};
}
