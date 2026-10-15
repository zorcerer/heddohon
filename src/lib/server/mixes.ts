/**
 * Daily mixes: up to three queues a day for each account, made from the
 * artists it has played most here in the last 30 days.
 *
 * Each mix takes two of those artists as its seeds. It is filled from what the
 * music server finds like them (`getInstantMix`, which on Navidrome is Last.fm
 * or AudioMuse-AI and on Jellyfin its own), with one song of a seed artist in
 * every three, and leaves out what the account played in the last three days.
 * A Navidrome without an agent finds nothing alike, and the mix is then
 * filled from the seed's genre, and where that finds nothing too, from the
 * library at random.
 *
 * Made at the account's first visit of the day and kept in `daily_mixes`, so
 * a mix is the same all day and after a restart. The day is the server's,
 * by its time zone (`TZ`): the server does not know the listener's. Songs are
 * kept as the music server described them to this account (invariant 10), and
 * a mix plays from what is kept, so a track removed since fails as a stale
 * queue does.
 */
import type { Song } from '$lib/types';
import type { LibraryContext } from './library';
import { UpstreamError } from './backends';
import { artistDetail } from './details';
import { store } from './db';
import { log, reason } from './log';

/** Mixes a day. */
export const MAX_MIXES = 3;
/** Songs in a mix: about two and a half hours. */
const MIX_LENGTH = 40;
/** A mix shorter than this is left out. */
const MIN_LENGTH = 10;
/** Songs of one artist in a mix, other than the seeds. */
const PER_ARTIST = 3;
/** Played this recently, a song is left out. */
const RECENT_MS = 3 * 24 * 60 * 60 * 1000;
/** How far back the seeds are read. */
const SEED_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
/** Songs asked of the music server for each seed. */
const ALIKE = 50;

export interface DailyMix {
	/** 1 to `MAX_MIXES`, its place on the shelf and in its address. */
	n: number;
	title: string;
	/** The seed artists, which name the mix. */
	artists: string[];
	coverArt: string | null;
	songs: Song[];
}

/** A mix without its songs, for the shelf. */
export interface DailyMixSummary {
	n: number;
	title: string;
	subtitle: string;
	coverArt: string | null;
	count: number;
}

