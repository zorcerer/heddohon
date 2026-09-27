import type { RequestHandler } from './$types';
import { coverShared, positionOf } from '$lib/server/share-media';

/** The cover of the track at position `n`. See `share-media.ts`. */
const handler: RequestHandler = (event) => coverShared(event, positionOf(event.params.n));

export const GET = handler;
export const HEAD = handler;
