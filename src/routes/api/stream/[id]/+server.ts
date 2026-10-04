import type { RequestHandler } from './$types';
import { tiedToSession } from '$lib/server/auth';
import { proxyMedia, proxyTranscode, streamRequestFrom } from '$lib/server/proxy';
import type { TranscodeRequest } from '$lib/server/backends/types';

/**
 * Audio, as the file is on disk unless the account has asked otherwise.
 *
 * What is sent is decided from the account's stored settings, never from the
 * request. The mode in the query string is a cache key only: a browser caches
 * a stream per URL, so the original and a transcode need different URLs.
 */
const handler: RequestHandler = async (event) => tiedToSession(event.locals.session!, event.request.signal, await respond(event));

const respond = async (event: Parameters<RequestHandler>[0]): Promise<Response> => {
	const settings = event.locals.settings;
	const session = event.locals.session!;
	const transcode: TranscodeRequest | null =
		settings?.transcode === true
			? { codec: settings.transcodeCodec, bitrateKbps: settings.transcodeBitrateKbps }
			: null;

	const req = streamRequestFrom(event);
	const relayed = () =>
		// A transcode's length is Navidrome's estimate until it has finished once;
		// see `rangeIgnored` in proxy.ts.
		proxyMedia(
			event,
			'stream',
			(backend) => backend.openStream(session.credential, event.params.id, req, transcode),
			{ estimatedLength: transcode !== null }
		);
	if (!transcode) return relayed();

	// Read whole and answered in ranges from Heddohon; see `transcodes.ts`. The
	// read carries neither the browser's headers nor its abort signal: it goes
	// on after the request that started it.
	const key = [session.account.id, event.params.id, transcode.codec, transcode.bitrateKbps].join('\u0000');
	return proxyTranscode(
		event,
		key,
		(backend) => backend.openStream(session.credential, event.params.id, { method: 'GET', whole: true }, transcode),
		relayed
	);
};

export const GET = handler;
export const HEAD = handler;
