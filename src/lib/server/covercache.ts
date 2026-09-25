/**
 * An on-disk cache for cover art.
 *
 * Every cover the browser asks for is otherwise fetched from the music server,
 * which resizes it on demand. A browser caches what it has already seen, so the
 * cost falls on first sight: a new device, a cleared cache, a private window,
 * or the part of the library you have not scrolled to yet. That is the case
 * this removes. The second device in a house gets the same covers off the local
 * disk instead of asking Navidrome to render them again.
 *
 * Only cover art is cached. Audio is not: a library is far larger than any cap
 * worth setting, the browser already caches what it plays, and a local copy of
 * the music is a different thing to be responsible for than a local copy of the
 * sleeve.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { readdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { config } from './config';
import { log, reason } from './log';
import type { BackendKind } from '$lib/types';

/**
 * Content types kept, and the extension each is stored under.
 *
 * The stored file is named for what it is, so the directory can be read with an
 * ordinary file browser, and the extension is what the content type is
 * recovered from on the way back out. Anything not on this list is served
 * straight through and never written. The proxy already refuses to describe a
 * cover as anything but an image; SVG is an image by content type and a
 * scriptable document by behaviour, and it is absent here deliberately.
 */
const EXTENSIONS: Record<string, string> = {
	'image/jpeg': 'jpg',
	'image/png': 'png',
	'image/webp': 'webp',
	'image/gif': 'gif',
	'image/avif': 'avif'
};

const TYPES: Record<string, string> = Object.fromEntries(
	Object.entries(EXTENSIONS).map(([type, ext]) => [ext, type])
);

/**
 * Largest single cover kept. Navidrome renders a 1024px sleeve at 150-400KB, so
 * this is two orders above the working case and exists to bound the buffer a
 * request holds, not to reject ordinary artwork.
 */
export const MAX_ENTRY_BYTES = 8 * 1024 * 1024;

/**
 * How much may be written between sweeps, as a fraction of the cap, and the
 * floor under that in bytes.
 *
 * This was a count of writes (one sweep per 25) and the directory settled well
 * above the cap: measured at a 1MB cap with 19KB covers, 120 requests left
 * 1.43MB on disk, since a sweep only ran once 25 more files had landed. Bigger
 * covers would have overshot further. Sweeping on bytes written instead holds
 * the directory within max(256KB, cap/16) of the cap whatever a cover weighs:
 * the same measurement now settles at 1.20MB, and a 512MB cap sweeps every
 * 32MB. The floor is there so a very small cap does not sweep on every write,
 * and a sweep stats every file in the directory.
 */
const SWEEP_FRACTION = 16;
const SWEEP_MIN_BYTES = 256 * 1024;
let bytesSinceSweep = 0;
/** One sweep at a time. A write that arrives during one skips it. */
let sweeping = false;

function root(): string | null {
	const { coverCacheBytes, dataDir } = config();
	return coverCacheBytes > 0 ? join(dataDir, 'covers') : null;
}

/**
 * The file name for one cover at one size.
 *
 * Named for the music server's own id, so the file beside a Navidrome album is
 * that album's cover and the directory can be read directly. Ids are not
 * trusted to be file names: only this shape passes through unchanged, and
 * anything else is replaced by a hash of itself, which keeps an id from naming
 * a path and keeps two ids from claiming one file.
 *
 * The backend leads the name. A Subsonic id and a Jellyfin id are two
 * namespaces, an installation can be configured with one of each, and both are
 * 32-character hex in practice, so nothing else in the name separates them.
 */
const PLAIN_ID = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * Who a cached cover belongs to.
 *
 * The key used to be backend, id and size, on the reasoning that two accounts
 * on one music server see the same artwork so there is nothing to separate.
 * That holds for Navidrome, which serves one library to every user. It does not
 * hold for Jellyfin, which restricts libraries per user: a shared key hands a
 * restricted library's artwork to any account that can name the item id,
 * because a cache hit is answered before the upstream is consulted and so the
 * upstream's own check never runs.
 */
export interface CoverScope {
	backend: BackendKind;
	/** The upstream user, or null where every account sees one library. */
	viewer: string | null;
}

export function coverScope(account: {
	backend: BackendKind;
	id: string;
	remoteUserId: string | null;
}): CoverScope {
	if (account.backend !== 'jellyfin') return { backend: account.backend, viewer: null };
	return { backend: 'jellyfin', viewer: account.remoteUserId ?? account.id };
}

