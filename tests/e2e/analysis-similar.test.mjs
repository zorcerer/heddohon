/**
 * Songs that sound alike (issue #321), without the app: the index over
 * measured vectors, and albums folded from the nearest songs as the asking
 * account sees them.
 *
 *   node --test tests/e2e/analysis-similar.test.mjs
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const typescript = Boolean(process.features.typescript);
const skip = typescript ? false : `Node ${process.version} does not strip TypeScript types (22.18 and later do)`;
const { SoundIndex, soundAlikeAlbums } = typescript ? await import('../../src/lib/server/analysis/similar.ts') : {};
const { VECTOR_LENGTH } = typescript ? await import('../../src/lib/server/analysis/features.ts') : {};

/** A seeded random number in [0, 1), so a run is the same each time. */
function random(seed) {
	let state = seed;
	return () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

/**
 * Songs in three kinds, ten each, near their kind's centre. Value 0 is a
 * measure on a scale a thousand times the others and says nothing about the
 * kind: compared raw, it would decide every answer.
 */
function library() {
	const next = random(7);
	const centres = [0, 1, 2].map(() => Array.from({ length: VECTOR_LENGTH }, () => next() * 2 - 1));
	const ids = [];
	const vectors = new Float32Array(30 * VECTOR_LENGTH);
	for (let kind = 0; kind < 3; kind++) {
		for (let n = 0; n < 10; n++) {
			const i = kind * 10 + n;
			ids.push(`k${kind}-${n}`);
			for (let d = 0; d < VECTOR_LENGTH; d++) vectors[i * VECTOR_LENGTH + d] = centres[kind][d] + (next() - 0.5) * 0.2;
			vectors[i * VECTOR_LENGTH] = next() * 1000;
		}
	}
	return new SoundIndex(ids, vectors);
}

describe('the sound-alike index', { skip }, () => {
	test('answers with songs of the seeds’ kind, nearest first, the seeds left out', () => {
		const index = library();
		assert.equal(index.size, 30);
		const near = index.nearest(['k1-0', 'k1-1'], 8);
		assert.equal(near.length, 8);
		assert.ok(near.every((id) => id.startsWith('k1-')), near.join());
		assert.ok(!near.includes('k1-0') && !near.includes('k1-1'));
	});

	test('a song unknown to it counts for nothing, and none known is no answer', () => {
		const index = library();
		assert.ok(index.nearest(['k2-0', 'not-measured'], 5).every((id) => id.startsWith('k2-')));
		assert.deepEqual(index.nearest(['not-measured'], 5), []);
		assert.deepEqual(new SoundIndex([], new Float32Array(0)).nearest(['k0-0'], 5), []);
	});
});

describe('albums folded from the nearest songs', { skip }, () => {
	/** Each song its own album, `al-<kind>-<n / 2>`: two songs an album. Artist `ar-<kind>`, but kind 2's are by `ar-seed`. */
	const songOf = (id) => {
		const [, kind, n] = /^k(\d)-(\d+)$/.exec(id);
		return {
			id,
			title: id,
			albumId: `al-${kind}-${Math.floor(Number(n) / 2)}`,
			album: `Album ${kind}-${Math.floor(Number(n) / 2)}`,
			artistId: kind === '2' ? 'ar-seed' : `ar-${kind}`,
			artist: `Artist ${kind}`,
			albumArtist: null,
			year: 2001,
			genre: null,
			coverArt: `al-${kind}`
		};
	};

	test('as the asking account sees them: a song its login does not get never makes an album appear', async () => {
		const index = library();
		// The account cannot see album 1-1 (songs k1-2 and k1-3), as a library it has no access to.
		const hidden = new Set(['k1-2', 'k1-3']);
		const asked = [];
		const lookup = async (ids) => {
			asked.push(...ids);
			return ids.filter((id) => !hidden.has(id)).map(songOf);
		};
		const albums = await soundAlikeAlbums(index, lookup, ['k1-0', 'k1-1'], 'ar-seed', new Set(['al-1-0']), 8);
		assert.ok(asked.includes('k1-2'), 'the hidden songs were never among the nearest, so the check proves nothing');
		assert.ok(!albums.some((album) => album.id === 'al-1-1'), albums.map((album) => album.id).join());
		// Folded: one card an album, the seed's own album and the held ones left out.
		assert.equal(new Set(albums.map((album) => album.id)).size, albums.length);
		assert.ok(!albums.some((album) => album.id === 'al-1-0'));
		assert.ok(albums.slice(0, 3).every((album) => album.id.startsWith('al-1-')), albums.map((album) => album.id).join());
		// A card made from the song: its album's name, artist and cover.
		assert.deepEqual(
			{ name: albums[0].name, artist: albums[0].artist, coverArt: albums[0].coverArt },
			{ name: `Album 1-${albums[0].id.split('-')[2]}`, artist: 'Artist 1', coverArt: 'al-1' }
		);
	});

	test("leaves out the seed's artist, whose own albums are above the shelf, and stops at the limit", async () => {
		const index = library();
		const lookup = async (ids) => ids.map(songOf);
		const albums = await soundAlikeAlbums(index, lookup, ['k2-0', 'k2-1'], 'ar-seed', new Set(), 2);
		assert.equal(albums.length, 2);
		assert.ok(albums.every((album) => album.artistId !== 'ar-seed'), albums.map((album) => album.id).join());
	});

	test('with nothing measured near the seeds, nothing is looked up', async () => {
		let looked = false;
		const albums = await soundAlikeAlbums(library(), async () => ((looked = true), []), ['not-measured'], null, new Set(), 8);
		assert.deepEqual(albums, []);
		assert.equal(looked, false);
	});
});
