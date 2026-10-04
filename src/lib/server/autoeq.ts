/**
 * Headphone corrections from the AutoEq database, for the equaliser.
 *
 * Off unless `HEDDOHON_AUTOEQ=true`. On, this server fetches from
 * `HEDDOHON_AUTOEQ_URL` (by default the `results` directory of
 * jaakkopasanen/AutoEq on GitHub) the index of every profile and the
 * ParametricEQ.txt of a profile someone chooses. That host learns this
 * server's address and which headphones were chosen.
 *
 * The index is 852 KB of Markdown listing about 8,850 profiles. It is held in
 * memory and in `HEDDOHON_DATA_DIR`, and asked for again once a day old with
 * `If-None-Match`, so an unchanged index costs one 304. A failed fetch leaves
 * the held copy in use.
 *
 * A profile is fetched only by an id in the index, so no free text from a
 * request reaches the upstream URL. The answer is parsed into numbers
 * (`$lib/autoeq`), each held to a range. Redirects are refused and both bodies
 * are capped.
 */
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MAX_CORRECTION_BYTES, parseParametricEq, type Correction } from '$lib/autoeq';
import { config } from './config';
import { log, reason } from './log';
import { APP_VERSION } from './version';

const TIMEOUT_MS = 10_000;
/** Five times the index's size on 1 October 2026. */
const MAX_INDEX_BYTES = 4 * 1024 * 1024;
const MAX_ENTRIES = 20_000;
/**
 * An entry is about 100 characters. A longer line is not put to the pattern
 * below: on a line of `](./` repeated it backtracks in the square of the
 * length (242 ms for 32 KB, an hour for the 4 MB the index may be).
 */
const MAX_LINE = 1000;
const INDEX_TTL_MS = 24 * 60 * 60 * 1000;
/** After a failed fetch, how long the held copy is served before asking again. */
const RETRY_MS = 5 * 60 * 1000;
const PROFILE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_PROFILES = 500;
const INDEX_FILE = 'autoeq-index.json';
const MAX_RESULTS = 20;
export const MAX_QUERY_LENGTH = 80;

export interface AutoEqEntry {
	/** The profile's path under the results directory, decoded: `oratory1990/over-ear/Sennheiser HD 650`. */
	id: string;
	name: string;
	/** Who measured it. */
	source: string;
	/** The measurement rig, where the index names one. */
	rig: string | null;
}

interface Index {
	entries: AutoEqEntry[];
	byId: Map<string, AutoEqEntry>;
	/** Each entry's name, folded for matching, in the order of `entries`. */
	folded: string[];
	etag: string | null;
	fetchedAt: number;
}

let held: Index | null = null;
let loading: Promise<Index | null> | null = null;
let retryAt = 0;
const profiles = new Map<string, { correction: Correction | null; until: number }>();

/** Whether this deployment offers the database. */
export function autoEqEnabled(): boolean {
	return config().autoeqUrl !== null;
}

const fold = (text: string) =>
	text
		.normalize('NFKD')
		.replace(/[̀-ͯ]/g, '')
		.toLowerCase();

const ENTRY = /^- \[(.+)\]\(\.\/(.+)\) by (.+?)(?: on (.+))?$/;

/** The profiles listed in INDEX.md: `- [Name](./source/rig/Name) by Source on Rig`. */
function parseIndex(markdown: string): AutoEqEntry[] {
	const entries: AutoEqEntry[] = [];
	const seen = new Set<string>();
	for (const line of markdown.split(/\r?\n/)) {
		if (line.length > MAX_LINE) continue;
		const match = ENTRY.exec(line.trim());
		if (!match) continue;
		let id: string;
		try {
			id = decodeURIComponent(match[2]);
		} catch {
			continue;
		}
		if (!plainPath(id) || seen.has(id)) continue;
		seen.add(id);
		entries.push({ id, name: match[1].slice(0, 200), source: match[3].slice(0, 100), rig: match[4]?.slice(0, 100) ?? null });
		if (entries.length >= MAX_ENTRIES) break;
	}
	return entries;
}

