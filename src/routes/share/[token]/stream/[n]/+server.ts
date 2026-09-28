import type { RequestHandler } from './$types';
import { positionOf, streamShared } from '$lib/server/share-media';

/** The track at position `n` of a shared album or playlist. See `share-media.ts`. */
const handler: RequestHandler = (event) => streamShared(event, positionOf(event.params.n));

export const GET = handler;
export const HEAD = handler;
