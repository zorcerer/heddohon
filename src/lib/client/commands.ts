/**
 * Terminal's command line (`CommandLine.svelte`): `play kind of blue`,
 * `queue artist:miles`, `seek 1:30`, `cd albums`, `theme paper`.
 *
 * Every command does what a button or a page already does here, through the
 * same calls, so the line reaches nothing an account could not reach with the
 * pointer. Parsing and matching are plain functions, apart from the player.
 */
import { goto, invalidateAll } from '$app/navigation';
import { playContainer, playInstantMix, queueContainer } from './actions';
import { setStarred } from './favourites.svelte';
import { player } from './player.svelte';
import { ratingOf, setRating } from './ratings.svelte';
import type { Album, Artist, SearchResults, Song } from '$lib/types';

/** Something a search found, which `play`, `queue` and `mix` take. */
export type Found =
	| { kind: 'album'; item: Album }
	| { kind: 'artist'; item: Artist }
	| { kind: 'song'; item: Song };

export const label = (found: Found): string =>
	found.kind === 'album'
		? `${found.item.name}${found.item.artist ? ` · ${found.item.artist}` : ''}`
		: found.kind === 'artist'
			? found.item.name
			: `${found.item.title}${found.item.artist ? ` · ${found.item.artist}` : ''}`;

/** `album:`, `artist:` or `song:` ahead of the words, and the words. */
export function scoped(words: string): { kind: Found['kind'] | null; query: string } {
	const match = /^(album|artist|song):\s*(.*)$/i.exec(words.trim());
	return match ? { kind: match[1].toLowerCase() as Found['kind'], query: match[2].trim() } : { kind: null, query: words.trim() };
}

/**
 * What a search found, best first: a name equal to the words, then one that
 * starts with them, then one that has them. An album ahead of an artist ahead
 * of a song where they are as good, so `play kind of blue` is the album.
 */
export function ranked(results: SearchResults, words: string): Found[] {
	const { kind, query } = scoped(words);
	const q = query.toLowerCase();
	const score = (name: string) => {
		const n = name.toLowerCase();
		return n === q ? 3 : n.startsWith(q) ? 2 : n.includes(q) ? 1 : 0;
	};
	const order = { album: 0, artist: 1, song: 2 };
	const all: Found[] = [
		...results.albums.map((item) => ({ kind: 'album' as const, item })),
		...results.artists.map((item) => ({ kind: 'artist' as const, item })),
		...results.songs.map((item) => ({ kind: 'song' as const, item }))
	].filter((found) => kind === null || found.kind === kind);
	const nameOf = (found: Found) => (found.kind === 'song' ? found.item.title : found.item.name);
	// A stable sort: within one score and kind, the music server's own order.
	return all
		.map((found, at) => ({ found, at, score: score(nameOf(found)) }))
		.sort((a, b) => b.score - a.score || order[a.found.kind] - order[b.found.kind] || a.at - b.at)
		.map((entry) => entry.found);
}

/** `1:30`, `90`, `+30` or `-10`, as seconds into the track. Null for anything else. */
export function seekTarget(arg: string, now: number): number | null {
	const match = /^([+-])?(?:(\d+):)?(\d+)$/.exec(arg.trim());
	if (!match) return null;
	const seconds = Number(match[2] ?? 0) * 60 + Number(match[3]);
	if (match[1] === '+') return now + seconds;
	if (match[1] === '-') return Math.max(0, now - seconds);
	return seconds;
}

/** `60`, `+10` or `-10`, as a volume from 0 to 1. Null for anything else. */
export function volumeTarget(arg: string, now: number): number | null {
	const match = /^([+-])?(\d{1,3})%?$/.exec(arg.trim());
	if (!match) return null;
	const value = Number(match[2]) / 100;
	const next = match[1] === '+' ? now + value : match[1] === '-' ? now - value : value;
	return Math.min(1, Math.max(0, next));
}