function indexOf(entries: AutoEqEntry[], etag: string | null, fetchedAt: number): Index {
	return {
		entries,
		byId: new Map(entries.map((entry) => [entry.id, entry])),
		folded: entries.map((entry) => fold(entry.name)),
		etag,
		fetchedAt
	};
}

/** A path is a few plain segments. One that climbs, or is absolute, is not followed. */
function plainPath(id: string): boolean {
	const segments = id.split('/');
	return id.length <= 300 && segments.length >= 2 && !segments.some((part) => part === '' || part === '.' || part === '..');
}

/** The index as last stored, each entry checked again: the file on disk can be edited. */
async function readStored(): Promise<Index | null> {
	try {
		const stored = JSON.parse(await readFile(join(config().dataDir, INDEX_FILE), 'utf8')) as {
			etag?: unknown;
			fetchedAt?: unknown;
			entries?: unknown;
		};
		if (!Array.isArray(stored.entries) || typeof stored.fetchedAt !== 'number') return null;
		const entries = (stored.entries as Array<Record<string, unknown>>)
			.slice(0, MAX_ENTRIES)
			.filter((entry) => typeof entry?.id === 'string' && plainPath(entry.id) && typeof entry.name === 'string' && typeof entry.source === 'string')
			.map((entry) => ({
				id: entry.id as string,
				name: entry.name as string,
				source: entry.source as string,
				rig: typeof entry.rig === 'string' ? entry.rig : null
			}));
		if (entries.length === 0) return null;
		return indexOf(entries, typeof stored.etag === 'string' ? stored.etag : null, stored.fetchedAt);
	} catch {
		return null;
	}
}

/** Written beside and renamed over, so a process stopped mid-write leaves the old file whole. */
async function store(current: Index): Promise<void> {
	const path = join(config().dataDir, INDEX_FILE);
	try {
		await writeFile(`${path}.tmp`, JSON.stringify({ etag: current.etag, fetchedAt: current.fetchedAt, entries: current.entries }));
		await rename(`${path}.tmp`, path);
	} catch (err) {
		log.warn('autoeq-store-failed', { detail: reason(err) });
	}
}

async function get(url: string, headers: Record<string, string> = {}): Promise<Response> {
	return fetch(url, {
		headers: { accept: 'text/plain', 'user-agent': `Heddohon/${APP_VERSION} (https://github.com/zorcerer/heddohon)`, ...headers },
		redirect: 'error',
		signal: AbortSignal.timeout(TIMEOUT_MS)
	});
}

/** The body as text, refused past `limit` bytes as it arrives; see `readCapped` in `lrclib.ts`. */
async function readCapped(response: Response, limit: number): Promise<string> {
	const declared = Number(response.headers.get('content-length'));
	if (Number.isFinite(declared) && declared > limit) throw new Error('AutoEq response over the size cap');
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
			throw new Error('AutoEq response over the size cap');
		}
		chunks.push(value);
	}
	return new TextDecoder().decode(Buffer.concat(chunks));
}

async function refresh(base: string, current: Index | null): Promise<Index | null> {
	const started = performance.now();
	try {
		const response = await get(`${base}/INDEX.md`, current?.etag ? { 'if-none-match': current.etag } : {});
		const ms = Math.round(performance.now() - started);
		if (response.status === 304 && current) {
			log.info('autoeq-index', { status: 304, entries: current.entries.length, ms });
			const kept = { ...current, fetchedAt: Date.now() };
			await store(kept);
			return kept;
		}
		if (!response.ok) throw new Error(`AutoEq index returned HTTP ${response.status}`);
		const markdown = await readCapped(response, MAX_INDEX_BYTES);
		const entries = parseIndex(markdown);
		if (entries.length === 0) throw new Error('AutoEq index held no profiles');
		const next = indexOf(entries, response.headers.get('etag'), Date.now());
		log.info('autoeq-index', { status: response.status, entries: entries.length, ms });
		await store(next);
		return next;
	} catch (err) {
		log.warn('autoeq-failed', { what: 'index', detail: reason(err) });
		retryAt = Date.now() + RETRY_MS;
		return current;
	}
}

