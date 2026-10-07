/**
 * Per-account preferences and playback state. Stored on the server, not in
 * localStorage, so they follow the account to every browser.
 */
import { now, store } from './db';
import type { AlbumSort } from '$lib/types';

export type ThemeName = 'dark' | 'light';

/**
 * Themes were once named after the Nord palette. Accounts from before the
 * rename hold the old value, which would otherwise be sanitised to the
 * default: a light-theme user put on the dark one.
 */
const LEGACY_THEMES: Record<string, ThemeName> = { polar: 'dark', snow: 'light' };
type CrossfadeMode = 'off' | 'gapless' | 'crossfade';

/**
 * Codecs a music server may be asked to transcode to: the three Navidrome
 * ships a converter for and Jellyfin can produce.
 */
const TRANSCODE_CODECS = ['mp3', 'opus', 'aac'] as const;
type TranscodeCodec = (typeof TRANSCODE_CODECS)[number];

/** Bitrates offered, in kbps. */
const TRANSCODE_BITRATES = [96, 128, 192, 256, 320] as const;

export interface UserSettings {
	theme: ThemeName;
	/** 0…1, applied to the audio element. */
	volume: number;
	/**
	 * How consecutive tracks are joined: `off` cuts with no pre-buffering,
	 * `gapless` buffers ahead so the cut does not wait on the network,
	 * `crossfade` overlaps them for `crossfadeSeconds`.
	 */
	transition: CrossfadeMode;
	/** Overlap length, 1–12s. Only read when `transition` is `crossfade`. */
	crossfadeSeconds: number;
	/**
	 * Whether a crossfade also overlaps consecutive tracks of one album. Off by
	 * default: a live album or a mix runs from one track into the next.
	 */
	crossfadeWithinAlbum: boolean;
	/** Level each track by its ReplayGain data. */
	normalizeVolume: boolean;
	/** Send now-playing / scrobble events upstream. */
	reportPlayback: boolean;
	/** Days the listening history is kept, or 0 for as long as the account exists. See `history.ts`. */
	historyDays: 0 | 90 | 365;
	/**
	 * Whether plays the Navidrome plugin reports from other apps go into the
	 * history; see `plugin.ts`. Read only where the plugin is configured.
	 */
	historyOtherApps: boolean;
	/**
	 * Whether what the account plays in other apps, which the Navidrome plugin
	 * reports, is shown to the other accounts with what it plays here. Read
	 * only for an account that is shown at all; see `listening.ts`.
	 */
	listeningOtherApps: boolean;
	/**
	 * The aurora behind the glass. Moving, it changes three times a second and
	 * every glass surface above redraws its blur. Off, it is not in the page.
	 * See `.aurora` in app.css.
	 */
	aurora: 'moving' | 'still' | 'off';
	/** Show the technical badge (FLAC 24/96) beside the transport. */
	showQualityBadge: boolean;
	/** Grid density on library pages. */
	gridSize: 'compact' | 'comfortable' | 'roomy';
	/**
	 * Interface scale, as a percentage, applied as the root font-size. The
	 * first implementation used `zoom` and pushed the player off the edge of an
	 * iPad.
	 */
	uiScale: '100' | '110' | '125' | '150' | '175';
	/**
	 * The interface typeface: a self-hosted face or the device's own. Written
	 * on the root by the server, like the theme. See `[data-font]` in app.css.
	 */
	font: 'manrope' | 'inter' | 'geist' | 'plex' | 'atkinson' | 'system';
	/** Preload the next track's first bytes while the current one plays. */
	preloadNext: boolean;
	defaultAlbumSort: AlbumSort;
	/**
	 * Ask the music server to transcode instead of sending the file as it is,
	 * for mobile data, a slow connection or a browser that cannot decode the
	 * file. The quality badge in the player toggles it.
	 */
	transcode: boolean;
	transcodeCodec: TranscodeCodec;
	/** kbps asked of the music server, which may cap it lower. */
	transcodeBitrateKbps: number;
	/**
	 * Whether the install card was dismissed. Kept on the account, so it holds
	 * on every device. See `InstallCard.svelte`.
	 */
	installCardDismissed: boolean;
}

/**
 * Each theme's ground, `--bg-base` in app.css, for what is painted before the
 * stylesheet loads: `theme-color` in the served page and the manifest's
 * colours.
 */
export const THEME_GROUND: Record<ThemeName, string> = { dark: '#0b0c0f', light: '#f0e7d5' };

