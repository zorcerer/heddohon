import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { analysisStore } from '#lib/server/analysis/job.ts';
import { fileKeyOf } from '#lib/server/analysis/source.ts';
import { backendFor, UpstreamError } from '#lib/server/backends/index.ts';
import { config } from '#lib/server/config.ts';
import { refusedCredential } from '#lib/server/library.ts';

/*
 * What sound analysis measured of one song, for the player's Track details
 * (issue #333): its tempo, key and loudness, or `{ "sound": null }` where it
 * has not been measured, or not as the file is now.
 *
 * The results are shared by every account, so the song is looked up first
 * with the asking account's own login, and an id the music server does not
 * give that account answers 404 (SECURITY.md, **Sound analysis**). The
 * lookup also gives the file's size, format and length, which name the file
 * the result has to be of (`fileKeyOf`).
 */
export const GET: RequestHandler = async ({ locals, params }) => {
	const session = locals.session;
	if (!session) error(401, 'Not signed in');
	if (!config().analysis) error(404, 'Sound analysis is off');
	// Under 256 characters, as every id in a path (`hooks.server.ts`).
	const id = params.id;

	let song;
	try {
		[song] = await backendFor(session.account.backend).getSongs(session.credential, [id]);
	} catch (err) {
		await refusedCredential(locals, err);
		if (err instanceof UpstreamError) error(err.status === 404 ? 404 : 502, err.message);
		throw err;
	}
	if (!song || song.id !== id) error(404, 'No such song');

	const features = analysisStore().get({ backend: session.account.backend, songId: id, fileKey: fileKeyOf(song) });
	return json({
		sound: features && {
			tempo: features.tempo === null ? null : Math.round(features.tempo),
			key: features.key,
			loudness: Math.round(features.loudness * 10) / 10
		}
	});
};
