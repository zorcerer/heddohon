import { json } from '@sveltejs/kit';
import { version } from '$app/environment';
import type { RequestHandler } from './$types';
import { ConfigError, config } from '$lib/server/config';
import { log, reason } from '$lib/server/log';
import { store } from '$lib/server/db';

/**
 * Liveness probe for Docker/Kubernetes. Reports whether the configuration is
 * valid and which backend kinds are configured, not their URLs. A failure is
 * reported without its cause.
 *
 * `build` is SvelteKit's per-build identifier, for checking behind a reverse
 * proxy that a deploy replaced what was running: if the value is the same
 * before and after, it did not. It says nothing about the host or the library.
 */
export const GET: RequestHandler = async () => {
	let cfg;
	try {
		cfg = config();
	} catch (err) {
		// The message names the variable and its value, usually the internal
		// music-server address, which hooks.server.ts withholds from every other
		// path. The probe once gave `HEDDOHON_SUBSONIC_URL=10.0.0.10:4533` to
		// anybody who asked. The detail stays in the log.
		log.error('config-invalid', { detail: reason(err), path: '/healthz' });
		return json(
			{ status: err instanceof ConfigError ? 'misconfigured' : 'error' },
			{ status: 503 }
		);
	}

	/*
	 * The database is asked too, so a PostgreSQL server that is down or refuses
	 * the password fails the container's HEALTHCHECK. The reason goes to the
	 * log only: a connection error can name the host.
	 */
	try {
		// Three seconds, inside the image's HEALTHCHECK timeout of five.
		await Promise.race([
			(async () => (await store()).get('SELECT 1 AS ok'))(),
			new Promise((_, reject) => setTimeout(() => reject(new Error('no answer within 3s')), 3000))
		]);
	} catch (err) {
		log.error('database-unavailable', { detail: reason(err), path: '/healthz' });
		return json({ status: 'database-unavailable' }, { status: 503 });
	}

	return json({
		status: 'ok',
		build: version,
		backends: cfg.upstreams.map((upstream) => upstream.kind),
		database: cfg.database.kind,
		sessionMaxHours: cfg.sessionMaxHours
	});
};
