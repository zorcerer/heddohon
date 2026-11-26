import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { cachedCoverHeaders } from '#lib/server/covercache.ts';
import { readPresenceCover } from '#lib/server/presencecover.ts';

/*
 * A cover for the desktop app's Discord activity, fetched by Discord without
 * a sign-in (a public route; `presencecover.ts`). The token names the cover;
 * it is served from the cover cache alone, or answers 404.
 */
const handler: RequestHandler = async ({ params, request }) => {
	const hit = await readPresenceCover(params.token);
	if (!hit) error(404, 'Not found');
	// Public: Discord's proxy keeps it, for no longer than the link works.
	const headers = cachedCoverHeaders(hit.contentType, hit.etag, 'public, max-age=86400');
	if (request.headers.get('if-none-match') === hit.etag) return new Response(null, { status: 304, headers });
	return new Response(request.method === 'HEAD' ? null : new Uint8Array(hit.body), { status: 200, headers });
};

export const GET = handler;
export const HEAD = handler;
