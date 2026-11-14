import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { analysisStatus, jobSettings, resetAnalysis, retryFailedAnalysis, saveJobSettings, wakeAnalysisJob } from '#lib/server/analysis/job.ts';
import { PACES, type JobSettings } from '#lib/server/analysis/queue.ts';
import { backendFor } from '#lib/server/backends/index.ts';
import { config, fromEnvironment, saveSetup } from '#lib/server/config.ts';
import { log } from '#lib/server/log.ts';

/*
 * Sound analysis under Settings, Server (issue #319): what the job is doing,
 * and its controls. For an account the music server lists as an
 * administrator, asked of it on every request: the status names the song
 * being read from the whole library, and the controls spend the server's
 * processor. Settings asks every 5 seconds while the section is open.
 */

async function administrator(locals: App.Locals) {
	const session = locals.session;
	if (!session) error(401, 'Not signed in');
	if ((await backendFor(session.account.backend).isAdmin(session.credential)) !== true) {
		error(403, 'The music server does not list this account as an administrator.');
	}
	return session;
}

async function overview() {
	const on = config().analysis;
	const status = analysisStatus();
	return {
		on,
		fromEnvironment: fromEnvironment('HEDDOHON_ANALYSIS'),
		// The job looks at the switch once a minute; until it has, it is off all the same.
		status: status && !on ? { ...status, state: 'off' as const, current: null } : status,
		settings: await jobSettings()
	};
}

export const GET: RequestHandler = async ({ locals }) => {
	await administrator(locals);
	return json(await overview());
};

const MINUTES_IN_DAY = 1440;
const minute = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0 && (value as number) < MINUTES_IN_DAY;

/**
 * Changes the job's settings, each field optional: `paused` (boolean), `pace`
 * (`full`, `gentle` or `background`), `whileListening` (`pause` or
 * `continue`), `hours` (`{ from, to }` in minutes of the day, 0 to 1439, or
 * null for any time), and `on` (boolean), the feature's switch, refused with
 * 409 where `HEDDOHON_ANALYSIS` is set in the environment.
 */
export const PATCH: RequestHandler = async ({ locals, request }) => {
	const session = await administrator(locals);
	const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
	if (!body || typeof body !== 'object' || Array.isArray(body)) error(400, 'Expected an object');
	const change: Partial<JobSettings> = {};
	if ('paused' in body) {
		if (typeof body.paused !== 'boolean') error(400, 'paused must be a boolean');
		change.paused = body.paused;
	}
	if ('pace' in body) {
		if (!PACES.includes(body.pace as JobSettings['pace'])) error(400, `pace must be one of ${PACES.join(', ')}`);
		change.pace = body.pace as JobSettings['pace'];
	}
	if ('whileListening' in body) {
		if (body.whileListening !== 'pause' && body.whileListening !== 'continue') error(400, 'whileListening must be pause or continue');
		change.whileListening = body.whileListening;
	}
	if ('hours' in body) {
		const hours = body.hours as { from?: unknown; to?: unknown } | null;
		if (hours !== null && (typeof hours !== 'object' || !minute(hours.from) || !minute(hours.to))) {
			error(400, 'hours must be null or { from, to } in minutes of the day, 0 to 1439');
		}
		change.hours = hours === null ? null : { from: hours.from as number, to: hours.to as number };
	}
	if ('on' in body) {
		if (typeof body.on !== 'boolean') error(400, 'on must be a boolean');
		if (fromEnvironment('HEDDOHON_ANALYSIS')) error(409, 'HEDDOHON_ANALYSIS in the environment decides this.');
		// Off is the default, saved as no value, as Settings' Features saves it.
		saveSetup({ HEDDOHON_ANALYSIS: body.on ? 'true' : '' });
		log.warn('features-switched', { by: session.account.username, analysis: body.on });
		wakeAnalysisJob();
	}
	if (Object.keys(change).length > 0) await saveJobSettings(change, session.account.username);
	return json(await overview());
};

/**
 * `{ "action": "retry" }` has the songs that failed tried again;
 * `{ "action": "reset" }` removes `analysis.db` and starts the library again.
 */
export const POST: RequestHandler = async ({ locals, request }) => {
	const session = await administrator(locals);
	const body = (await request.json().catch(() => null)) as { action?: unknown } | null;
	if (body?.action === 'retry') retryFailedAnalysis(session.account.username);
	else if (body?.action === 'reset') resetAnalysis(session.account.username);
	else error(400, 'action must be retry or reset');
	return json(await overview());
};
