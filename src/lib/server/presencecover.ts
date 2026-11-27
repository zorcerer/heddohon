/**
 * A cover Discord can fetch for the desktop app's activity (issue #358), where
 * an administrator turned on `HEDDOHON_DISCORD_COVERS`.
 *
 * Discord's servers fetch an activity's image themselves, with no sign-in, so
 * `/api/cover/<id>` answers them 401. The link carries its authority instead,
 * as a cast address does (`cast.ts`): `/api/presence-cover/<token>`, where the
 * token names one cover in one account's cache scope, its size, and when it
 * stops working, a day on. It is sealed (`sealJson`, under a key of its own),
 * not only signed: the scope holds a Jellyfin user's id, and the link is
 * shown to Discord.
 *
 * Served from the cover cache alone, never from the music server: a link is
 * made only for a cover the account's own browser has already read into the
 * cache, and a link opens no stored credential (invariant 2). A cover since
 * swept from the cache answers 404, and Discord shows none. Nothing is
 * stored, and the switch turned off ends every link.
 */
import { config } from './config';
import { coverScope, holdsCover, readCover, type CachedCover, type CoverScope } from './covercache';
import { openJson, sealJson } from './crypto';
import type { BackendKind } from '#lib/types.ts';

const PURPOSE = 'presence-cover';

/** How long a link works. Discord fetches it as the activity is set, and its proxy keeps the image. */
const TTL_MS = 24 * 60 * 60 * 1000;

/**
 * The sizes looked for in the cache, in order. Discord draws the image at
 * 120px at most. The player's panel and the media controls read 256 and 512.
 */
const SIZES = [256, 512, 384, 192, 768];

/** A sealed token is about 200 characters; anything much longer is not one. */
const MAX_TOKEN = 1024;

interface Grant {
	b: BackendKind;
	v: string | null;
	c: string;
	s: number;
	e: number;
}

/**
 * The path of a link to `coverId` as this account's cache holds it, or null:
 * the switch is off, or no size of it is cached.
 */
export async function presenceCoverPath(
	account: { backend: BackendKind; id: string; remoteUserId: string | null },
	coverId: string
): Promise<string | null> {
	if (!config().discordCovers) return null;
	const scope = coverScope(account);
	for (const size of SIZES) {
		if (!(await holdsCover(scope, coverId, size))) continue;
		const grant: Grant = { b: scope.backend, v: scope.viewer, c: coverId, s: size, e: Date.now() + TTL_MS };
		return `/api/presence-cover/${sealJson(grant, PURPOSE)}`;
	}
	return null;
}

/** The cover a token names, from the cache, or null: off, malformed, forged, expired, or no longer cached. */
export async function readPresenceCover(token: string): Promise<CachedCover | null> {
	if (!config().discordCovers || token.length > MAX_TOKEN) return null;
	let grant: Grant;
	try {
		grant = openJson<Grant>(token, PURPOSE);
	} catch {
		return null;
	}
	if (typeof grant?.e !== 'number' || grant.e <= Date.now() || typeof grant.c !== 'string' || typeof grant.s !== 'number') return null;
	if (grant.b !== 'subsonic' && grant.b !== 'jellyfin') return null;
	const scope: CoverScope = { backend: grant.b, viewer: typeof grant.v === 'string' ? grant.v : null };
	return readCover(scope, grant.c, grant.s);
}
