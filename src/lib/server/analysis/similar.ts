/**
 * Songs that sound alike, from the vectors sound analysis measured (issue
 * #321): an index in memory and its nearest neighbours by cosine similarity.
 *
 * The raw vectors mix measures on different scales (`features.ts`), so each
 * of the 32 values is first taken against the whole library: less its mean,
 * over its spread. Then each vector is scaled to length 1, and how alike two
 * songs are is the sum of their products, from -1 to 1.
 *
 * Imports no configuration, so `tests/e2e/analysis-similar.test.mjs` builds an
 * index of its own. `results.ts` keeps one for each music server.
 */
import type { Album, Song } from '#lib/types.ts';
import { VECTOR_LENGTH } from './features.ts';

export class SoundIndex {
	readonly #ids: string[];
	readonly #at: Map<string, number>;
	/** Scaled and of length 1, `VECTOR_LENGTH` values each, end to end. */
	readonly #vectors: Float32Array;

	constructor(songIds: string[], raw: Float32Array) {
		const count = songIds.length;
		const mean = new Float64Array(VECTOR_LENGTH);
		const spread = new Float64Array(VECTOR_LENGTH);
		for (let i = 0; i < count; i++) for (let d = 0; d < VECTOR_LENGTH; d++) mean[d] += raw[i * VECTOR_LENGTH + d] / count;
		for (let i = 0; i < count; i++) {
			for (let d = 0; d < VECTOR_LENGTH; d++) spread[d] += (raw[i * VECTOR_LENGTH + d] - mean[d]) ** 2 / count;
		}
		for (let d = 0; d < VECTOR_LENGTH; d++) spread[d] = Math.sqrt(spread[d]);

		const vectors = new Float32Array(count * VECTOR_LENGTH);
		for (let i = 0; i < count; i++) {
			let length = 0;
			for (let d = 0; d < VECTOR_LENGTH; d++) {
				// A value the same for every song says nothing about any of them.
				const value = spread[d] > 1e-9 ? (raw[i * VECTOR_LENGTH + d] - mean[d]) / spread[d] : 0;
				vectors[i * VECTOR_LENGTH + d] = value;
				length += value * value;
			}
			length = Math.sqrt(length);
			if (length > 0) for (let d = 0; d < VECTOR_LENGTH; d++) vectors[i * VECTOR_LENGTH + d] /= length;
		}
		this.#ids = songIds;
		this.#at = new Map(songIds.map((id, i) => [id, i]));
		this.#vectors = vectors;
	}

	get size(): number {
		return this.#ids.length;
	}

	/**
	 * The `count` songs nearest the seeds' mean, nearest first, the seeds left
	 * out. Seeds without a vector count for nothing; none with one is an empty
	 * answer. 50,000 songs take a few milliseconds.
	 */
	nearest(seedIds: readonly string[], count: number): string[] {
		const seeds = new Set(seedIds);
		const centre = new Float64Array(VECTOR_LENGTH);
		let found = 0;
		for (const id of seeds) {
			const at = this.#at.get(id);
			if (at === undefined) continue;
			found++;
			for (let d = 0; d < VECTOR_LENGTH; d++) centre[d] += this.#vectors[at * VECTOR_LENGTH + d];
		}
		if (found === 0 || count <= 0) return [];

		// The best `count` so far, kept in order: fewer than a hundred, so a sorted
		// insert beats sorting every score.
		const best: { at: number; score: number }[] = [];
		for (let i = 0; i < this.#ids.length; i++) {
			if (seeds.has(this.#ids[i])) continue;
			let score = 0;
			for (let d = 0; d < VECTOR_LENGTH; d++) score += centre[d] * this.#vectors[i * VECTOR_LENGTH + d];
			if (best.length === count && score <= best[best.length - 1].score) continue;
			let place = best.length;
			while (place > 0 && best[place - 1].score < score) place--;
			best.splice(place, 0, { at: i, score });
			if (best.length > count) best.pop();
		}
		return best.map(({ at }) => this.#ids[at]);
	}
}

/**
 * Up to `limit` albums whose songs sound nearest the seed songs, as the asking
 * account sees them. The nearest songs are looked up with that account's own
 * login, so a song the music server does not give it is left out (invariant
 * 10): nine times the shelf is asked for, three songs an album and three
 * times the albums shown, as several land on one album and some may be
 * hidden. Folded into albums as the server's own shelf is: not this album,
 * nor its artist's, whose own are listed above it.
 */
export async function soundAlikeAlbums(
	index: SoundIndex,
	/** The songs of these ids the asking account may see, with its own login. */
	lookup: (ids: string[]) => Promise<Song[]>,
	songIds: readonly string[],
	artistId: string | null,
	held: ReadonlySet<string>,
	limit: number
): Promise<Album[]> {
	const nearest = index.nearest(songIds, Math.min(100, limit * 9));
	if (nearest.length === 0) return [];
	const seen = new Map((await lookup(nearest)).map((song) => [song.id, song]));
	const albums = new Map<string, Album>();
	for (const id of nearest) {
		const song = seen.get(id);
		if (!song?.albumId || held.has(song.albumId) || albums.has(song.albumId)) continue;
		if (artistId !== null && song.artistId === artistId) continue;
		albums.set(song.albumId, albumOf(song));
		if (albums.size === limit) break;
	}
	return [...albums.values()];
}

/** A card for the song's album, from what the song carries. */
function albumOf(song: Song): Album {
	return {
		id: song.albumId!,
		name: song.album ?? 'Unknown album',
		artistId: song.artistId,
		artist: song.albumArtist ?? song.artist,
		year: song.year,
		genre: song.genre,
		songCount: null,
		duration: null,
		coverArt: song.coverArt,
		starred: false,
		starredAt: null,
		// The album's own rating is not on its songs.
		rating: null,
		createdAt: null
	};
}