/** The server's date, as `made_on` holds it. */
function today(now: number): string {
	const date = new Date(now);
	const pad = (n: number) => String(n).padStart(2, '0');
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Mixes being made, by account, so two requests at once make them once. */
const making = new Map<string, Promise<DailyMix[]>>();

/** Today's mixes for the account, made now if they were not yet today. */
export function dailyMixes(ctx: LibraryContext, now = Date.now()): Promise<DailyMix[]> {
	const running = making.get(ctx.accountId);
	if (running) return running;
	const work = (async () => {
		const database = await store();
		const day = today(now);
		const kept = await database.get<{ made_on: string; data: string }>(
			'SELECT made_on, data FROM daily_mixes WHERE account_id = ?',
			ctx.accountId
		);
		if (kept?.made_on === day) {
			try {
				return JSON.parse(kept.data) as DailyMix[];
			} catch {
				// Made again below.
			}
		}
		const mixes = await makeMixes(ctx, now);
		if (mixes === null) return [];
		await database.run(
			`INSERT INTO daily_mixes (account_id, made_on, made_at, data) VALUES (?, ?, ?, ?)
			 ON CONFLICT (account_id) DO UPDATE SET made_on = excluded.made_on, made_at = excluded.made_at, data = excluded.data`,
			ctx.accountId,
			day,
			now,
			JSON.stringify(mixes)
		);
		log.info('daily-mixes-made', { account: ctx.accountId, mixes: mixes.length, songs: mixes.reduce((sum, mix) => sum + mix.songs.length, 0) });
		return mixes;
	})();
	making.set(ctx.accountId, work);
	return work.finally(() => making.delete(ctx.accountId));
}

export function summary(mix: DailyMix): DailyMixSummary {
	const names = mix.artists.join(', ');
	return { n: mix.n, title: mix.title, subtitle: `${names} and more`, coverArt: mix.coverArt, count: mix.songs.length };
}

/** Forgets the account's mixes, as when its name is given to another user. */
export async function clearMixes(accountId: string): Promise<void> {
	await (await store()).run('DELETE FROM daily_mixes WHERE account_id = ?', accountId);
}

interface Seed {
	id: string;
	name: string;
}

/** The artists played most since `from`, by plays, with the songs of theirs played most. */
async function seedArtists(accountId: string, from: number): Promise<(Seed & { songIds: string[] })[]> {
	const database = await store();
	const artists = await database.all<{ id: string; name: string }>(
		`SELECT artist_id AS id, MAX(artist) AS name FROM plays
		 WHERE account_id = ? AND played_at >= ? AND artist_id IS NOT NULL AND artist IS NOT NULL
		 GROUP BY artist_id ORDER BY COUNT(*) DESC, MAX(played_at) DESC LIMIT ${MAX_MIXES * 2}`,
		accountId,
		from
	);
	return Promise.all(
		artists.map(async (artist) => {
			const songs = await database.all<{ song_id: string }>(
				`SELECT song_id FROM plays WHERE account_id = ? AND artist_id = ? AND played_at >= ?
				 GROUP BY song_id ORDER BY COUNT(*) DESC LIMIT 8`,
				accountId,
				artist.id,
				from
			);
			return { ...artist, songIds: songs.map((song) => song.song_id) };
		})
	);
}

async function recentlyPlayed(accountId: string, from: number): Promise<Set<string>> {
	const rows = await (await store()).all<{ song_id: string }>(
		'SELECT DISTINCT song_id FROM plays WHERE account_id = ? AND played_at >= ?',
		accountId,
		from
	);
	return new Set(rows.map((row) => row.song_id));
}

/** A call that may come back empty or fail without failing the mix. The credential refused fails it. */
async function tolerant<T>(call: Promise<T[]>, what: string): Promise<T[]> {
	try {
		return await call;
	} catch (err) {
		if (err instanceof UpstreamError && err.kind === 'auth') throw err;
		log.debug('daily-mix-part-failed', { what, detail: reason(err) });
		return [];
	}
}

async function makeMixes(ctx: LibraryContext, now: number): Promise<DailyMix[] | null> {
	const { backend, credential, accountId } = ctx;
	const seeds = await seedArtists(accountId, now - SEED_WINDOW_MS);
	// Nothing played yet: nothing is kept, so the first plays of the day make
	// mixes at the next visit and not the day after.
	if (seeds.length === 0) return null;
	const played = await recentlyPlayed(accountId, now - RECENT_MS);
	// A song already in an earlier mix of the day goes last in the next, so the
	// mixes differ where the music server has enough alike and still fill where
	// it does not: the artists like two seeds overlap.
	const used = new Set<string>();

	// Seeds 1 and 4 make the first mix, 2 and 5 the second: the most played
	// artists each lead one.
	const groups = Array.from({ length: Math.min(MAX_MIXES, seeds.length) }, (_, i) =>
		[seeds[i], seeds[i + MAX_MIXES]].filter((seed): seed is (typeof seeds)[number] => Boolean(seed))
	);

	const mixes: DailyMix[] = [];
	for (const group of groups) {
		const [alike, own] = await Promise.all([
			Promise.all(group.map((seed) => tolerant(backend.getInstantMix(credential, 'artist', seed.id, ALIKE), 'alike'))),
			Promise.all(
				group.map(async (seed) => {
					// The account's own favourites of the artist first, then what the
					// music server ranks highest.
					const mine = await tolerant(backend.getSongs(credential, seed.songIds), 'own');
					const top = await tolerant(
						artistDetail(ctx, seed.id).then((artist) => artist.topSongs),
						'top'
					);
					return [...mine, ...top];
				})
			)
		]);
		let pool = interleave(alike);
		if (pool.length === 0 && backend.kind === 'subsonic') {
			// Navidrome without an agent: the seed's genre, which on Subsonic is its id.
			const genre = own.flat().find((song) => song.genre)?.genre;
			if (genre) pool = await tolerant(backend.getGenreSongs(credential, genre, ALIKE * 2), 'genre');
		}
		if (pool.length === 0) {
			// Nothing alike and no genre to go by. Jellyfin 12.1.0 answered the
			// instant mix of both of the test rig's artists with nothing, and its
			// genres are asked for by an id the history does not hold. The mix is
			// then the seeds' own songs and the library at random.
			pool = await tolerant(backend.getRandomSongs(credential, ALIKE), 'random');
		}
		const seedIds = new Set(group.map((seed) => seed.id));
		const fresh = (song: Song) => !used.has(song.id);
		const unusedFirst = (songs: Song[]) => [...songs.filter(fresh), ...songs.filter((song) => !fresh(song))];
		// What the music server finds alike that is by a seed counts as the
		// seed's own: in a library of a few artists that is most of it, and set
		// aside, the rig's 181 tracks by two artists made no mix at all.
		const bySeed = (song: Song) => Boolean(song.artistId && seedIds.has(song.artistId));
		const songs = compose(
			unusedFirst(pool.filter((song) => !bySeed(song))),
			unusedFirst([...interleave(own), ...pool.filter(bySeed)]),
			(song) => !played.has(song.id)
		);
		if (songs.length < MIN_LENGTH) continue;
		for (const song of songs) used.add(song.id);
		mixes.push({
			n: mixes.length + 1,
			title: `Daily mix ${mixes.length + 1}`,
			artists: group.map((seed) => seed.name),
			coverArt: songs.find((song) => song.coverArt)?.coverArt ?? null,
			songs
		});
	}
	return mixes;
}

/** The lists taken in turn, one item of each, so no one seed leads a mix. */
function interleave<T>(lists: T[][]): T[] {
	const out: T[] = [];
	for (let i = 0; lists.some((list) => i < list.length); i++) {
		for (const list of lists) if (i < list.length) out.push(list[i]);
	}
	return out;
}

/**
 * Two songs alike, then one of a seed artist's, to `MIX_LENGTH`. A song kept
 * once, by `keep`, and at most `PER_ARTIST` of any artist but the seeds.
 */
function compose(alike: Song[], own: Song[], keep: (song: Song) => boolean): Song[] {
	const out: Song[] = [];
	const seen = new Set<string>();
	const perArtist = new Map<string, number>();
	const take = (from: Song[], limited: boolean): boolean => {
		while (from.length > 0) {
			const song = from.shift()!;
			if (seen.has(song.id) || !keep(song)) continue;
			const artist = song.artistId ?? song.artist ?? '';
			if (limited && (perArtist.get(artist) ?? 0) >= PER_ARTIST) continue;
			seen.add(song.id);
			perArtist.set(artist, (perArtist.get(artist) ?? 0) + 1);
			out.push(song);
			return true;
		}
		return false;
	};
	const alikeLeft = [...alike];
	const ownLeft = [...own];
	while (out.length < MIX_LENGTH) {
		const turn = out.length % 3 === 2 ? 'own' : 'alike';
		const took = turn === 'own' ? take(ownLeft, false) || take(alikeLeft, true) : take(alikeLeft, true) || take(ownLeft, false);
		if (!took) break;
	}
	return out;
}
