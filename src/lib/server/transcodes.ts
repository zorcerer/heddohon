/**
 * Transcodes, read whole from the music server and served in ranges from here.
 *
 * Navidrome answers ranges of a transcode only once it has finished and
 * cached it; until then it sends the song from byte 0 whatever was asked
 * (see `rangeIgnored` in proxy.ts). A browser reads audio at the pace it
 * plays it, so a transcode read only by the browser stays unfinished for the
 * length of the song, and a stream that dropped in the middle (a phone with
 * the tab in the background, a proxy closing a connection that has idled)
 * could not be picked up again where it stopped: the player's reload came
 * back from byte 0, unseekable, and the song started over.
 *
 * So the first request for a transcode starts one read of it from the music
 * server, at the server's own speed, into memory, and every request for it is
 * answered from that. Measured against Navidrome 0.64.1 on a 16-core host, a
 * whole transcode took 2.7s (MP3, 4 minutes) to 17s (AAC, 10 minutes), with
 * the first byte in under 0.1s. Until it is whole, a request from byte 0 gets
 * a stream of it as it arrives, without a length and not cached by the
 * browser; once it is whole, every request gets exact ranges and the real
 * length.
 *
 * Keyed by account as well as song, codec and bitrate, like every other cache
 * here, and dropped with the account's sessions. Held for 15 minutes after the
 * last request, oldest dropped first.
 *
 * Bounded, since a read goes on after the request that started it: a HEAD
 * request costs nothing and started a whole transcode on the music server
 * and a whole copy here, so a loop of them over a library ran the music
 * server's CPU and this process's memory without limit (found in the review
 * of 2026-09-25). At most 2 reads run per account and 4 in all; 192MB is held
 * in all, reads in progress included, and 64MB per transcode. A request
 * past any of those is relayed as it comes instead, tied to its own
 * connection, as every transcode was before this.
 */
import { log, reason } from './log';

const IDLE_MS = 15 * 60_000;
const MAX_TOTAL_BYTES = 192 * 1024 * 1024;
export const MAX_ENTRY_BYTES = 64 * 1024 * 1024;
const MAX_READING = 4;
const MAX_READING_PER_ACCOUNT = 2;

export interface Transcode {
	readonly account: string;
	readonly type: string;
	chunks: Uint8Array[];
	size: number;
	done: boolean;
	/** Set when the read failed or the transcode outgrew `MAX_ENTRY_BYTES`. */
	failed: 'error' | 'oversize' | null;
	usedAt: number;
	waiters: Set<() => void>;
}

const held = new Map<string, Transcode>();
/** Reads being opened, so two requests at once for one transcode share a read. */
const opening = new Map<string, Promise<Transcode | null>>();

function reading(account?: string): number {
	let count = 0;
	for (const entry of held.values()) {
		if (!entry.done && entry.failed === null && (account === undefined || entry.account === account)) count += 1;
	}
	return count;
}

/** Drops everything held for an account; see `destroyAllSessions`. */
export function forgetTranscodes(account: string): void {
	for (const [key, entry] of held) {
		if (entry.account === account) held.delete(key);
	}
}

function total(): number {
	let bytes = 0;
	for (const entry of held.values()) bytes += entry.size;
	return bytes;
}

/** Drops idle entries, then the least recently used whole ones while over the cap. */
function sweep(): void {
	const now = Date.now();
	for (const [key, entry] of held) {
		if (now - entry.usedAt > IDLE_MS) held.delete(key);
	}
	if (total() <= MAX_TOTAL_BYTES) return;
	const whole = [...held.entries()].filter(([, entry]) => entry.done).sort((a, b) => a[1].usedAt - b[1].usedAt);
	for (const [key] of whole) {
		held.delete(key);
		if (total() <= MAX_TOTAL_BYTES) return;
	}
}

function wake(entry: Transcode): void {
	for (const waiter of entry.waiters) waiter();
	entry.waiters.clear();
}