/** The index from memory, from the data directory, or fetched. Null when off or unavailable. */
async function index(): Promise<Index | null> {
	const base = config().autoeqUrl;
	if (!base) return null;
	if (held && Date.now() - held.fetchedAt < INDEX_TTL_MS) return held;
	if (held && Date.now() < retryAt) return held;
	// One read at a time: requests that arrive while it is out wait for it.
	loading ??= (async () => {
		try {
			const current = held ?? (await readStored());
			if (current && Date.now() - current.fetchedAt < INDEX_TTL_MS) return (held = current);
			if (current && Date.now() < retryAt) return (held = current);
			return (held = await refresh(base, current));
		} finally {
			loading = null;
		}
	})();
	return loading;
}

/**
 * Up to `MAX_RESULTS` profiles whose name holds every word of `query`, names
 * that start with it first. Null when the database is off or cannot be read.
 */
export async function searchAutoEq(query: string): Promise<AutoEqEntry[] | null> {
	const current = await index();
	if (!current) return null;
	const words = fold(query.slice(0, MAX_QUERY_LENGTH)).split(/\s+/).filter(Boolean);
	if (words.length === 0) return [];
	const whole = words.join(' ');
	const matches: Array<{ entry: AutoEqEntry; rank: number }> = [];
	current.folded.forEach((name, i) => {
		if (!words.every((word) => name.includes(word))) return;
		matches.push({ entry: current.entries[i], rank: name === whole ? 0 : name.startsWith(whole) ? 1 : 2 });
	});
	return matches
		.sort((a, b) => a.rank - b.rank || a.entry.name.length - b.entry.name.length || a.entry.name.localeCompare(b.entry.name))
		.slice(0, MAX_RESULTS)
		.map((match) => match.entry);
}

export interface AutoEqProfile extends Correction {
	entry: AutoEqEntry;
}

/**
 * The correction for the profile `id`. `unknown` for an id the index does not
 * list, `failed` when the file cannot be fetched or holds no filters.
 */
export async function autoEqProfile(id: string): Promise<AutoEqProfile | 'unknown' | 'failed'> {
	const base = config().autoeqUrl;
	const current = await index();
	const entry = current?.byId.get(id);
	if (!base || !entry) return 'unknown';

	const cached = profiles.get(id);
	if (cached && cached.until > Date.now()) return cached.correction ? { entry, ...cached.correction } : 'failed';

	const remember = (correction: Correction | null, ttl: number) => {
		if (profiles.size >= MAX_PROFILES) {
			const oldest = profiles.keys().next().value;
			if (oldest !== undefined) profiles.delete(oldest);
		}
		profiles.set(id, { correction, until: Date.now() + ttl });
	};

	// The file is named after the directory it is in.
	const segments = id.split('/');
	const path = [...segments, `${segments[segments.length - 1]} ParametricEQ.txt`].map(encodeURIComponent).join('/');
	try {
		const response = await get(`${base}/${path}`);
		if (!response.ok) throw new Error(`AutoEq profile returned HTTP ${response.status}`);
		const correction = parseParametricEq(await readCapped(response, MAX_CORRECTION_BYTES));
		if (!correction) throw new Error('AutoEq profile held no filters');
		remember(correction, PROFILE_TTL_MS);
		return { entry, ...correction };
	} catch (err) {
		log.warn('autoeq-failed', { what: 'profile', detail: reason(err) });
		remember(null, RETRY_MS);
		return 'failed';
	}
}
