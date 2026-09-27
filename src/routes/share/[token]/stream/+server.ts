import type { RequestHandler } from './$types';
import { streamShared } from '$lib/server/share-media';

/** The first track, which is the song itself for a song link. See `share-media.ts`. */
const handler: RequestHandler = (event) => streamShared(event, 0);

export const GET = handler;
export const HEAD = handler;
