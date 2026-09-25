/**
 * Where last.fm sends the browser back after the user approves access.
 *
 * last.fm appends `token` to the callback URL the settings page gave it, which
 * already carried Navidrome's signed link token (`uid`) and Heddohon's `state`.
 * The token is handed to the music server's own callback, which exchanges it
 * for a Last.fm session and stores that against the user the link token names.
 * Navidrome's callback URL is on the music server, which the browser is not
 * meant to reach; this route is the part of it the browser can.
 *
 * A GET that changes state upstream, as an OAuth callback has to be. It sits
 * behind the session gate, and `state` must be the digest of this session's
 * account and the link token, so a link started by one account cannot be
 * completed by a link sent to another, and a link token lifted from
 * somewhere else is refused before anything reaches the music server. The
 * session cookie is `SameSite=Lax`, which a top-level navigation from last.fm
 * carries.
 *
 * `token` and `uid` are credentials for as long as they are valid (last.fm's
 * token is single-use, Navidrome's link token lasts 5 minutes), so the query
 * is kept out of the request log; see `redact` in `log.ts`.
 */
import { error, redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { backendFor } from '$lib/server/backends';
import { constantTimeEquals, linkStateDigest } from '$lib/server/crypto';
import { log, reason } from '$lib/server/log';

export const GET: RequestHandler = async ({ locals, url }) => {
	const session = locals.session;
	if (!session) error(401, 'Not signed in');
	const scrobblers = backendFor(session.account.backend).scrobblers;

	const uid = url.searchParams.get('uid') ?? '';
	const token = url.searchParams.get('token') ?? '';
	const state = url.searchParams.get('state') ?? '';
	// A Navidrome link token is a JWT of about 200 characters, a last.fm token
	// is 32, and the state digest is 43.
	const wellFormed =
		uid.length > 0 && uid.length <= 2048 && token.length > 0 && token.length <= 256 && state.length <= 64;
	const expected = linkStateDigest(`${session.account.id}\u0000${uid}`);
	if (!scrobblers || !wellFormed || !constantTimeEquals(state, expected)) {
		log.warn('scrobbler-failed', { step: 'lastfm-callback', detail: 'state or token refused' });
		redirect(303, '/settings?lastfm=refused');
	}

	let linked = false;
	try {
		linked = await scrobblers.finishLastfm(uid, token);
	} catch (err) {
		log.warn('scrobbler-failed', { step: 'lastfm-finish', detail: reason(err) });
	}
	if (!linked) redirect(303, '/settings?lastfm=failed');
	log.info('scrobbler-linked', { service: 'lastfm' });
	redirect(303, '/settings?lastfm=linked');
};