export const DEFAULT_SETTINGS: UserSettings = {
	theme: 'dark',
	volume: 0.85,
	transition: 'gapless',
	crossfadeSeconds: 4,
	crossfadeWithinAlbum: false,
	normalizeVolume: false,
	reportPlayback: true,
	historyDays: 0,
	historyOtherApps: true,
	// Off until the account turns it on: it shows the other accounts more of it.
	listeningOtherApps: false,
	aurora: 'moving',
	showQualityBadge: true,
	gridSize: 'comfortable',
	uiScale: '100',
	font: 'manrope',
	preloadNext: true,
	defaultAlbumSort: 'recentlyAdded',
	transcode: false,
	transcodeCodec: 'mp3',
	transcodeBitrateKbps: 192,
	installCardDismissed: false
};

/** The sorts the album list implements, so a stored preference cannot name another. */
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

type FlagKey = { [K in keyof UserSettings]: UserSettings[K] extends boolean ? K : never }[keyof UserSettings];

/** Returns valid settings from any input. The client payload is not trusted. */
function sanitizeSettings(input: unknown, base: UserSettings = DEFAULT_SETTINGS): UserSettings {
	const raw = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
	const pick = <T extends string>(key: keyof UserSettings, allowed: readonly T[], fallback: T): T => {
		const value = raw[key];
		return allowed.includes(value as T) ? (value as T) : fallback;
	};
	const flag = (key: FlagKey): boolean => {
		const value = raw[key];
		return typeof value === 'boolean' ? value : base[key];
	};

	return {
		theme: pick(
			'theme',
			['dark', 'light'] as const,
			// `hasOwnProperty`, not a bare index: `{ theme: 'constructor' }` would
			// return a function from the prototype chain.
			Object.prototype.hasOwnProperty.call(LEGACY_THEMES, String(raw.theme))
				? LEGACY_THEMES[String(raw.theme)]
				: base.theme
		),
		volume: clamp(Number(raw.volume ?? base.volume), 0, 1, base.volume),
		transition: pick('transition', ['off', 'gapless', 'crossfade'] as const, base.transition),
		crossfadeSeconds: clamp(Number(raw.crossfadeSeconds ?? base.crossfadeSeconds), 1, 12, base.crossfadeSeconds),
		crossfadeWithinAlbum: flag('crossfadeWithinAlbum'),
		normalizeVolume: flag('normalizeVolume'),
		aurora: pick('aurora', ['moving', 'still', 'off'] as const, base.aurora),
		reportPlayback: flag('reportPlayback'),
		historyDays:
			raw.historyDays === 0 || raw.historyDays === 90 || raw.historyDays === 365 ? raw.historyDays : base.historyDays,
		historyOtherApps: flag('historyOtherApps'),
		listeningOtherApps: flag('listeningOtherApps'),
		showQualityBadge: flag('showQualityBadge'),
		gridSize: pick('gridSize', ['compact', 'comfortable', 'roomy'] as const, base.gridSize),
		// Allowlisted like the theme: interpolated into the served HTML.
		uiScale: pick('uiScale', ['100', '110', '125', '150', '175'] as const, base.uiScale),
		font: pick('font', ['manrope', 'inter', 'geist', 'plex', 'atkinson', 'system'] as const, base.font),
		preloadNext: flag('preloadNext'),
		// Allowlisted: used as a lookup key against the backends' sort maps.
		defaultAlbumSort: pick('defaultAlbumSort', ALBUM_SORTS, base.defaultAlbumSort as AlbumSort),
		transcode: flag('transcode'),
		// Both reach an upstream URL. The codec is allowlisted, and the bitrate
		// is matched against the offered set, not clamped.
		transcodeCodec: pick('transcodeCodec', TRANSCODE_CODECS, base.transcodeCodec),
		transcodeBitrateKbps: (TRANSCODE_BITRATES as readonly number[]).includes(
			Number(raw.transcodeBitrateKbps)
		)
			? Number(raw.transcodeBitrateKbps)
			: base.transcodeBitrateKbps,
		installCardDismissed: flag('installCardDismissed')
	};
}

/*
 * Read on every request, so on PostgreSQL settings are remembered for five
 * seconds per account and dropped when saved. See the session cache in auth.ts.
 */
const SETTINGS_CACHE_MS = 5000;
const settingsCache = new Map<string, { settings: UserSettings; until: number }>();
let settingsEpoch = 0;

