import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { readAvatar } from '$lib/server/listening';
import { accountOfProfileLink, pageOf } from '$lib/server/profilepage';

/**
 * The picture on a profile page reached by its public link. Served as
 * `/api/profile/avatar/<handle>` serves it (invariant 6 in `AGENTS.md`), with
 * a short cache, so a withdrawn link stops showing it.
 */
export const GET: RequestHandler = async ({ params }) => {
	const accountId = await accountOfProfileLink(params.token);
	const page = accountId ? await pageOf(accountId) : null;
	const avatar = page ? await readAvatar(page.handle) : null;
	if (!avatar) error(404, 'Not found');
	return new Response(new Uint8Array(avatar), {
		headers: {
			'content-type': 'image/jpeg',
			'content-length': String(avatar.length),
			'cache-control': 'private, max-age=300',
			'content-security-policy': "default-src 'none'; sandbox",
			'content-disposition': 'inline',
			'x-content-type-options': 'nosniff'
		}
	});
};
