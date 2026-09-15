/**
 * Per-account preferences and playback state, stored server-side.
 *
 * Nothing here lives in localStorage: settings follow the account, so signing
 * in from a different browser gives the same player, and an operator wiping a
 * client device does not lose anyone's configuration.
 */
import { db, now } from './db';
import type { AlbumSort } from '$lib/types';

export type ThemeName = 'dark' | 'light';

/**
 * Themes used to be named after the Nord palette they were drawn from. The
 * palette is gone, but accounts settled before the rename still have the old
 * value stored against them, and the sanitiser would otherwise treat it as
 * unknown and quietly put everyone back on the default — so a light-theme user
 * would find themselves in the dark one with no explanation.
 */
const LEGACY_THEMES: Record<string, ThemeName> = { polar: 'dark', snow: 'light' };
export type CrossfadeMode = 'off' | 'gapless' | 'crossfade';

/**
 * Codecs a music server may be asked to transcode to.
 *
 * Three, all of which Navidrome ships a converter for out of the box and
 * Jellyfin can produce. Anything else would be a setting that silently does
 * nothing on most installations.
 */
export const TRANSCODE_CODECS = ['mp3', 'opus', 'aac'] as const;
export type TranscodeCodec = (typeof TRANSCODE_CODECS)[number];

/** Bitrates offered, in kbps. */
export const TRANSCODE_BITRATES = [96, 128, 192, 256, 320] as const;

export interface UserSettings {
	theme: ThemeName;
	/** 0…1, applied to the audio element. */
	volume: number;
	/**
	 * How consecutive tracks are joined: `off` cuts straight from one to the
	 * next with no pre-buffering, `gapless` buffers ahead so the cut does not
	 * wait on the network, `crossfade` overlaps them for `crossfadeSeconds`.
	 */
	transition: CrossfadeMode;
	/** Overlap length, 1–12s. Only read when `transition` is `crossfade`. */
	crossfadeSeconds: number;
	/** Replay Gain style normalisation. Off by default: it is lossy by nature. */
	normalizeVolume: boolean;
	/** Send now-playing / scrobble events upstream. */
	reportPlayback: boolean;
	/** Show the technical badge (FLAC 24/96) beside the transport. */
	showQualityBadge: boolean;
	/** Grid density on library pages. */
	gridSize: 'compact' | 'comfortable' | 'roomy';
	/**
	 * Interface scale, as a percentage. Applied as the root font-size, which
	 * every length in the interface is written against.
	 *
	 * Defaults to 100 rather than to a larger number: the first implementation
	 * used `zoom` and pushed the player off the edge of an iPad, so the default
	 * is the setting known to be right everywhere and the rest are opt-in.
	 */
	uiScale: '100' | '110' | '125' | '150' | '175';
	/** Preload the next track's first bytes while the current one plays. */
	preloadNext: boolean;
	defaultAlbumSort: AlbumSort;
	/**
	 * Ask the music server to transcode, rather than sending the file as it is.
	 *
	 * Off by default, and off is the point of the player. It is here for the
	 * cases where the original cannot be afforded: a phone on mobile data, a
	 * connection that will not carry a 24/192 master, a browser that cannot
	 * decode the file at all. The quality badge in the player toggles it, so it
	 * can be turned on for one album and off again without opening settings.
	 */
	transcode: boolean;
	transcodeCodec: TranscodeCodec;
	/** kbps. What the music server is asked for; it may cap it lower. */
	transcodeBitrateKbps: number;
}

export const DEFAULT_SETTINGS: UserSettings = {
	theme: 'dark',
	volume: 0.85,
	transition: 'gapless',
	crossfadeSeconds: 4,
	normalizeVolume: false,
	reportPlayback: true,
	showQualityBadge: true,
	gridSize: 'comfortable',
	uiScale: '100',
	preloadNext: true,
	defaultAlbumSort: 'recentlyAdded',
	transcode: false,
	transcodeCodec: 'mp3',
	transcodeBitrateKbps: 192
};

/** The sorts the album list actually implements. Kept here so the stored
    preference cannot name one that does not exist. */
const ALBUM_SORTS = [
	'recentlyAdded',
	'recentlyPlayed',
	'mostPlayed',
	'alphabetical',
	'byArtist',
	'byYear',
	'random',
	'starred'
] as const satisfies readonly AlbumSort[];

