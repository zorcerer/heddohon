import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { config } from '$lib/server/config';
import { readAvatar } from '$lib/server/listening';

/** A handle as `listening.ts` makes one: 12 random bytes in hex. */
const HANDLE = /^[0-9a-f]{24}$/;

/**
 * A profile's picture, for any signed-in account. It was uploaded by another
 * account, so it is served as proxied media is (invariant 6 in `AGENTS.md`): a
 * fixed image type, never sniffed, under a policy that keeps it from being a
 * document.
 *
 * The address carries the picture's version (`?v=`), which this route does
 * not read: a new picture has a new address, so a browser may keep this one.
 */
export const GET: RequestHandler = async ({ locals, params }) => {
	if (!locals.session) error(401, 'Not signed in');
	const cfg = config();
	if (!cfg.listeners || !cfg.remoteControl) error(404, 'Not found');
	if (!HANDLE.test(params.handle)) error(404, 'Not found');

	const avatar = await readAvatar(params.handle);
	if (!avatar) error(404, 'Not found');

	return new Response(new Uint8Array(avatar), {
		headers: {
			'content-type': 'image/jpeg',
			'content-length': String(avatar.length),
			'cache-control': 'private, max-age=86400, immutable',
			'content-security-policy': "default-src 'none'; sandbox",
			'content-disposition': 'inline',
			'x-content-type-options': 'nosniff'
		}
	});
};