/**
 * Always 16 hex characters, so the field has a fixed width. A variable-width
 * one would let an id of `u<16 hex>-<real id>`, which `PLAIN_ID` admits, be
 * read back as another viewer's tag and collide with their entry. The viewer is
 * an upstream user id and this becomes a filename, so it is hashed rather than
 * used verbatim.
 */
function viewerTag(viewer: string | null): string {
	return createHash('sha256')
		.update(viewer ?? 'shared')
		.digest('hex')
		.slice(0, 16);
}

export function cacheKey(scope: CoverScope, id: string, size: number): string {
	const safe =
		PLAIN_ID.test(id) && id !== '.' && id !== '..'
			? id
			: createHash('sha256').update(id).digest('hex').slice(0, 32);
	const backend = scope.backend === 'jellyfin' ? 'jellyfin' : 'subsonic';
	return `${backend}-${viewerTag(scope.viewer)}-${safe}-${size}`;
}

export interface CachedCover {
	body: Buffer;
	contentType: string;
	/**
	 * Identifies this stored file to a revalidating browser. A cover is fixed
	 * for its id and size, so the length is enough to tell one stored body from
	 * another after a clear and a re-fetch.
	 */
	etag: string;
}

/**
 * The stored covers, by key, with the extension each is stored under.
 *
 * A lookup tried each of the five extensions in turn until one opened, so a
 * PNG cover cost a failed open before it was read, and a cover not yet cached
 * cost five before the music server was asked. The index is read from the
 * directory once, on first use, and kept by the writes, the sweep and the
 * clear in this process. A file removed from outside is dropped from it when
 * reading it fails; one added from outside is not seen until a restart, and is
 * fetched and written again in the meantime.
 */
let index: Promise<Map<string, string>> | null = null;

function storedFiles(dir: string): Promise<Map<string, string>> {
	index ??= readdir(dir).then(
		(names) => {
			const files = new Map<string, string>();
			for (const name of names) {
				const dot = name.lastIndexOf('.');
				const ext = name.slice(dot + 1);
				// A `.part` file is a write in progress.
				if (dot > 0 && TYPES[ext]) files.set(name.slice(0, dot), ext);
			}
			return files;
		},
		// The directory does not exist until the first cover is written.
		() => new Map<string, string>()
	);
	return index;
}

/** The index key of a stored file, from its path. */
function keyOf(path: string): string {
	const name = basename(path);
	return name.slice(0, name.lastIndexOf('.'));
}

/** Returns a cached cover, or null when there is not one. */
export async function readCover(
	scope: CoverScope,
	id: string,
	size: number
): Promise<CachedCover | null> {
	const dir = root();
	if (!dir) return null;
	const key = cacheKey(scope, id, size);
	const files = await storedFiles(dir);
	const ext = files.get(key);
	if (ext) {
		try {
			const body = await readFile(join(dir, `${key}.${ext}`));
			log.debug('cover-hit', { key, bytes: body.byteLength });
			return { body, contentType: TYPES[ext], etag: `"${key}-${body.byteLength}"` };
		} catch {
			// Removed from outside since it was indexed.
			files.delete(key);
		}
	}
	log.debug('cover-miss', { key });
	return null;
}

/**
 * Stores a cover. Failures are swallowed: a cache that cannot write is a slow
 * cache rather than a broken page, and a full disk must not take the library
 * down with it.
 */
export async function writeCover(
	scope: CoverScope,
	id: string,
	size: number,
	contentType: string,
	body: Buffer
): Promise<void> {
	const dir = root();
	if (!dir) return;
	const ext = EXTENSIONS[contentType.split(';')[0].trim().toLowerCase()];
	if (!ext || body.byteLength === 0 || body.byteLength > MAX_ENTRY_BYTES) return;

	try {
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		const key = cacheKey(scope, id, size);
		const target = join(dir, `${key}.${ext}`);
		// Written beside the target and renamed, so a reader never opens half a
		// file. The suffix keeps two writers for the same cover apart.
		const temp = `${target}.${process.pid}-${Date.now()}.part`;
		await writeFile(temp, body);
		await rename(temp, target).catch(async (err) => {
			await unlink(temp).catch(() => undefined);
			throw err;
		});
		(await storedFiles(dir)).set(key, ext);
	} catch (err) {
		// Worth a warning rather than silence: a cache that cannot write is a
		// cache that is not working, and the page gives no sign of it.
		log.warn('cover-write-failed', { id, size, detail: reason(err) });
		return;
	}

	log.debug('cover-stored', { key: cacheKey(scope, id, size), bytes: body.byteLength });
	bytesSinceSweep += body.byteLength;
	const { coverCacheBytes } = config();
	if (bytesSinceSweep >= Math.max(SWEEP_MIN_BYTES, coverCacheBytes / SWEEP_FRACTION)) {
		bytesSinceSweep = 0;
		void sweep();
	}
}