/** Where `cd` goes, by the name the path strip shows. */
export const PLACES = [
	'albums',
	'artists',
	'genres',
	'playlists',
	'favourites',
	'folders',
	'radio',
	'history',
	'stats',
	'search',
	'library',
	'settings'
] as const;

/** The themes, and Terminal's colour schemes, as Settings offers them (`SCHEMES` in `settings.ts`). */
export const THEMES = ['terminal', 'liquid', 'paper', 'phosphor'] as const;
export const SCHEMES = [
	'heddohon',
	'nord',
	'dracula',
	'gruvbox',
	'catppuccin',
	'tokyo-night',
	'solarized',
	'one-dark',
	'monokai',
	'everforest'
] as const;

/** What a command's argument is, for what the line suggests as it is typed. */
export type Takes = 'search' | 'place' | 'theme' | 'scheme' | null;

export interface Context {
	/** The library search, as `/api/search` answers. */
	search(words: string): Promise<SearchResults>;
	/** The found item the line has selected, if one is. */
	chosen: Found | null;
	/** The page's address, for `cd ..`. */
	path: string;
}

export interface Command {
	name: string;
	aliases?: string[];
	usage: string;
	help: string;
	takes: Takes;
	/** What happened, in a few words, for the line to show. Throws with what went wrong. */
	run(arg: string, context: Context): Promise<string>;
}

class Refused extends Error {}

/** The item the words name: the one chosen in the list, or the best a search finds. */
async function find(arg: string, context: Context): Promise<Found> {
	if (context.chosen) return context.chosen;
	const { query } = scoped(arg);
	if (query.length < 2) throw new Refused('Name what to play: two letters at least.');
	const found = ranked(await context.search(arg), arg)[0];
	if (!found) throw new Refused(`Nothing in the library is called "${query}".`);
	return found;
}

function current(): Song {
	const song = player.current;
	if (!song) throw new Refused('Nothing is playing.');
	return song;
}

async function saveSettings(patch: Record<string, string>): Promise<Record<string, unknown>> {
	const response = await fetch('/api/settings', {
		method: 'PATCH',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(patch)
	});
	if (!response.ok) throw new Refused('The setting was not saved.');
	const saved = (await response.json()) as Record<string, unknown>;
	// The layout writes the theme and the scheme onto the page from its data.
	await invalidateAll();
	return saved;
}

const time = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;

