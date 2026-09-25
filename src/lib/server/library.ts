/**
 * Thin wrapper the page loaders use, so every route handles a dead or angry
 * music server the same way instead of each inventing its own error shape.
 */
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
 * Runs a library call and converts upstream failures into SvelteKit errors.
 * An authentication failure invalidates every session for the account, because
 * the stored credential itself has stopped working.
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
			if (err.kind === 'auth' && event.locals.session) {
				await destroyAllSessions(event.locals.session.account.id);
				error(401, 'Your music server credentials are no longer valid. Please sign in again.');
			}
			error(err.kind === 'not_found' ? 404 : 502, err.message);
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
