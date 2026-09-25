import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { config } from '$lib/server/config';
import { createSession, knownDevice, rememberDevice, signIn } from '$lib/server/auth';

const MAX_USERNAME = 256;
const MAX_PASSWORD = 1024;
import { backendFor, isBackendKind, UpstreamError } from '$lib/server/backends';
import { safeNext } from '$lib/server/next';
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
		// Only the label and kind reach the browser. The upstream URL is
		// deliberately never serialised into the page: the client has no business
		// knowing where the music server lives, and cannot be tricked into
		// pointing the app somewhere else.
		servers: await Promise.all(
			cfg.upstreams.map(async (upstream) => ({
				kind: upstream.kind,
				label: upstream.label,
				// Off by default on Jellyfin, so it is only offered where the server
				// says it is on. The answer is cached in the adapter.
				quickConnect: (await backendFor(upstream.kind).quickConnect?.enabled()) ?? false
			}))
		)
	};
};

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
		 * Bounded before anything is counted. The username becomes a key in the
		 * throttle table, and with no bound an anonymous visitor wrote a row the
		 * size of the request body, 400 KB, for every distinct name sent. No
		 * music server has accounts with names this long.
		 */
		if (username.length > MAX_USERNAME || password.length > MAX_PASSWORD) {
			return fail(400, {
				username: username.slice(0, MAX_USERNAME),
				backend,
				error: 'That username and password were not accepted by the music server.'
			});
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
		const keys = loginKeys(backend, username, event.getClientAddress(), knownDevice(event, backend, username));
		const verdict = await reserveLoginAttempt(keys);
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
				if (err.kind === 'auth') await pruneLoginAttempts();
				else await refundLoginAttempt(keys);
				log.warn('sign-in-rejected', {
					username,
					backend,
					address: event.getClientAddress(),
					kind: err.kind,
					detail: err.kind === 'auth' ? undefined : err.message
				});
				// Do not distinguish "no such user" from "wrong password": that is
				// the upstream server's information to leak, not ours.
				//
				// Anything else gets a fixed message. `err.message` can carry the
				// Subsonic server's own error text, the configured timeout or a fetch
				// failure, and this response goes to a visitor who is not signed in.
				// The detail is in the log line above.
				const message =
					err.kind === 'auth'
						? 'That username and password were not accepted by the music server.'
						: 'The music server could not complete the sign-in. Try again shortly.';
				return fail(err.kind === 'auth' ? 401 : 502, { username, backend, error: message });
			}
			// A fault on this side is not a guess either.
			await refundLoginAttempt(keys);
			log.error('sign-in-failed', { username, backend, detail: reason(err) });
			return fail(500, { username, backend, error: 'Sign-in failed unexpectedly.' });
		}

		await clearLoginFailures(keys);
		await createSession(event, account, event.request.headers.get('user-agent'));
		rememberDevice(event, backend, account.username);
		log.info('signed-in', { username: account.username, backend, address: event.getClientAddress() });
		redirect(303, next);
	}
};
