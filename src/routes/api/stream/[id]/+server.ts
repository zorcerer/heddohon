import type { RequestHandler } from './$types';
import { proxyMedia, streamRequestFrom } from '$lib/server/proxy';
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
	const transcode: TranscodeRequest | null =
		settings?.transcode === true
			? { codec: settings.transcodeCodec, bitrateKbps: settings.transcodeBitrateKbps }
			: null;

	const req = streamRequestFrom(event);
	return proxyMedia(event, 'stream', (backend) =>
		backend.openStream(event.locals.session!.credential, event.params.id, req, transcode)
	);
};

export const GET = handler;
export const HEAD = handler;