export interface CacheStats {
	/** Null when caching is switched off. */
	bytes: number | null;
	files: number;
	limitBytes: number;
}

/**
 * Stats issued at once while listing the directory.
 *
 * One at a time, 10000 files (a full 512MB cache at 50KB a cover) took 191 to
 * 216ms to list; in batches of 64 it took 52 to 64ms, and batches of 256 were
 * no faster. Measured on Node 22 in a container.
 */
const STAT_BATCH = 64;

interface CachedFile {
	path: string;
	size: number;
	/** Last access, or last write where the volume does not record access. */
	used: number;
}

/** Every file in the cache directory. Throws when the directory is missing. */
async function listFiles(dir: string): Promise<CachedFile[]> {
	const names = await readdir(dir);
	const files: CachedFile[] = [];
	for (let start = 0; start < names.length; start += STAT_BATCH) {
		const batch = await Promise.all(
			names.slice(start, start + STAT_BATCH).map(async (name) => {
				const path = join(dir, name);
				try {
					const info = await stat(path);
					return info.isFile()
						? { path, size: info.size, used: Math.max(info.atimeMs, info.mtimeMs) }
						: null;
				} catch {
					// Removed between the listing and the stat.
					return null;
				}
			})
		);
		for (const file of batch) if (file) files.push(file);
	}
	return files;
}

export async function cacheStats(): Promise<CacheStats> {
	const { coverCacheBytes } = config();
	const dir = root();
	if (!dir) return { bytes: null, files: 0, limitBytes: 0 };
	try {
		const files = await listFiles(dir);
		const bytes = files.reduce((sum, file) => sum + file.size, 0);
		return { bytes, files: files.length, limitBytes: coverCacheBytes };
	} catch {
		// The directory does not exist until the first cover is written.
		return { bytes: 0, files: 0, limitBytes: coverCacheBytes };
	}
}

/** Empties the cache. The next request for each cover fetches it again. */
export async function clearCache(): Promise<void> {
	const dir = root();
	if (!dir) return;
	const before = await cacheStats();
	await rm(dir, { recursive: true, force: true }).catch(() => undefined);
	index = Promise.resolve(new Map());
	bytesSinceSweep = 0;
	log.info('cover-cache-cleared', { files: before.files, bytes: before.bytes ?? 0 });
}

/**
 * Drops the least recently used files until the directory is back under the
 * cap. Ordered by access time where the filesystem records it and by
 * modification time where it does not, which is the case on a volume mounted
 * noatime.
 */
async function sweep(): Promise<void> {
	const dir = root();
	if (!dir || sweeping) return;
	sweeping = true;
	try {
		const { coverCacheBytes } = config();
		const entries = await listFiles(dir);
		let total = entries.reduce((sum, entry) => sum + entry.size, 0);
		if (total <= coverCacheBytes) return;

		entries.sort((a, b) => a.used - b.used);
		const startedAt = total;
		let removed = 0;
		const files = await storedFiles(dir);
		for (const entry of entries) {
			if (total <= coverCacheBytes) break;
			try {
				await unlink(entry.path);
				const key = keyOf(entry.path);
				// Only if the index still names this file, and not one written for the
				// same cover under another type since.
				if (entry.path.endsWith(`.${files.get(key)}`)) files.delete(key);
				total -= entry.size;
				removed += 1;
			} catch {
				// Another process got there first.
			}
		}
		// Rare and consequential: this is where covers start being fetched from
		// the music server again, and the figures say whether the cap is too low
		// for the library.
		log.info('cover-cache-swept', { removed, freed: startedAt - total, held: total, cap: coverCacheBytes });
	} catch (err) {
		// A sweep that fails leaves the cap unenforced until the next write.
		log.warn('cover-sweep-failed', { detail: reason(err) });
	} finally {
		sweeping = false;
	}
}
