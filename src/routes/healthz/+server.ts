import { json } from '@sveltejs/kit';
import { version } from '$app/environment';
import type { RequestHandler } from './$types';
import { ConfigError, config } from '$lib/server/config';

/**
 * Liveness probe for Docker/Kubernetes. Reports configuration validity without
 * revealing the upstream URLs — only which backend kinds are wired up.
 *
 * `build` is SvelteKit's per-build identifier. It exists to answer one
 * question that is otherwise guesswork behind a reverse proxy: did the thing I
 * just deployed actually replace the thing that was running? Curl this before
 * and after; if the value has not changed, the rebuild did not take, whatever
 * the deploy log said. It identifies nothing about the host or the library.
 */
export const GET: RequestHandler = async () => {
	try {
		const cfg = config();
		return json({
			status: 'ok',
			build: version,
			backends: cfg.upstreams.map((upstream) => upstream.kind),
			sessionMaxHours: cfg.sessionMaxHours
		});
	} catch (err) {
		return json(
			{
				status: 'misconfigured',
				error: err instanceof ConfigError ? err.message : 'Unknown configuration error'
			},
			{ status: 503 }
		);
	}
};
