/** What the page loaders call, so every route handles a failing music server the same way. */
import { error, type ServerLoadEvent } from '@sveltejs/kit';
import { backendFor, UpstreamError, type MediaBackend } from './backends';
import { destroyAllSessions } from './auth';
import type { StoredCredential } from './backends/types';
import { log, reason } from './log';

export interface LibraryContext {
	backend: MediaBackend;
	credential: StoredCredential;
	/** The signed-in account, for anything remembered per account. */
	accountId: string;
}

export function libraryContext(locals: App.Locals): LibraryContext {
	const session = locals.session;
	if (!session) error(401, 'Not signed in');
	return {
		backend: backendFor(session.account.backend),
		credential: session.credential,
		accountId: session.account.id
	};
}

/**
 * Ends every session for the account when the music server refused the stored
 * credential.
 *
 * The same rule as `library()` below and `proxyMedia`, for the JSON handlers
 * that do their own error mapping: a refused credential is the account's
 * sessions' end, whoever noticed it. `forbidden` is not this: an id the account
 * may not read says nothing about the credential.
 *
 * It answers the request too, with the 401 the client reads as a sign-out.
 * Ending the sessions and leaving the status to each handler let most of them
 * answer 502 for it (#270), which the player took for an upstream failure.
 */
export async function refusedCredential(locals: App.Locals, err: unknown): Promise<void> {
	if (!(err instanceof UpstreamError) || err.kind !== 'auth') return;
	const session = locals.session;
	if (!session) return;
	await destroyAllSessions(session.account.id);
	error(401, 'Your music server credentials are no longer valid. Please sign in again.');
}

/**
 * Runs a library call and converts upstream failures into SvelteKit errors. An
 * authentication failure ends every session for the account: the stored
 * credential has stopped working.
 */
export async function library<T>(
	event: Pick<ServerLoadEvent, 'locals'>,
	run: (ctx: LibraryContext) => Promise<T>
): Promise<T> {
	const ctx = libraryContext(event.locals);
	try {
		return await run(ctx);
	} catch (err) {
		if (err instanceof UpstreamError) {
			await refusedCredential(event.locals, err);
			error(err.kind === 'not_found' ? 404 : err.kind === 'forbidden' ? 403 : 502, err.message);
		}
		throw err;
	}
}

/** Runs several library calls, tolerating individual failures. */
export async function librarySettled<T extends Record<string, Promise<unknown>>>(
	calls: T
): Promise<{ [K in keyof T]: Awaited<T[K]> | null }> {
	const entries = Object.entries(calls);
	const results = await Promise.allSettled(entries.map(([, promise]) => promise));
	const out: Record<string, unknown> = {};
	results.forEach((result, index) => {
		const key = entries[index][0];
		if (result.status === 'fulfilled') {
			out[key] = result.value;
		} else {
			// A home page that loses one shelf is far better than one that 502s.
			log.warn('section-failed', { section: key, detail: reason(result.reason) });
			out[key] = null;
		}
	});
	return out as { [K in keyof T]: Awaited<T[K]> | null };
}