export const COMMANDS: Command[] = [
	{
		name: 'play',
		usage: 'play [album:|artist:|song:]<name>',
		help: 'Plays an album, an artist or a song. Alone, carries on.',
		takes: 'search',
		async run(arg, context) {
			if (!arg.trim()) {
				await player.play();
				return 'playing';
			}
			const found = await find(arg, context);
			if (found.kind === 'song') await player.playNow([found.item]);
			else await playContainer(found.kind, found.item.id);
			return `playing ${label(found)}`;
		}
	},
	{
		name: 'queue',
		aliases: ['q'],
		usage: 'queue [album:|artist:|song:]<name>',
		help: 'Adds an album, an artist or a song to the end of the queue.',
		takes: 'search',
		async run(arg, context) {
			const found = await find(arg, context);
			if (found.kind === 'song') player.addToQueue([found.item]);
			else await queueContainer(found.kind, found.item.id);
			return `queued ${label(found)}`;
		}
	},
	{
		name: 'mix',
		usage: 'mix [album:|artist:|song:]<name>',
		help: 'Plays music like an album, an artist or a song. Alone, like the one playing.',
		takes: 'search',
		async run(arg, context) {
			const found: Found = arg.trim() || context.chosen ? await find(arg, context) : { kind: 'song', item: current() };
			if (!(await playInstantMix(found.kind, found.item.id))) throw new Refused('The music server knows nothing like that.');
			return `mixing from ${label(found)}`;
		}
	},
	{
		name: 'daily',
		usage: 'daily [1|2|3]',
		help: "Plays one of today's daily mixes.",
		takes: null,
		async run(arg) {
			const n = arg.trim() || '1';
			if (!/^[123]$/.test(n)) throw new Refused('There are daily mixes 1 to 3.');
			const before = player.queue;
			await playContainer('daily', n);
			if (player.queue === before) throw new Refused(`There is no daily mix ${n} today.`);
			return `playing daily mix ${n}`;
		}
	},
	{
		name: 'pause',
		usage: 'pause',
		help: 'Pauses.',
		takes: null,
		async run() {
			player.pause();
			return 'paused';
		}
	},
	{
		name: 'next',
		aliases: ['n', 'skip'],
		usage: 'next',
		help: 'Skips to the next track.',
		takes: null,
		async run() {
			await player.next();
			return player.current ? `playing ${player.current.title}` : 'the end of the queue';
		}
	},
	{
		name: 'prev',
		aliases: ['previous', 'back'],
		usage: 'prev',
		help: 'Goes back a track, or to the start of this one.',
		takes: null,
		async run() {
			await player.previous();
			return player.current ? `playing ${player.current.title}` : 'nothing playing';
		}
	},
	{
		name: 'seek',
		usage: 'seek <1:30|90|+30|-10>',
		help: 'Goes to a time in the track, or forward or back by seconds.',
		takes: null,
		async run(arg) {
			current();
			const target = seekTarget(arg, player.currentTime);
			if (target === null) throw new Refused('Give a time: 1:30, 90, +30 or -10.');
			player.seek(target);
			return `at ${time(player.currentTime)}`;
		}
	},
	{
		name: 'vol',
		aliases: ['volume'],
		usage: 'vol <0-100|+10|-10>',
		help: 'Sets the volume.',
		takes: null,
		async run(arg) {
			const target = volumeTarget(arg, player.volume);
			if (target === null) throw new Refused('Give a volume from 0 to 100, or +10 or -10.');
			player.setVolume(target);
			return `volume ${Math.round(target * 100)}`;
		}
	},
	{
		name: 'mute',
		usage: 'mute',
		help: 'Mutes, or unmutes.',
		takes: null,
		async run() {
			player.toggleMute();
			return player.muted ? 'muted' : 'unmuted';
		}
	},
	{
		name: 'shuffle',
		usage: 'shuffle',
		help: 'Shuffles the queue, or puts it back in order.',
		takes: null,
		async run() {
			player.toggleShuffle();
			return player.shuffle ? 'shuffle on' : 'shuffle off';
		}
	},
	{
		name: 'repeat',
		usage: 'repeat',
		help: 'Repeats nothing, the queue, or the track, in turn.',
		takes: null,
		async run() {
			player.cycleRepeat();
			return `repeat ${player.repeat}`;
		}
	},
	{
		name: 'sleep',
		usage: 'sleep <minutes|track|off>',
		help: 'Pauses after a number of minutes, at the end of the track, or not.',
		takes: null,
		async run(arg) {
			const value = arg.trim().toLowerCase();
			if (value === 'off') {
				player.setSleep(null);
				return 'sleep timer off';
			}
			if (value === 'track') {
				player.setSleep('track');
				return 'pausing at the end of this track';
			}
			const minutes = Number(value);
			if (!Number.isInteger(minutes) || minutes < 1 || minutes > 600) throw new Refused('Give minutes from 1 to 600, track or off.');
			player.setSleep(minutes);
			return `pausing in ${minutes} minutes`;
		}
	},
	{
		name: 'fav',
		aliases: ['like'],
		usage: 'fav',
		help: 'Marks the playing track as a favourite.',
		takes: null,
		async run() {
			const song = current();
			await setStarred('song', song.id, true);
			return `${song.title} is a favourite`;
		}
	},
	{
		name: 'unfav',
		usage: 'unfav',
		help: 'Takes the favourite mark off the playing track.',
		takes: null,
		async run() {
			const song = current();
			await setStarred('song', song.id, false);
			return `${song.title} is not a favourite`;
		}
	},
	{
		name: 'rate',
		usage: 'rate <0-5>',
		help: 'Rates the playing track, or clears its rating with 0. Navidrome only.',
		takes: null,
		async run(arg) {
			const song = current();
			const rating = Number(arg.trim());
			if (!/^[0-5]$/.test(arg.trim())) throw new Refused('Give a rating from 0 to 5.');
			if (song.rating === null) throw new Refused('This music server keeps no ratings.');
			await setRating('song', song.id, rating, ratingOf('song', song.id, song.rating ?? 0));
			return rating === 0 ? 'rating cleared' : `rated ${rating}`;
		}
	},
	{
		name: 'cd',
		aliases: ['go'],
		usage: 'cd <albums|artists|…|..|~>',
		help: 'Goes to a page of the library. Alone, or ~, home; .. one up.',
		takes: 'place',
		async run(arg, context) {
			const to = arg.trim().replace(/^\/+|\/+$/g, '').toLowerCase();
			if (!to || to === '~') {
				await goto('/');
				return '~';
			}
			if (to === '..') {
				const up = context.path.split('/').filter(Boolean).slice(0, -1);
				await goto(`/${up.join('/')}`);
				return `~/${up.join('/')}`;
			}
			if (!(PLACES as readonly string[]).includes(to)) throw new Refused(`There is no ${to}. Try ${PLACES.slice(0, 4).join(', ')}…`);
			await goto(`/${to}`);
			return `~/${to}`;
		}
	},
	{
		name: 'search',
		aliases: ['find'],
		usage: 'search <words>',
		help: 'Opens the search page for the words.',
		takes: null,
		async run(arg) {
			if (!arg.trim()) throw new Refused('Give the words to search for.');
			await goto(`/search?q=${encodeURIComponent(arg.trim())}`);
			return `searching for ${arg.trim()}`;
		}
	},
	{
		name: 'theme',
		usage: 'theme <terminal|liquid|paper|phosphor>',
		help: "Changes the theme. The command line is Terminal's, and goes with it.",
		takes: 'theme',
		async run(arg) {
			const theme = arg.trim().toLowerCase();
			if (!(THEMES as readonly string[]).includes(theme)) throw new Refused(`Themes: ${THEMES.join(', ')}.`);
			await saveSettings({ theme });
			return `theme ${theme}`;
		}
	},
	{
		name: 'scheme',
		usage: 'scheme <nord|dracula|…>',
		help: "Changes Terminal's colour scheme.",
		takes: 'scheme',
		async run(arg) {
			const scheme = arg.trim().toLowerCase();
			if (!(SCHEMES as readonly string[]).includes(scheme)) throw new Refused(`Schemes: ${SCHEMES.join(', ')}.`);
			await saveSettings({ scheme });
			return `scheme ${scheme}`;
		}
	}
];

