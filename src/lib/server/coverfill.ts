/**
 * Filling the cover cache from the library, ahead of any browser asking.
 *
 * The cache otherwise fills a cover at a time, as pages are opened, so the
 * first visit to each part of a library waits for the music server to render
 * its covers. A fill reads the albums, artists and playlists and stores each
 * cover at the sizes the pages draw.
 *
 * It is started by an account the music server lists as an administrator
 * (`routes/api/cover-fill`), and it goes on after the request that started it
 * has been answered. That makes this the one place a decrypted credential is
 * held past its request: for the length of the fill, in this module. It is
 * dropped when the fill ends, and `destroyAllSessions` ends the fill. One fill
 * runs at a time in a process, and what it reports is kept in memory until the
 * next one or a restart.
 */
import { config } from './config';
import { backendFor, UpstreamError, type MediaBackend, type StoredCredential } from './backends';
import { mapLimited } from './backends/http';
import { cacheStats, collectCover, coverScope, holdsCover, writeCover, type CoverScope } from './covercache';
import { log, reason } from './log';
import type { BackendKind } from '$lib/types';

type Kind = 'album' | 'artist' | 'playlist';

/**
 * What is fetched, in this order. A fill stops at the disk budget, so the
 * sizes drawn most often come first: 384 is a card in a grid, 96 is a row in a
 * list and the copy the room's colour is sampled from, 512 is what the album
 * page's 640 snaps to (`nearestCoverSize`), and 1024 is that same cover on a
 * display of twice the density.
 *
 * Track covers are left out. Navidrome gives a track with embedded art a cover
 * id of its own, so a library of 100,000 tracks is 100,000 more covers, most
 * of them copies of their albums'. They are cached as they are played.
 */
const PASSES: { size: number; of: Kind[] }[] = [
	{ size: 384, of: ['album', 'artist', 'playlist'] },
	{ size: 96, of: ['album', 'artist', 'playlist'] },
	{ size: 512, of: ['album'] },
	{ size: 1024, of: ['album'] }
];

/**
 * Covers asked of the music server at once: half of `UPSTREAM_FANOUT`, which
 * is what one request may have in flight. Not measured against a real server.
 * A fill of 5000 albums is 20,000 renders upstream, and people are using the
 * library while it runs.
 */
const FILL_FANOUT = 4;

/** Albums read per call. Subsonic's `getAlbumList2` gives 500 at most. */
const LIST_PAGE = 500;

export interface FillStatus {
	/**
	 * `listing` while the library is read and `running` while covers are
	 * fetched. `full` is a fill that stopped at the disk budget, `stopped` one
	 * the account stopped, `failed` one the music server ended.
	 */
	state: 'idle' | 'listing' | 'running' | 'done' | 'full' | 'stopped' | 'failed';
	/** Covers the library has, counting each size. Zero until it has been read. */
	total: number;
	/** How many of `total` are dealt with: stored, held already, or failed. */
	done: number;
	stored: number;
	/** Not stored: the music server had no image for it, or the write failed. */
	failed: number;
}

interface Job {
	account: string;
	status: FillStatus;
	abort: AbortController;
}

const IDLE: FillStatus = { state: 'idle', total: 0, done: 0, stored: 0, failed: 0 };

let job: Job | null = null;

function running(status: FillStatus): boolean {
	return status.state === 'listing' || status.state === 'running';
}

/**
 * The fill this account started, as it stands. Idle for every other account:
 * the counts are of the library as the account that started it sees it.
 */
export function fillStatus(account: string): FillStatus {
	return job?.account === account ? { ...job.status } : { ...IDLE };
}

/**
 * Starts a fill with the account's credential and returns at once. Null when
 * another account's fill is running; the account's own is returned as it
 * stands. The caller has checked that the account is an administrator.
 */
export function startFill(
	account: { id: string; backend: BackendKind; remoteUserId: string | null },
	credential: StoredCredential
): FillStatus | null {
	if (job && running(job.status)) return job.account === account.id ? { ...job.status } : null;
	const started: Job = { account: account.id, status: { ...IDLE, state: 'listing' }, abort: new AbortController() };
	job = started;
	log.info('cover-fill-started', { account: account.id });
	void run(started, backendFor(account.backend), credential, coverScope(account));
	return { ...started.status };
}

/** Stops the account's fill, if it has one running. What is stored stays. */
export function stopFill(account: string): void {
	if (job?.account !== account || !running(job.status)) return;
	job.abort.abort('stopped');
}

