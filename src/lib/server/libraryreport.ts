/**
 * The library report, under Settings, Storage, for an administrator of the
 * music server: what the library is made of, by format and resolution, and
 * what it lacks. Read from the whole library a page at a time
 * (`forEachSong`), in the background, one report at a time on this server,
 * and kept in memory for a day.
 *
 * Covers are not checked: both servers give every album a cover id whether
 * or not there is art behind it, and telling them apart is a request per
 * album. The cover cache's fill (`coverfill.ts`) reads every cover.
 */
import type { Account } from './auth';
import { backendFor, UpstreamError, type StoredCredential } from './backends';
import { log, reason } from './log';
import type { Song } from '$lib/types';

/** Entries in each list the report shows. */
const LISTED = 50;
/** How long a finished report is shown before another is asked for. */
const KEPT_MS = 24 * 60 * 60 * 1000;

export interface AlbumRef {
	id: string;
	name: string;
	artist: string | null;
}

export interface LibraryReport {
	madeAt: number;
	tracks: number;
	albums: number;
	artists: number;
	seconds: number;
	/** Of the tracks whose size the server gives. */
	bytes: number;
	lossless: number;
	lossy: number;
	/** Above 16 bits or 48kHz. */
	hiRes: number;
	/** By format, most tracks first. */
	formats: { format: string; tracks: number; bytes: number }[];
	/** Of the lossless tracks, by bit depth and sample rate, most first. */
	resolutions: { label: string; tracks: number }[];
	/** Albums with lossless and lossy tracks both, or more than one format. */
	mixed: (AlbumRef & { formats: string[] })[];
	mixedCount: number;
	/** Tracks without a ReplayGain track gain, and the albums they are on. */
	withoutReplayGain: number;
	withoutReplayGainAlbums: AlbumRef[];
	withoutGenre: number;
	withoutYear: number;
	/** The same album held more than once: one artist, one title, more than one album id. */
	duplicates: { name: string; artist: string | null; albums: (AlbumRef & { formats: string[]; tracks: number })[] }[];
	duplicateCount: number;
}

export type ReportStatus =
	| { state: 'none' }
	| { state: 'running'; tracks: number; startedAt: number }
	| { state: 'done'; report: LibraryReport }
	| { state: 'failed'; detail: string };

/** By account. One runs at a time on this server. */
const reports = new Map<string, ReportStatus>();
let running: string | null = null;

export function reportStatus(accountId: string, now = Date.now()): ReportStatus {
	const status = reports.get(accountId) ?? { state: 'none' };
	if (status.state === 'done' && now - status.report.madeAt > KEPT_MS) {
		reports.delete(accountId);
		return { state: 'none' };
	}
	return status;
}

/** Starts a report for the account. False when one is being made, for it or another account. */
export function startReport(account: Account, credential: StoredCredential): boolean {
	if (running) return false;
	running = account.id;
	const tally = new Tally();
	const startedAt = Date.now();
	reports.set(account.id, { state: 'running', tracks: 0, startedAt });
	void backendFor(account.backend)
		.forEachSong(credential, (songs) => {
			tally.add(songs);
			reports.set(account.id, { state: 'running', tracks: tally.tracks, startedAt });
		})
		.then(() => {
			const report = tally.report(Date.now());
			reports.set(account.id, { state: 'done', report });
			log.info('library-report-made', { account: account.id, tracks: report.tracks, ms: Date.now() - startedAt });
		})
		.catch((err) => {
			const detail =
				err instanceof UpstreamError && err.kind === 'auth'
					? 'The music server no longer accepts this account. Sign in again.'
					: 'The music server did not list the library. Try again.';
			reports.set(account.id, { state: 'failed', detail });
			log.warn('library-report-failed', { account: account.id, detail: reason(err) });
		})
		.finally(() => {
			running = null;
		});
	return true;
}

/** What a report counts, as the pages come in. */
class Tally {
	tracks = 0;
	#albums = new Map<string, AlbumRef & { formats: Set<string>; lossless: boolean; lossy: boolean; tracks: number }>();
	#artists = new Set<string>();
	#seconds = 0;
	#bytes = 0;
	#lossless = 0;
	#lossy = 0;
	#hiRes = 0;
	#formats = new Map<string, { tracks: number; bytes: number }>();
	#resolutions = new Map<string, number>();
	#withoutReplayGain = 0;
	#withoutReplayGainAlbums = new Map<string, AlbumRef>();
	#withoutGenre = 0;
	#withoutYear = 0;

