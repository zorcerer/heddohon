import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { backendFor, UpstreamError } from '$lib/server/backends';
import { PLAYLIST_EXPORT_FORMATS, playlistFile, type PlaylistExportFormat } from '$lib/server/playlistfiles';

/**
 * A playlist the account can read, as a file: `m3u` (each entry by its file
 * where the music server names one), `m3u-titles` (by artist and title) or
 * `csv`. See `playlistfiles.ts`.
 */
export const GET: RequestHandler = async ({ locals, params, url }) => {
	const session = locals.session;
	if (!session) error(401, 'Not signed in');
	if (params.id.length >= 256) error(400, 'id is too long');

	const format = url.searchParams.get('format') ?? 'm3u';
	if (!PLAYLIST_EXPORT_FORMATS.includes(format as PlaylistExportFormat)) {
		error(400, `format must be one of ${PLAYLIST_EXPORT_FORMATS.join(', ')}`);
	}

	const backend = backendFor(session.account.backend);
	try {
		const [playlist, paths] = await Promise.all([
			backend.getPlaylist(session.credential, params.id),
			format === 'm3u' ? backend.getPlaylistPaths(session.credential, params.id) : Promise.resolve([])
		]);
		const body = playlistFile(playlist, format as PlaylistExportFormat, paths);
		// The name as a file name: what a file system would refuse, and quotes, made dashes.
		const base = playlist.name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-').trim().slice(0, 100) || 'playlist';
		const extension = format === 'csv' ? 'csv' : 'm3u8';
		return new Response(body, {
			headers: {
				'content-type': format === 'csv' ? 'text/csv; charset=utf-8' : 'audio/x-mpegurl; charset=utf-8',
				'content-disposition': `attachment; filename="playlist.${extension}"; filename*=UTF-8''${encodeURIComponent(base)}.${extension}`,
				'cache-control': 'private, no-store'
			}
		});
	} catch (err) {
		if (err instanceof UpstreamError) error(err.kind === 'forbidden' ? 403 : err.status === 404 ? 404 : 502, err.message);
		throw err;
	}
};
