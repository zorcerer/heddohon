/**
 * Lyrics from LRCLIB, for tracks the music server has none for.
 *
 * Off unless `HEDDOHON_LYRICS_LRCLIB=true`. When on, opening the lyrics of a
 * track the server has no synced lyrics for sends its artist, title, album and
 * length to LRCLIB (or to `HEDDOHON_LYRICS_LRCLIB_URL`, for a self-hosted
 * copy). The request is made by this server, like every other fetch; the
 * browser still talks only to Heddohon, and the policy on its pages is
 * unchanged.
 *
 * What comes back is text from a third party. It is only ever rendered as text,
 * capped in size, and never followed anywhere: the fetch refuses redirects.
 */
import type { LyricLine, Lyrics, Song } from '$lib/types';
import { config } from './config';
import { log, reason } from './log';
import { APP_VERSION } from './version';

const TIMEOUT_MS = 5000;
const MAX_BYTES = 256 * 1024;
const FOUND_TTL_MS = 24 * 60 * 60 * 1000;
/** A miss or a failure is remembered for less time, so a new upload is found. */
const MISSED_TTL_MS = 60 * 60 * 1000;
const MAX_CACHED = 500;

const cache = new Map<string, { lyrics: Lyrics | null; until: number }>();

function remember(key: string, lyrics: Lyrics | null, ttl: number): void {
	if (cache.size >= MAX_CACHED) {
		const oldest = cache.keys().next().value;
		if (oldest !== undefined) cache.delete(oldest);
	}
	cache.set(key, { lyrics, until: Date.now() + ttl });
}

/** Lyrics for `song` from LRCLIB, or null when it is off, has none, or fails. */
export async function lrclibLyrics(song: Song): Promise<Lyrics | null> {
	const base = config().lrclibUrl;
	if (!base || !song.artist || !song.title) return null;

	const duration = Math.round(song.duration);
	const key = [song.artist, song.title, song.album ?? '', duration].join('\u0000');
	const cached = cache.get(key);
	if (cached && cached.until > Date.now()) return cached.lyrics;

	const url = new URL(`${base}/api/get`);
	url.searchParams.set('artist_name', song.artist);
	url.searchParams.set('track_name', song.title);
	if (song.album) url.searchParams.set('album_name', song.album);
	// LRCLIB matches on length within two seconds; without it a live version or
	// a remix can come back for the studio track.
	if (duration > 0) url.searchParams.set('duration', String(duration));

	const started = performance.now();
	try {
		const response = await fetch(url, {
			headers: {
				accept: 'application/json',
				// LRCLIB asks clients to name themselves.
				'user-agent': `Heddohon/${APP_VERSION} (https://github.com/zorcerer/heddohon)`
			},
			redirect: 'error',
			signal: AbortSignal.timeout(TIMEOUT_MS)
		});
		log.debug('lrclib', { status: response.status, ms: Math.round(performance.now() - started) });
		if (response.status === 404) {
			remember(key, null, MISSED_TTL_MS);
			return null;
		}
		if (!response.ok) throw new Error(`LRCLIB returned HTTP ${response.status}`);

		const text = await readCapped(response, MAX_BYTES);
		const body = JSON.parse(text) as {
			instrumental?: unknown;
			syncedLyrics?: unknown;
			plainLyrics?: unknown;
		};

		const lyrics = toLyrics(body, song);
		remember(key, lyrics, lyrics ? FOUND_TTL_MS : MISSED_TTL_MS);
		return lyrics;
	} catch (err) {
		log.warn('lrclib-failed', { detail: reason(err) });
		remember(key, null, MISSED_TTL_MS);
		return null;
	}
}

/**
 * The body as text, refused past `limit` bytes while it is still arriving.
 * `response.text()` read the whole body first and measured it afterwards, so
 * the cap bounded nothing: a misbehaving server could still have filled memory
 * before the check ran.
 */
async function readCapped(response: Response, limit: number): Promise<string> {
	const declared = Number(response.headers.get('content-length'));
	if (Number.isFinite(declared) && declared > limit) throw new Error('LRCLIB response over the size cap');
	if (!response.body) return '';
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > limit) {
			await reader.cancel().catch(() => undefined);
			throw new Error('LRCLIB response over the size cap');
		}
		chunks.push(value);
	}
	return new TextDecoder().decode(Buffer.concat(chunks));
}

function toLyrics(
	body: { instrumental?: unknown; syncedLyrics?: unknown; plainLyrics?: unknown },
	song: Song
): Lyrics | null {
	if (body.instrumental === true) return null;
	const common = { artist: song.artist, title: song.title, source: 'lrclib' as const };

	if (typeof body.syncedLyrics === 'string') {
		const lines = parseLrc(body.syncedLyrics);
		if (lines.length > 0) return { ...common, synced: true, lines };
	}
	if (typeof body.plainLyrics === 'string' && body.plainLyrics.trim()) {
		const lines = body.plainLyrics
			.split(/\r?\n/)
			.slice(0, 2000)
			.map((text) => ({ timeMs: null, text: text.trim() }));
		return { ...common, synced: false, lines };
	}
	return null;
}

const STAMP = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;

/**
 * LRC to timed lines.
 *
 * A line can carry several stamps (a chorus written once), each becoming a
 * line of its own. Tag lines such as `[ar:...]` have no numeric stamp and are
 * dropped, apart from `[offset:...]`, which shifts every stamp by the given
 * milliseconds as the format defines.
 */
export function parseLrc(source: string): LyricLine[] {
	const offsetTag = /\[offset:\s*([+-]?\d+)\s*\]/i.exec(source);
	const offset = offsetTag ? Number(offsetTag[1]) : 0;
	const lines: LyricLine[] = [];

	for (const raw of source.split(/\r?\n/).slice(0, 4000)) {
		const stamps = [...raw.matchAll(STAMP)];
		if (stamps.length === 0) continue;
		const text = raw.replace(STAMP, '').trim();
		for (const stamp of stamps) {
			const fraction = stamp[3] ?? '0';
			const ms =
				Number(stamp[1]) * 60_000 +
				Number(stamp[2]) * 1000 +
				Math.round(Number(`0.${fraction}`) * 1000) -
				offset;
			lines.push({ timeMs: Math.max(0, ms), text });
		}
	}
	return lines.sort((a, b) => (a.timeMs ?? 0) - (b.timeMs ?? 0));
}
