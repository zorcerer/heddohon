import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { sessionByHandle, tiedToSession } from '$lib/server/auth';
import { readCastToken } from '$lib/server/cast';
import { proxyMedia, proxyTranscode, streamRequestFrom } from '$lib/server/proxy';
import { getSettings } from '$lib/server/settings';
import type { TranscodeRequest } from '$lib/server/backends/types';

/**
 * A track for a speaker or a TV, by a cast address; see `cast.ts`. Public, as
 * the receiver has no cookie: the token is the authority, and every refusal
 * (malformed, forged, expired, or a session that has ended) is the same 404.
 *
 * What is sent follows the account's settings, as `/api/stream` does.
 */
const handler: RequestHandler = async (event) => {
	const grant = readCastToken(event.params.token);
	if (!grant) error(404, 'Not found');
	const session = await sessionByHandle(grant.accountId, grant.handle);
	if (!session) error(404, 'Not found');

	// The media proxy reads the session from `locals`, as for the browser.
	event.locals.session = session;
	const settings = await getSettings(session.account.id);
	const transcode: TranscodeRequest | null = settings.transcode
		? { codec: settings.transcodeCodec, bitrateKbps: settings.transcodeBitrateKbps }
		: null;

	const req = streamRequestFrom(event);
	const relayed = () =>
		proxyMedia(event, 'stream', (backend) => backend.openStream(session.credential, grant.songId, req, transcode), {
			estimatedLength: transcode !== null
		});
	const response = !transcode
		? await relayed()
		: await proxyTranscode(
				event,
				[session.account.id, grant.songId, transcode.codec, transcode.bitrateKbps].join('\u0000'),
				(backend) => backend.openStream(session.credential, grant.songId, { method: 'GET' }, transcode),
				relayed
			);
	// A receiver has no reason to keep a copy, and one kept would outlive the
	// session that the address belongs to.
	response.headers.set('cache-control', 'private, no-store');
	return tiedToSession(session, event.request.signal, response);
};

export const GET = handler;
export const HEAD = handler;