function clamp(value: number, min: number, max: number, fallback: number): number {
	return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

/** Accepts anything, returns something valid. Never trusts the client payload. */
export function sanitizeSettings(input: unknown, base: UserSettings = DEFAULT_SETTINGS): UserSettings {
	const raw = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
	const pick = <T extends string>(key: keyof UserSettings, allowed: readonly T[], fallback: T): T => {
		const value = raw[key];
		return allowed.includes(value as T) ? (value as T) : fallback;
	};

	return {
		theme: pick(
			'theme',
			['dark', 'light'] as const,
			// `hasOwnProperty`, not a bare index: `{ theme: 'constructor' }` walks
			// the prototype chain and hands back a function, which is not a theme
			// name and has no business reaching the HTML transform.
			Object.prototype.hasOwnProperty.call(LEGACY_THEMES, String(raw.theme))
				? LEGACY_THEMES[String(raw.theme)]
				: base.theme
		),
		volume: clamp(Number(raw.volume ?? base.volume), 0, 1, base.volume),
		transition: pick('transition', ['off', 'gapless', 'crossfade'] as const, base.transition),
		crossfadeSeconds: clamp(Number(raw.crossfadeSeconds ?? base.crossfadeSeconds), 1, 12, base.crossfadeSeconds),
		normalizeVolume: typeof raw.normalizeVolume === 'boolean' ? raw.normalizeVolume : base.normalizeVolume,
		reportPlayback: typeof raw.reportPlayback === 'boolean' ? raw.reportPlayback : base.reportPlayback,
		showQualityBadge:
			typeof raw.showQualityBadge === 'boolean' ? raw.showQualityBadge : base.showQualityBadge,
		gridSize: pick('gridSize', ['compact', 'comfortable', 'roomy'] as const, base.gridSize),
		// Allowlisted like the theme: this value is interpolated into the served
		// HTML, so it must never be an arbitrary string from the request body.
		uiScale: pick('uiScale', ['100', '110', '125', '150', '175'] as const, base.uiScale),
		preloadNext: typeof raw.preloadNext === 'boolean' ? raw.preloadNext : base.preloadNext,
		// Allowlisted rather than "any string": this value is stored per account and
		// later used as a lookup key against the backends' sort maps.
		defaultAlbumSort: pick('defaultAlbumSort', ALBUM_SORTS, base.defaultAlbumSort as AlbumSort),
		transcode: typeof raw.transcode === 'boolean' ? raw.transcode : base.transcode,
		// Both of these reach an upstream URL, so neither may be an arbitrary
		// string or number from a request body: one is allowlisted and the other
		// is matched against the offered set rather than clamped, so a value
		// between two steps cannot be stored.
		transcodeCodec: pick('transcodeCodec', TRANSCODE_CODECS, base.transcodeCodec),
		transcodeBitrateKbps: (TRANSCODE_BITRATES as readonly number[]).includes(
			Number(raw.transcodeBitrateKbps)
		)
			? Number(raw.transcodeBitrateKbps)
			: base.transcodeBitrateKbps
	};
}

export function getSettings(accountId: string): UserSettings {
	const row = db()
		.prepare<[string], { data: string }>('SELECT data FROM settings WHERE account_id = ?')
		.get(accountId);
	if (!row) return { ...DEFAULT_SETTINGS };
	try {
		return sanitizeSettings(JSON.parse(row.data));
	} catch {
		return { ...DEFAULT_SETTINGS };
	}
}

export function saveSettings(accountId: string, patch: unknown): UserSettings {
	const merged = sanitizeSettings(patch, getSettings(accountId));
	db()
		.prepare(
			`INSERT INTO settings (account_id, data, updated_at) VALUES (?, ?, ?)
			 ON CONFLICT(account_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`
		)
		.run(accountId, JSON.stringify(merged), now());
	return merged;
}

/**
 * The queue is persisted as ids plus a cursor, not as full track metadata:
 * metadata is always re-fetched from the music server so it cannot go stale,
 * and the stored row stays small.
 */
export interface PersistedPlayState {
	songIds: string[];
	index: number;
	/** Seconds into the current track. */
	position: number;
	repeat: 'off' | 'all' | 'one';
	shuffle: boolean;
	updatedAt: number;
}

const EMPTY_PLAY_STATE: PersistedPlayState = {
	songIds: [],
	index: 0,
	position: 0,
	repeat: 'off',
	shuffle: false,
	updatedAt: 0
};

const MAX_QUEUE = 1000;

export function getPlayState(accountId: string): PersistedPlayState {
	const row = db()
		.prepare<[string], { data: string }>('SELECT data FROM play_state WHERE account_id = ?')
		.get(accountId);
	if (!row) return { ...EMPTY_PLAY_STATE };
	try {
		return sanitizePlayState(JSON.parse(row.data));
	} catch {
		return { ...EMPTY_PLAY_STATE };
	}
}

export function sanitizePlayState(input: unknown): PersistedPlayState {
	const raw = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
	const songIds = Array.isArray(raw.songIds)
		? raw.songIds.filter((id): id is string => typeof id === 'string' && id.length < 256).slice(0, MAX_QUEUE)
		: [];
	const repeat = raw.repeat === 'all' || raw.repeat === 'one' ? raw.repeat : 'off';
	return {
		songIds,
		index: clamp(Number(raw.index ?? 0), 0, Math.max(0, songIds.length - 1), 0),
		position: clamp(Number(raw.position ?? 0), 0, 86_400, 0),
		repeat,
		shuffle: raw.shuffle === true,
		updatedAt: now()
	};
}

export function savePlayState(accountId: string, patch: unknown): PersistedPlayState {
	const state = sanitizePlayState(patch);
	db()
		.prepare(
			`INSERT INTO play_state (account_id, data, updated_at) VALUES (?, ?, ?)
			 ON CONFLICT(account_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`
		)
		.run(accountId, JSON.stringify(state), now());
	return state;
}
