import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { analysisAccountStatus } from '#lib/server/analysis/account.ts';
import { albumAnalysis, analyseAlbum } from '#lib/server/analysis/job.ts';
import { backendFor, UpstreamError } from '#lib/server/backends/index.ts';
import { config } from '#lib/server/config.ts';
import { refusedCredential } from '#lib/server/library.ts';
import { log } from '#lib/server/log.ts';

/*
 * One album analysed now, from its menu (issue #330). For an administrator
 * of the music server, asked of it on each request, while sound analysis is
 * on and an analysis account is named for this music server.
 *
 * The album's songs are read with the administrator's own login: the
 * analysis account only reads their audio (`AnalysisSource` lists songs and
 * reads audio, and nothing else). Ids in the path are under 256 characters,
 * as every id in a path (`hooks.server.ts`).
 */

async function album(locals: App.Locals, id: string) {
	const session = locals.session!;
	try {
		return await backendFor(session.account.backend).getAlbum(session.credential, id);
	} catch (err) {
		await refusedCredential(locals, err);
		if (err instanceof UpstreamError) error(err.status === 404 ? 404 : 502, err.message);
		throw err;
	}
}

/**
 * What the album's menu offers: `{ offered: false }` to anyone else, and to
 * an administrator `{ offered: true, measured, total, waiting }`. Not a 403
 * for an account that is not an administrator: every account's menu asks.
 */
export const GET: RequestHandler = async ({ locals, params }) => {
	const session = locals.session;
	if (!session) error(401, 'Not signed in');
	if (!config().analysis || !(await analysisAccountStatus(session.account.backend))) return json({ offered: false });
	if ((await backendFor(session.account.backend).isAdmin(session.credential)) !== true) return json({ offered: false });
	const found = await album(locals, params.id);
	return json({ offered: true, ...albumAnalysis(session.account.backend, found, String(session.account.id)) });
};

/**
 * Puts the album's songs ahead of the library, measured again whatever is
 * stored for them. 202 when queued; 409 while this administrator has an
 * album waiting.
 */
export const POST: RequestHandler = async ({ locals, params }) => {
	const session = locals.session;
	if (!session) error(401, 'Not signed in');
	if ((await backendFor(session.account.backend).isAdmin(session.credential)) !== true) {
		error(403, 'The music server does not list this account as an administrator.');
	}
	if (!config().analysis) error(404, 'Sound analysis is off');
	if (!(await analysisAccountStatus(session.account.backend))) error(404, 'No analysis account is named');
	const found = await album(locals, params.id);
	const by = String(session.account.id);
	const outcome = analyseAlbum(session.account.backend, found, by);
	if (outcome === 'waiting') error(409, 'An album you asked for is still being analysed.');
	if (outcome === 'empty') error(404, 'The album has no songs to analyse');
	log.info('analysis-album-asked', { by: session.account.username, album: params.id, songs: found.songs.length });
	return json(albumAnalysis(session.account.backend, found, by), { status: 202 });
};