/** The command a typed name is, by its name or one of its aliases. */
export function commandNamed(name: string): Command | null {
	const n = name.toLowerCase();
	return COMMANDS.find((command) => command.name === n || command.aliases?.includes(n)) ?? null;
}

/** The line as a command and its argument. */
export function parse(line: string): { name: string; arg: string } {
	const trimmed = line.replace(/^\s*:?\s*/, '');
	const space = trimmed.search(/\s/);
	return space < 0 ? { name: trimmed, arg: '' } : { name: trimmed.slice(0, space), arg: trimmed.slice(space + 1) };
}

/** Runs a line. What happened, or what went wrong, as `{ ok, message }`. */
export async function run(line: string, context: Context): Promise<{ ok: boolean; message: string }> {
	const { name, arg } = parse(line);
	if (!name) return { ok: false, message: 'Type a command, or help.' };
	if (name === 'help' || name === '?') return { ok: true, message: COMMANDS.map((command) => command.name).join(' ') };
	const command = commandNamed(name);
	if (!command) return { ok: false, message: `${name}: no such command. Type help.` };
	try {
		return { ok: true, message: await command.run(arg, context) };
	} catch (err) {
		if (err instanceof Refused) return { ok: false, message: err.message };
		return { ok: false, message: `${command.name} failed` };
	}
}
