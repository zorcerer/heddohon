import type { RequestHandler } from './$types';
import { coverShared } from '$lib/server/share-media';

/** The shared item's own cover. See `share-media.ts`. */
const handler: RequestHandler = (event) => coverShared(event, null);

export const GET = handler;
export const HEAD = handler;
