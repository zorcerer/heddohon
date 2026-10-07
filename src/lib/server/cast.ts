/**
 * Addresses a speaker or a TV can play a track from.
 *
 * A Chromecast or an AirPlay receiver fetches the stream itself, without the
 * session cookie, so `/api/stream/<id>` answers it 401. A cast address carries
 * its authority in the path: `/cast/<token>`, where the token names one track,
 * the account and session that asked, and when it stops working, signed with
 * its own key (`castDigest`).
 *
 * Nothing is stored. Every request checks the signature, the expiry and that
 * the session named is still live, so signing out, being signed out from
 * Settings and the session's expiry end it. A stream in progress is tied to
 * the session as the browser's own are.
 */
import { castDigest, constantTimeEquals } from './crypto';
import type { AuthenticatedSession } from './auth';

/**
 * How long an address works, and never past the session's expiry. The browser
 * asks again for tracks a long queue reaches after this.
 */
const CAST_TTL_MS = 6 * 60 * 60 * 1000;

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