/** The cover ids of every album, artist and playlist the account can see. */
async function libraryCovers(
	backend: MediaBackend,
	cred: StoredCredential,
	signal: AbortSignal
): Promise<Record<Kind, Set<string>>> {
	const covers: Record<Kind, Set<string>> = { album: new Set(), artist: new Set(), playlist: new Set() };
	const seen = new Set<string>();
	for (let offset = 0; !signal.aborted; offset += LIST_PAGE) {
		const page = await backend.getAlbums(cred, { sort: 'alphabetical', limit: LIST_PAGE, offset });
		const before = seen.size;
		for (const album of page) {
			seen.add(album.id);
			if (album.coverArt) covers.album.add(album.coverArt);
		}
		// A short page is the last one. A full page of albums already seen is a
		// server that ignores the offset, which would otherwise be read for ever.
		if (page.length < LIST_PAGE || seen.size === before) break;
	}
	if (signal.aborted) return covers;
	for (const artist of await backend.getArtists(cred)) if (artist.coverArt) covers.artist.add(artist.coverArt);
	for (const playlist of await backend.getPlaylists(cred)) if (playlist.coverArt) covers.playlist.add(playlist.coverArt);
	return covers;
}

/**
 * One cover from the music server, or null when it has none to store. A
 * rejected credential is thrown, which ends the fill: every cover after it
 * would be refused the same way.
 */
async function fetchCover(
	backend: MediaBackend,
	cred: StoredCredential,
	id: string,
	size: number,
	signal: AbortSignal
): Promise<{ type: string; body: Buffer } | null> {
	// The upstream timeout runs to the headers. This one runs to the last byte,
	// so a cover that stalls partway does not hold one of the four slots.
	const timed = AbortSignal.any([signal, AbortSignal.timeout(config().upstreamTimeoutMs * 2)]);
	try {
		const response = await backend.openCover(cred, id, size, { signal: timed });
		if (response.status !== 200 || !response.body) {
			await response.body?.cancel().catch(() => undefined);
			if (response.status === 401 || response.status === 403) {
				throw new UpstreamError('The music server rejected the credential', response.status, 'auth');
			}
			return null;
		}
		const body = await collectCover(response.body);
		return body ? { type: response.headers.get('content-type') ?? '', body } : null;
	} catch (err) {
		if (err instanceof UpstreamError && err.kind === 'auth') throw err;
		return null;
	}
}

async function run({ status, abort }: Job, backend: MediaBackend, cred: StoredCredential, scope: CoverScope) {
	const signal = abort.signal;
	const startedAt = Date.now();
	try {
		const covers = await libraryCovers(backend, cred, signal);
		if (signal.aborted) return;
		const wanted = PASSES.flatMap(({ size, of }) => of.flatMap((kind) => [...covers[kind]].map((id) => ({ id, size }))));

		/*
		 * Counted here instead of left to the sweep. Past the budget the sweep
		 * deletes the files used longest ago, which in a fill are the ones it
		 * stored first: it would go on fetching the rest of the library and
		 * deleting the start of it. It stops instead, with what fits.
		 */
		const { bytes, limitBytes } = await cacheStats();
		let held = bytes ?? 0;
		status.total = wanted.length;
		status.state = 'running';

		await mapLimited(
			wanted,
			async ({ id, size }) => {
				if (!(await holdsCover(scope, id, size))) {
					const cover = await fetchCover(backend, cred, id, size, signal);
					if (signal.aborted) return;
					const weight = cover?.body.byteLength ?? 0;
					if (held + weight > limitBytes) {
						abort.abort('full');
						return;
					}
					// Before the write, so the three other slots count it too.
					held += weight;
					if (cover && (await writeCover(scope, id, size, cover.type, cover.body))) status.stored += 1;
					else {
						held -= weight;
						status.failed += 1;
					}
				}
				status.done += 1;
			},
			FILL_FANOUT,
			signal
		);
	} catch (err) {
		if (!signal.aborted) {
			abort.abort('failed');
			log.warn('cover-fill-failed', { detail: reason(err) });
		}
	} finally {
		/*
		 * Set here, once every slot has finished, and not where the fill was
		 * told to end. Set there, a slot still writing its cover was left out
		 * of the count: a poll in CI read a full fill with 24 covers stored and
		 * 25 on disk.
		 */
		status.state = signal.aborted ? (signal.reason as FillStatus['state']) : 'done';
		log.info('cover-fill-finished', {
			state: status.state,
			covers: status.total,
			stored: status.stored,
			failed: status.failed,
			ms: Date.now() - startedAt
		});
	}
}
