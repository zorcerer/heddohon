/**
 * An on-disk cache for cover art.
 *
 * A cover is otherwise fetched from the music server, which resizes it on
 * demand, every time a browser sees it first: a new device, a cleared cache, a
 * private window. Audio is not cached: a library is larger than any cap, and
 * the browser caches what it plays.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { readdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { config } from './config';
import { log, reason } from './log';
import type { BackendKind } from '$lib/types';

/**
 * Content types kept, and the extension each is stored under. The extension is
 * what the content type is recovered from. Anything else is served through and
 * not written. SVG is left out: an image by content type, a scriptable
 * document by behaviour.
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
 * Largest single cover kept. Navidrome renders a 1024px sleeve at 150-400KB.
 * This bounds the buffer a request holds.
 */
const MAX_ENTRY_BYTES = 8 * 1024 * 1024;

/**
 * How much may be written between sweeps, as a fraction of the cap, and the
 * floor under that in bytes.
 *
 * Counting writes (one sweep per 25) let the directory settle above the cap:
 * at a 1MB cap with 19KB covers, 120 requests left 1.43MB. Counting bytes
 * holds it within max(256KB, cap/16) of the cap: the same run settles at
 * 1.20MB, and a 512MB cap sweeps every 32MB. A sweep stats every file, so the
 * floor keeps a small cap from sweeping on every write.
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
 * The file name for one cover at one size, readable in a file browser.
 *
 * Only an id of this shape is used as it is. Any other is replaced by a hash
 * of itself, so an id cannot name a path and two ids cannot claim one file.
 * The backend leads the name: Subsonic and Jellyfin ids are separate
 * namespaces, and both are 32-character hex in practice.
 */
const PLAIN_ID = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * Who a cached cover belongs to.
 *
 * Navidrome serves one library to every user, so its covers are shared.
 * Jellyfin restricts libraries per user, and a cache hit is answered before
 * the upstream is asked: keyed without the viewer, a restricted library's
 * artwork went to any account that could name the item id.
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
 * 16 hex characters, a fixed width: with a variable one, an id of
 * `u<16 hex>-<real id>`, which `PLAIN_ID` admits, would read as another
 * viewer's tag and collide with their entry. Hashed, since the viewer is an
 * upstream user id and this becomes a file name.
 */
function viewerTag(viewer: string | null): string {
	return createHash('sha256')
		.update(viewer ?? 'shared')
		.digest('hex')
		.slice(0, 16);
}

function cacheKey(scope: CoverScope, id: string, size: number): string {
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
	 * For a revalidating browser. A cover is fixed for its id and size, so the
	 * length tells one stored body from another after a clear and a re-fetch.
	 */
	etag: string;
}

/**
 * The stored covers, by key, with each one's extension.
 *
 * A lookup that tried the five extensions in turn cost a failed open before a
 * PNG was read, and five before the music server was asked for an uncached
 * cover. The index is read from the directory once and kept by the writes,
 * the sweep and the clear. A file removed from outside is dropped when reading
 * it fails. One added from outside is not seen until a restart.
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
 * Whether a cover is stored, by the index alone. The fill (`coverfill.ts`)
 * asks this of every cover in the library.
 */
export async function holdsCover(scope: CoverScope, id: string, size: number): Promise<boolean> {
	const dir = root();
	if (!dir) return false;
	return (await storedFiles(dir)).has(cacheKey(scope, id, size));
}

/**
 * Reads a stream into one buffer. Null past `MAX_ENTRY_BYTES` (which
 * `writeCover` would refuse) or on a failed read.
 */
export async function collectCover(stream: ReadableStream<Uint8Array>): Promise<Buffer | null> {
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) return Buffer.concat(chunks, total);
			total += value.byteLength;
			if (total > MAX_ENTRY_BYTES) {
				await reader.cancel();
				return null;
			}
			chunks.push(value);
		}
	} catch {
		return null;
	}
}

/**
 * Stores a cover, and says whether it did. Failures are swallowed: a cache
 * that cannot write, or a full disk, must not break the page.
 */
export async function writeCover(
	scope: CoverScope,
	id: string,
	size: number,
	contentType: string,
	body: Buffer
): Promise<boolean> {
	const dir = root();
	if (!dir) return false;
	const ext = EXTENSIONS[contentType.split(';')[0].trim().toLowerCase()];
	if (!ext || body.byteLength === 0 || body.byteLength > MAX_ENTRY_BYTES) return false;

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
		// Warned: the page gives no sign that the cache is not writing.
		log.warn('cover-write-failed', { id, size, detail: reason(err) });
		return false;
	}

	log.debug('cover-stored', { key: cacheKey(scope, id, size), bytes: body.byteLength });
	bytesSinceSweep += body.byteLength;
	const { coverCacheBytes } = config();
	if (bytesSinceSweep >= Math.max(SWEEP_MIN_BYTES, coverCacheBytes / SWEEP_FRACTION)) {
		bytesSinceSweep = 0;
		void sweep();
	}
	return true;
}

export interface CacheStats {
	/** Null when caching is switched off. */
	bytes: number | null;
	files: number;
	limitBytes: number;
}

/**
 * Stats issued at once while listing the directory. For 10000 files (a full
 * 512MB cache at 50KB a cover), one at a time took 191 to 216ms, batches of 64
 * took 52 to 64ms, and batches of 256 were no faster (Node 22, in a container).
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
 * Drops the least recently used files until the directory is under the cap.
 * Ordered by access time, or by modification time on a volume mounted noatime.
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
				// Only if the index still names this file, and not one written since
				// for the same cover under another type.
				if (entry.path.endsWith(`.${files.get(key)}`)) files.delete(key);
				total -= entry.size;
				removed += 1;
			} catch {
				// Another process got there first.
			}
		}
		// From here covers are fetched from the music server again. The figures
		// say whether the cap is too low for the library.
		log.info('cover-cache-swept', { removed, freed: startedAt - total, held: total, cap: coverCacheBytes });
	} catch (err) {
		// The cap stays unenforced until the next write.
		log.warn('cover-sweep-failed', { detail: reason(err) });
	} finally {
		sweeping = false;
	}
}
