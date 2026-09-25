import type { RequestHandler } from './$types';
import { proxyMedia, proxyTranscode, streamRequestFrom } from '$lib/server/proxy';
import type { TranscodeRequest } from '$lib/server/backends/types';

/**
 * Audio, as the file sits on disk unless the account has asked for otherwise.
 *
 * What is sent is decided here from the account's stored settings, never from
 * the request. The client does put the mode in the query string, and that value
 * is read for exactly one purpose: a browser caches a stream response per URL,
 * so switching between the original and a transcode has to be a different URL
 * or the first one answers for both. It is a cache key, not an instruction.
 */
const handler: RequestHandler = async (event) => {
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
	// read asks for the whole transcode and does not carry the browser's
	// headers or its abort signal: it goes on after the request that started it.
	const key = [session.account.id, event.params.id, transcode.codec, transcode.bitrateKbps].join('\u0000');
	return proxyTranscode(
		event,
		key,
		(backend) => backend.openStream(session.credential, event.params.id, { method: 'GET' }, transcode),
		relayed
	);
};

export const GET = handler;
export const HEAD = handler;
