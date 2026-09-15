import { json } from '@sveltejs/kit';
import { version } from '$app/environment';
import type { RequestHandler } from './$types';
import { ConfigError, config } from '$lib/server/config';
import { log, reason } from '$lib/server/log';

/**
 * Liveness probe for Docker/Kubernetes. Reports configuration validity without
 * revealing the upstream URLs, only which backend kinds are wired up. A failure
 * reports that there is one and nothing about its cause.
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
		// The message names the offending variable and its value, and that value
		// is usually the internal music-server address. hooks.server.ts withholds
		// it from every other path for exactly that reason and then exempts this
		// one, so the probe used to hand `HEDDOHON_SUBSONIC_URL=10.0.0.10:4533`
		// to anybody who asked. Which variable is at fault stays in the log.
		log.error('config-invalid', { detail: reason(err), path: '/healthz' });
		return json(
			{ status: err instanceof ConfigError ? 'misconfigured' : 'error' },
			{ status: 503 }
		);
	}
};
