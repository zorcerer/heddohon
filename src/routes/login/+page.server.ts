import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { config } from '$lib/server/config';
import { createSession, signIn } from '$lib/server/auth';
import { isBackendKind, UpstreamError } from '$lib/server/backends';
import {
	clearLoginFailures,
	loginKeys,
	pruneLoginAttempts,
	refundLoginAttempt,
	reserveLoginAttempt
} from '$lib/server/ratelimit';
import { log, reason } from '$lib/server/log';

export const load: PageServerLoad = async () => {
	const cfg = config();
	return {
		appName: cfg.appName,
		hint: cfg.registrationHint,
		sessionMaxHours: cfg.sessionMaxHours,
		// Only the label and kind reach the browser. The upstream URL is
		// deliberately never serialised into the page: the client has no business
		// knowing where the music server lives, and cannot be tricked into
		// pointing the app somewhere else.
		servers: cfg.upstreams.map((upstream) => ({ kind: upstream.kind, label: upstream.label }))
	};
};

/**
 * Only allow paths on this origin, so `?next=` cannot become an open redirect.
 *
 * Testing `startsWith('/')` and `!startsWith('//')` is not enough. The URL
 * parser folds a backslash into a path separator for special schemes and strips
 * tab, CR and LF before parsing, so `/\evil.example` and `/<TAB>/evil.example`
 * both pass those two tests and both resolve to `evil.example`. Parsing against
 * a throwaway origin and keeping the result only if it stayed there is the check
 * that cannot be spelled around, since it asks the same parser the browser will.
 */
const NEXT_BASE = 'http://heddohon.invalid';

function safeNext(raw: FormDataEntryValue | null): string {
	if (typeof raw !== 'string') return '/';
	try {
		const url = new URL(raw, NEXT_BASE);
		if (url.origin !== NEXT_BASE) return '/';
		return `${url.pathname}${url.search}${url.hash}`;
	} catch {
		return '/';
	}
}

export const actions: Actions = {
	default: async (event) => {
		const data = await event.request.formData();
		const username = String(data.get('username') ?? '').trim();
		const password = String(data.get('password') ?? '');
		const requestedBackend = data.get('backend');
		const next = safeNext(data.get('next'));

		const servers = config().upstreams;
		const backend = isBackendKind(requestedBackend)
			? requestedBackend
			: servers.length === 1
				? servers[0].kind
				: null;

		if (!backend || !servers.some((server) => server.kind === backend)) {
			return fail(400, { username, backend: null, error: 'Choose which music server to sign in to.' });
		}
		if (!username || !password) {
			return fail(400, { username, backend, error: 'Enter your username and password.' });
		}

		/*
		 * Counted before the upstream is touched, so a throttled attacker costs
		 * the music server nothing at all. The keys are computed from the
		 * submitted username rather than a resolved account, because the whole
		 * point is to limit guesses at accounts that may not exist.
		 *
		 * The count happens here rather than after the answer comes back so that
		 * concurrent attempts cannot all pass a check none of them has yet paid
		 * for. Anything the upstream did not actually judge is handed back below.
		 */
		const keys = loginKeys(username, event.getClientAddress());
		const verdict = reserveLoginAttempt(keys);
		if (!verdict.allowed) {
			// Named at warn: a throttled address is the signal somebody is guessing,
			// and it is the line an operator points fail2ban at.
			log.warn('sign-in-throttled', {
				username,
				backend,
				address: event.getClientAddress(),
				retryAfter: verdict.retryAfter
			});
			return fail(429, {
				username,
				backend,
				error: `Too many sign-in attempts. Try again in ${Math.ceil(verdict.retryAfter / 60)} minute${verdict.retryAfter > 60 ? 's' : ''}.`
			});
		}

		let account;
		try {
			account = await signIn(backend, username, password);
		} catch (err) {
			if (err instanceof UpstreamError) {
				// Only a rejected credential counts. An unreachable music server is
				// not a wrong guess, and counting it would let an upstream outage
				// lock every user out, so that attempt goes back.
				if (err.kind === 'auth') pruneLoginAttempts();
				else refundLoginAttempt(keys);
				log.warn('sign-in-rejected', {
					username,
					backend,
					address: event.getClientAddress(),
					kind: err.kind,
					detail: err.kind === 'auth' ? undefined : err.message
				});
				// Do not distinguish "no such user" from "wrong password": that is
				// the upstream server's information to leak, not ours.
				const message =
					err.kind === 'auth'
						? 'That username and password were not accepted by the music server.'
						: err.message;
				return fail(err.kind === 'auth' ? 401 : 502, { username, backend, error: message });
			}
			// A fault on this side is not a guess either.
			refundLoginAttempt(keys);
			log.error('sign-in-failed', { username, backend, detail: reason(err) });
			return fail(500, { username, backend, error: 'Sign-in failed unexpectedly.' });
		}

		clearLoginFailures(keys);
		createSession(event, account, event.request.headers.get('user-agent'));
		log.info('signed-in', { username: account.username, backend, address: event.getClientAddress() });
		redirect(303, next);
	}
};