/**
 * The transcode for `key`, starting its read with `open` if nothing holds it,
 * or null when a new read would go past the limits above and the caller
 * should relay the transcode instead. `open` resolves to the upstream body and
 * its already-checked content type; it runs without the browser's abort
 * signal, so the read goes on after the request that started it has gone.
 */
export async function transcodeFor(
	key: string,
	account: string,
	open: () => Promise<{ body: ReadableStream<Uint8Array>; type: string }>
): Promise<Transcode | null> {
	sweep();
	const existing = held.get(key);
	if (existing && existing.failed === null) {
		existing.usedAt = Date.now();
		return existing;
	}
	const pending = opening.get(key);
	if (pending) return pending;
	if (reading() >= MAX_READING || reading(account) >= MAX_READING_PER_ACCOUNT || total() >= MAX_TOTAL_BYTES) {
		return null;
	}

	const started = start(key, account, open);
	opening.set(key, started);
	try {
		return await started;
	} finally {
		opening.delete(key);
	}
}

async function start(
	key: string,
	account: string,
	open: () => Promise<{ body: ReadableStream<Uint8Array>; type: string }>
): Promise<Transcode> {
	const { body, type } = await open();
	const entry: Transcode = {
		account,
		type,
		chunks: [],
		size: 0,
		done: false,
		failed: null,
		usedAt: Date.now(),
		waiters: new Set()
	};
	held.set(key, entry);
	void pump(key, entry, body);
	return entry;
}

async function pump(key: string, entry: Transcode, body: ReadableStream<Uint8Array>): Promise<void> {
	const reader = body.getReader();
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			entry.chunks.push(value);
			entry.size += value.byteLength;
			if (entry.size > MAX_ENTRY_BYTES || (total() > MAX_TOTAL_BYTES && (sweep(), total() > MAX_TOTAL_BYTES))) {
				entry.failed = 'oversize';
				await reader.cancel().catch(() => undefined);
				break;
			}
			wake(entry);
		}
		if (entry.failed === null) entry.done = true;
	} catch (err) {
		entry.failed = 'error';
		log.warn('transcode-read-failed', { detail: reason(err) });
	}
	if (entry.failed !== null && held.get(key) === entry) held.delete(key);
	wake(entry);
	sweep();
}

/** Resolves when more has arrived, or the read has ended either way. */
function more(entry: Transcode): Promise<void> {
	if (entry.done || entry.failed !== null) return Promise.resolve();
	return new Promise((resolve) => entry.waiters.add(resolve));
}

/** Resolves once the transcode is whole or failed, or after `ms`. */
export async function settled(entry: Transcode, ms: number): Promise<void> {
	const until = Date.now() + ms;
	while (!entry.done && entry.failed === null && Date.now() < until) {
		await Promise.race([more(entry), new Promise((resolve) => setTimeout(resolve, until - Date.now()))]);
	}
}

/**
 * Bytes `start` to `end` inclusive, as they arrive, ending early if the read
 * fails. `end` null reads to the end of the transcode, however long it turns
 * out to be.
 */
export function bytesOf(entry: Transcode, start: number, end: number | null): ReadableStream<Uint8Array> {
	let position = start;
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			for (;;) {
				const last = end ?? Infinity;
				if (position > last) {
					controller.close();
					return;
				}
				if (position < entry.size) {
					// Find the chunk holding `position`.
					let offset = 0;
					for (const chunk of entry.chunks) {
						if (position < offset + chunk.byteLength) {
							const from = position - offset;
							const to = Math.min(chunk.byteLength, last + 1 - offset);
							controller.enqueue(chunk.subarray(from, to));
							position += to - from;
							entry.usedAt = Date.now();
							return;
						}
						offset += chunk.byteLength;
					}
				}
				if (entry.done) {
					controller.close();
					return;
				}
				if (entry.failed !== null) {
					controller.error(new Error('the transcode stopped arriving'));
					return;
				}
				await more(entry);
			}
		}
	});
}
