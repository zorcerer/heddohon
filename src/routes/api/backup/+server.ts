import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { backendFor } from '$lib/server/backends';
import { BackupBusyError, BackupTooLargeError, makeBackup } from '$lib/server/backup';
import { log } from '$lib/server/log';

/**
 * The database as a ZIP; see `backup.ts`.
 *
 * For an account the music server lists as an administrator, asked of it on
 * each request, as for a cover fill. "Not known" (a Subsonic server without
 * `getUser`) is refused too: the archive holds every account's rows.
 *
 * A POST, so the origin check in `hooks.server.ts` applies. As a GET, a link
 * on another site could have had a signed-in administrator's browser start
 * one.
 */
export const POST: RequestHandler = async ({ locals }) => {
	const session = locals.session;
	if (!session) error(401, 'Not signed in');
	if ((await backendFor(session.account.backend).isAdmin(session.credential)) !== true) {
		error(403, 'The music server does not list this account as an administrator.');
	}

	let backup;
	try {
		backup = await makeBackup();
	} catch (err) {
		if (err instanceof BackupBusyError) {
			return new Response(JSON.stringify({ message: 'A backup is being made. Try again in a moment.' }), {
				status: 429,
				headers: { 'content-type': 'application/json', 'retry-after': '5' }
			});
		}
		if (err instanceof BackupTooLargeError) error(409, err.message);
		throw err;
	}

	// Who took a copy of every account's rows, and how much.
	log.warn('backup-made', { account: session.account.id, bytes: backup.zip.byteLength, ...backup.tables });
	return new Response(backup.zip as BodyInit, {
		headers: {
			'content-type': 'application/zip',
			'content-length': String(backup.zip.byteLength),
			'content-disposition': `attachment; filename="${backup.name}"`,
			'cache-control': 'private, no-store',
			'x-content-type-options': 'nosniff'
		}
	});
};