	add(songs: Song[]) {
		for (const song of songs) {
			this.tracks++;
			this.#seconds += song.duration || 0;
			const artist = song.albumArtist ?? song.artist;
			if (song.artistId ?? artist) this.#artists.add(song.artistId ?? artist!);
			const { quality } = song;
			this.#bytes += quality.sizeBytes ?? 0;
			const format = quality.format?.toLowerCase() ?? 'unknown';
			const byFormat = this.#formats.get(format) ?? { tracks: 0, bytes: 0 };
			byFormat.tracks++;
			byFormat.bytes += quality.sizeBytes ?? 0;
			this.#formats.set(format, byFormat);
			if (quality.lossless) {
				this.#lossless++;
				if (quality.bitDepth && quality.sampleRateHz) {
					const label = `${quality.bitDepth}-bit ${quality.sampleRateHz / 1000}kHz`;
					this.#resolutions.set(label, (this.#resolutions.get(label) ?? 0) + 1);
				}
			} else if (quality.format) this.#lossy++;
			if (quality.highResolution) this.#hiRes++;
			if (!song.genre) this.#withoutGenre++;
			if (!song.year) this.#withoutYear++;

			const ref: AlbumRef | null = song.albumId ? { id: song.albumId, name: song.album ?? 'Unknown album', artist } : null;
			if (song.replayGain?.trackGain == null) {
				this.#withoutReplayGain++;
				if (ref && this.#withoutReplayGainAlbums.size < LISTED) this.#withoutReplayGainAlbums.set(ref.id, ref);
			}
			if (ref) {
				const album = this.#albums.get(ref.id) ?? { ...ref, formats: new Set(), lossless: false, lossy: false, tracks: 0 };
				album.tracks++;
				album.formats.add(format);
				if (quality.lossless) album.lossless = true;
				else if (quality.format) album.lossy = true;
				this.#albums.set(ref.id, album);
			}
		}
	}

	report(madeAt: number): LibraryReport {
		const albums = [...this.#albums.values()];
		const mixed = albums.filter((album) => (album.lossless && album.lossy) || album.formats.size > 1);
		// One title by one artist: case, spacing and an edition in brackets
		// ("(Deluxe Edition)", "[2011 Remaster]") set aside.
		const key = (album: AlbumRef) =>
			`${normalise(album.artist ?? '')}\u0000${normalise(album.name.replace(/\s*[([][^)\]]*(remaster|deluxe|edition|expanded|anniversary|bonus|version)[^)\]]*[)\]]\s*$/i, ''))}`;
		const groups = new Map<string, typeof albums>();
		for (const album of albums) {
			const group = groups.get(key(album)) ?? [];
			group.push(album);
			groups.set(key(album), group);
		}
		const duplicates = [...groups.values()].filter((group) => group.length > 1);
		const sortedBy = <T>(entries: Iterable<[string, T]>, count: (value: T) => number) =>
			[...entries].sort((a, b) => count(b[1]) - count(a[1]) || a[0].localeCompare(b[0]));
		return {
			madeAt,
			tracks: this.tracks,
			albums: albums.length,
			artists: this.#artists.size,
			seconds: Math.round(this.#seconds),
			bytes: this.#bytes,
			lossless: this.#lossless,
			lossy: this.#lossy,
			hiRes: this.#hiRes,
			formats: sortedBy(this.#formats, (entry) => entry.tracks).map(([format, entry]) => ({ format, ...entry })),
			resolutions: sortedBy(this.#resolutions, (count) => count).map(([label, tracks]) => ({ label, tracks })).slice(0, 8),
			mixed: mixed.slice(0, LISTED).map(({ id, name, artist, formats }) => ({ id, name, artist, formats: [...formats].sort() })),
			mixedCount: mixed.length,
			withoutReplayGain: this.#withoutReplayGain,
			withoutReplayGainAlbums: [...this.#withoutReplayGainAlbums.values()],
			withoutGenre: this.#withoutGenre,
			withoutYear: this.#withoutYear,
			duplicates: duplicates.slice(0, LISTED).map((group) => ({
				name: group[0].name,
				artist: group[0].artist,
				albums: group.map(({ id, name, artist, formats, tracks }) => ({ id, name, artist, formats: [...formats].sort(), tracks }))
			})),
			duplicateCount: duplicates.length
		};
	}
}

const normalise = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