export async function getSettings(accountId: string): Promise<UserSettings> {
	const cached = settingsCache.get(accountId);
	if (cached && cached.until > now()) return { ...cached.settings };

	const database = await store();
	// As for sessions: a read that began before a save is not cached.
	const epoch = settingsEpoch;
	const row = await database.get<{ data: string }>('SELECT data FROM settings WHERE account_id = ?', accountId);
	let settings: UserSettings;
	try {
		settings = row ? sanitizeSettings(JSON.parse(row.data)) : { ...DEFAULT_SETTINGS };
	} catch {
		settings = { ...DEFAULT_SETTINGS };
	}
	if (database.kind === 'postgres' && epoch === settingsEpoch) {
		settingsCache.set(accountId, { settings, until: now() + SETTINGS_CACHE_MS });
		if (settingsCache.size > 5000) settingsCache.delete(settingsCache.keys().next().value!);
	}
	return { ...settings };
}

export async function saveSettings(accountId: string, patch: unknown): Promise<UserSettings> {
	const merged = sanitizeSettings(patch, await getSettings(accountId));
	await (await store()).run(
		`INSERT INTO settings (account_id, data, updated_at) VALUES (?, ?, ?)
		 ON CONFLICT(account_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
		accountId,
		JSON.stringify(merged),
		now()
	);
	// After the write, so a read that began before it cannot cache what it saw.
	settingsEpoch++;
	settingsCache.delete(accountId);
	return merged;
}

/**
 * Removes an account's settings and saved queue, when its row passes to a
 * different upstream user (see `storeAccount` in auth.ts).
 */
export async function clearAccountState(accountId: string): Promise<void> {
	const database = await store();
	await database.run('DELETE FROM settings WHERE account_id = ?', accountId);
	await database.run('DELETE FROM play_state WHERE account_id = ?', accountId);
	settingsEpoch++;
	settingsCache.delete(accountId);
}

/**
 * The queue is stored as ids and a cursor. Track metadata is fetched from the
 * music server each time.
 */
export interface PersistedPlayState {
	songIds: string[];
	index: number;
	/** Seconds into the current track. */
	position: number;
	repeat: 'off' | 'all' | 'one';
	shuffle: boolean;
	/** While shuffle is on, the ids in their order before it, for turning it off. */
	orderIds: string[];
	updatedAt: number;
}

const EMPTY_PLAY_STATE: PersistedPlayState = {
	songIds: [],
	index: 0,
	position: 0,
	repeat: 'off',
	shuffle: false,
	orderIds: [],
	updatedAt: 0
};

const MAX_QUEUE = 1000;

export async function getPlayState(accountId: string): Promise<PersistedPlayState> {
	const row = await (await store()).get<{ data: string; updated_at: number | string }>(
		'SELECT data, updated_at FROM play_state WHERE account_id = ?',
		accountId
	);
	if (!row) return { ...EMPTY_PLAY_STATE };
	try {
		// When it was written, not when it was read: a browser compares it with
		// the state it holds, to tell whether another browser has played since.
		return { ...sanitizePlayState(JSON.parse(row.data)), updatedAt: Number(row.updated_at) };
	} catch {
		return { ...EMPTY_PLAY_STATE };
	}
}

function sanitizePlayState(input: unknown): PersistedPlayState {
	const raw = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
	const ids = (value: unknown) =>
		Array.isArray(value)
			? value.filter((id): id is string => typeof id === 'string' && id.length < 256).slice(0, MAX_QUEUE)
			: [];
	const songIds = ids(raw.songIds);
	const shuffle = raw.shuffle === true;
	const repeat = raw.repeat === 'all' || raw.repeat === 'one' ? raw.repeat : 'off';
	return {
		songIds,
		index: clamp(Number(raw.index ?? 0), 0, Math.max(0, songIds.length - 1), 0),
		position: clamp(Number(raw.position ?? 0), 0, 86_400, 0),
		repeat,
		shuffle,
		orderIds: shuffle ? ids(raw.orderIds) : [],
		updatedAt: now()
	};
}

export async function savePlayState(accountId: string, patch: unknown): Promise<PersistedPlayState> {
	const state = sanitizePlayState(patch);
	await (await store()).run(
		`INSERT INTO play_state (account_id, data, updated_at) VALUES (?, ?, ?)
		 ON CONFLICT(account_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
		accountId,
		JSON.stringify(state),
		state.updatedAt
	);
	return state;
}
