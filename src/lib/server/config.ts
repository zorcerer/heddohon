/**
 * Administrator-supplied configuration.
 *
 * Every value comes from the process environment and none can be influenced by
 * a request: the operator decides which upstream servers exist, and a user
 * supplies only a username and a password.
 */
import { accessSync, constants, mkdirSync, readFileSync } from 'node:fs';
import { building } from '$app/environment';

export type BackendKind = 'subsonic' | 'jellyfin';

export interface UpstreamConfig {
	kind: BackendKind;
	/** Normalised base URL, no trailing slash. */
	url: string;
	/** Human readable name shown on the login screen. */
	label: string;
}

/**
 * Where accounts, sessions, settings and links are kept. SQLite in the data
 * directory unless `HEDDOHON_DATABASE_URL` names a PostgreSQL server.
 */
type DatabaseConfig =
	| { kind: 'sqlite' }
	| {
			kind: 'postgres';
			/** The URL as given, credentials included if it carried any. Never logged. */
			connectionString: string;
			user: string | undefined;
			password: string | undefined;
			/** An `sslmode` to set on the URL, or undefined to leave the URL's own. */
			sslmode: 'disable' | 'no-verify' | 'verify-full' | undefined;
			/** Copy the SQLite database across on first start, if there is one. */
			importSqlite: boolean;
			/** `host:port/database`, for the log. */
			label: string;
	  };

export interface AppConfig {
	secret: string;
	dataDir: string;
	sessionMaxHours: number;
	cookieSecure: boolean | 'auto';
	upstreamTimeoutMs: number;
	/** Disk budget for the cover cache, in bytes. Zero switches it off. */
	coverCacheBytes: number;
	upstreams: UpstreamConfig[];
	appName: string;
	registrationHint: string | null;
	/** Whether accounts may make song links, and whether links open. */
	sharing: boolean;
	/** Whether the original file can be downloaded from the player. */
	downloads: boolean;
	/** Whether a browser can control playback on the account's other browsers; see `remote.ts`. */
	remoteControl: boolean;
	/** Whether accounts may show each other what they play; see `listening.ts`. Each account is off until it turns it on. */
	listeners: boolean;
	/** LRCLIB base URL for lyrics the music server lacks, or null when off. */
	lrclibUrl: string | null;
	/** Base URL of the AutoEq results for headphone corrections, or null when off; see `autoeq.ts`. */
	autoeqUrl: string | null;
	/** Discord's address, for posting plays to a channel's webhook, or null when off; see `integrations.ts`. */
	discordUrl: string | null;
	/** The ListenBrainz API, for scrobbles this server sends itself, or null when off; see `integrations.ts`. */
	listenbrainzUrl: string | null;
	/** Whether the library can be browsed by its folders on disk: the Folders page and playing a folder. */
	folders: boolean;
	/** Whether the music server's internet radio stations are offered and played through this server; see `radio.ts`. */
	radio: boolean;
	/** Whether a station may be on a private address. Off unless asked for. */
	radioPrivate: boolean;
	/**
	 * What the Heddohon plugin for Navidrome proves itself with, or null when
	 * its endpoint is off; see `plugin.ts`.
	 */
	navidromePluginToken: string | null;
	/**
	 * SHA-256 fingerprints of the certificates an Android app this server
	 * vouches for is signed with; see `routes/.well-known/assetlinks.json`.
	 */
	androidFingerprints: string[];
	database: DatabaseConfig;
}

export class ConfigError extends Error {}

/**
 * The SHA-256 of the certificate the released Android app is signed with, as
 * `keytool` and `apksigner` print it. The key is in the repository's secrets.
 */
const ANDROID_RELEASE_KEY =
	'3C:D0:5B:A1:45:77:D7:1F:68:4E:61:51:AF:7C:0F:3F:BE:10:15:A8:BB:52:B2:28:FA:54:B4:11:AC:14:DE:52';

/** A fingerprint as 32 pairs of hex digits with colons between, upper case. */
const FINGERPRINT = /^[0-9A-F]{2}(:[0-9A-F]{2}){31}$/;

/**
 * The released app's key and those in `HEDDOHON_ANDROID_FINGERPRINTS`, a
 * comma-separated list for an app signed by someone else. An entry that is not
 * a fingerprint is an error: the app would open with an address bar and
 * nothing would say why.
 */
function androidFingerprints(): string[] {
	const extra = (env('HEDDOHON_ANDROID_FINGERPRINTS') ?? '')
		.split(',')
		.map((entry) => entry.trim().toUpperCase())
		.filter(Boolean);
	for (const entry of extra) {
		if (!FINGERPRINT.test(entry)) {
			throw new ConfigError(
				`HEDDOHON_ANDROID_FINGERPRINTS holds ${JSON.stringify(entry)}, which is not a SHA-256 fingerprint (32 pairs of hex digits, colons between)`
			);
		}
	}
	return [...new Set([ANDROID_RELEASE_KEY, ...extra])];
}

function env(name: string): string | undefined {
	const raw = process.env[name];
	if (raw === undefined) return undefined;
	const trimmed = raw.trim();
	return trimmed === '' ? undefined : trimmed;
}

function normaliseUrl(name: string, raw: string): string {
	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch {
		throw new ConfigError(`${name} is not a valid URL: ${JSON.stringify(raw)}`);
	}
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
		throw new ConfigError(`${name} must be http:// or https://, got ${parsed.protocol}`);
	}
	if (parsed.search || parsed.hash) {
		throw new ConfigError(`${name} must not contain a query string or fragment`);
	}
	// Keeps a sub-path (Navidrome behind /music) and drops the trailing slash,
	// so callers join with `${base}/rest/...`.
	const path = parsed.pathname.replace(/\/+$/, '');
	return `${parsed.origin}${path}`;
}

function intEnv(name: string, fallback: number, min: number, max: number): number {
	const raw = env(name);
	if (raw === undefined) return fallback;
	const value = Number.parseInt(raw, 10);
	if (!Number.isFinite(value)) {
		throw new ConfigError(`${name} must be an integer, got ${JSON.stringify(raw)}`);
	}
	return Math.min(max, Math.max(min, value));
}

function boolEnv(name: string, fallback: boolean | 'auto'): boolean | 'auto' {
	const raw = env(name)?.toLowerCase();
	if (raw === undefined) return fallback;
	if (raw === 'auto') return 'auto';
	if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
	if (['0', 'false', 'no', 'off'].includes(raw)) return false;
	throw new ConfigError(`${name} must be true, false or auto`);
}

/** A plain on or off, for a setting where `boolEnv`'s `auto` means nothing. */
function flagEnv(name: string, fallback: boolean): boolean {
	const raw = env(name)?.toLowerCase();
	if (raw === undefined) return fallback;
	if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
	if (['0', 'false', 'no', 'off'].includes(raw)) return false;
	throw new ConfigError(`${name} must be true or false`);
}

/**
 * `HEDDOHON_NAVIDROME_PLUGIN_TOKEN`, which turns on the endpoint the Navidrome
 * plugin posts plays to (`plugin.ts`). Whoever holds it can add plays to the
 * history of any Navidrome account here, so it is held to the length asked of
 * `HEDDOHON_SECRET`. It is typed into Navidrome's settings, and so may not be
 * that secret, which opens every stored credential.
 */
function navidromePluginToken(secret: string): string | null {
	const token = env('HEDDOHON_NAVIDROME_PLUGIN_TOKEN');
	if (token === undefined) return null;
	if (token.length < 32) {
		throw new ConfigError(
			`HEDDOHON_NAVIDROME_PLUGIN_TOKEN must be at least 32 characters (got ${token.length}). ` +
				'Generate one with: openssl rand -hex 32'
		);
	}
	if (token === secret) {
		throw new ConfigError('HEDDOHON_NAVIDROME_PLUGIN_TOKEN must not be the value of HEDDOHON_SECRET');
	}
	return token;
}

/**
 * The session lifetime where `HEDDOHON_SESSION_HOURS` is not set: 30 days. The
 * upper bound, 100 years, keeps the expiry inside what a date holds.
 */
const DEFAULT_SESSION_HOURS = 30 * 24;
const MAX_SESSION_HOURS = 100 * 365 * 24;

/** Who this process runs as, for an error message. `getuid` is absent on Windows. */
function identity(): string {
	const uid = process.getuid?.();
	const gid = process.getgid?.();
	return uid === undefined || gid === undefined ? 'this container' : `uid ${uid}:${gid}`;
}

/**
 * The data directory, created and proven writable before anything uses it.
 *
 * Unchecked, an unwritable directory surfaced as `SQLITE_CANTOPEN` from the
 * first sign-in POST (the rate limiter is the first thing to touch the
 * database), a 500 that does not name the mount.
 *
 * `mkdirSync` alone does not catch it. Docker creates a missing bind-mount
 * source owned by root, the image runs unprivileged (99:100 on Unraid), so the
 * directory exists, `recursive: true` succeeds and the first write is denied.
 *
 * As a ConfigError it takes the path of every other misconfiguration:
 * hooks.server.ts serves a plain 500 and logs `config-invalid`, and `/healthz`
 * reports `misconfigured`, which fails the container's HEALTHCHECK.
 */
function dataDirectory(): string {
	const dir = env('HEDDOHON_DATA_DIR') ?? '/data';

	try {
		mkdirSync(dir, { recursive: true });
	} catch (err) {
		throw new ConfigError(
			`HEDDOHON_DATA_DIR ${dir} does not exist and could not be created ` +
				`(${err instanceof Error ? err.message : String(err)}). ` +
				`Heddohon runs as ${identity()}.`
		);
	}

	// W_OK to create the database, X_OK to reach anything inside. A directory
	// can grant one without the other.
	try {
		accessSync(dir, constants.W_OK | constants.X_OK);
	} catch {
		throw new ConfigError(
			`HEDDOHON_DATA_DIR ${dir} is not writable by ${identity()}. ` +
				'It holds the database and the cover cache, so nothing works without it. ' +
				'Give that user the host directory mounted there, for example ' +
				'`chown -R 99:100 /mnt/user/appdata/heddohon` on Unraid.'
		);
	}

	return dir;
}

function build(): AppConfig {
	const secret = env('HEDDOHON_SECRET');
	if (!secret) {
		throw new ConfigError(
			'HEDDOHON_SECRET is required. Generate one with: openssl rand -base64 48'
		);
	}
	if (secret.length < 32) {
		throw new ConfigError(
			`HEDDOHON_SECRET must be at least 32 characters (got ${secret.length}). ` +
				'It is the key that protects stored upstream credentials.'
		);
	}

	const upstreams: UpstreamConfig[] = [];

	const subsonicUrl = env('HEDDOHON_SUBSONIC_URL') ?? env('HEDDOHON_NAVIDROME_URL');
	if (subsonicUrl) {
		upstreams.push({
			kind: 'subsonic',
			url: normaliseUrl('HEDDOHON_SUBSONIC_URL', subsonicUrl),
			label: env('HEDDOHON_SUBSONIC_LABEL') ?? 'Navidrome'
		});
	}

	const jellyfinUrl = env('HEDDOHON_JELLYFIN_URL');
	if (jellyfinUrl) {
		upstreams.push({
			kind: 'jellyfin',
			url: normaliseUrl('HEDDOHON_JELLYFIN_URL', jellyfinUrl),
			label: env('HEDDOHON_JELLYFIN_LABEL') ?? 'Jellyfin'
		});
	}

	if (upstreams.length === 0) {
		throw new ConfigError(
			'No music server configured. Set HEDDOHON_SUBSONIC_URL (Navidrome/Subsonic) ' +
				'and/or HEDDOHON_JELLYFIN_URL.'
		);
	}

	return {
		secret,
		dataDir: dataDirectory(),
		sessionMaxHours: intEnv('HEDDOHON_SESSION_HOURS', DEFAULT_SESSION_HOURS, 1, MAX_SESSION_HOURS),
		cookieSecure: boolEnv('HEDDOHON_COOKIE_SECURE', 'auto'),
		upstreamTimeoutMs: intEnv('HEDDOHON_UPSTREAM_TIMEOUT_MS', 20_000, 1_000, 120_000),
		// Megabytes in, bytes out. 0 switches the cache off.
		coverCacheBytes: intEnv('HEDDOHON_COVER_CACHE_MB', 512, 0, 65_536) * 1024 * 1024,
		upstreams,
		appName: env('HEDDOHON_APP_NAME') ?? 'Heddohon',
		registrationHint: env('HEDDOHON_LOGIN_HINT') ?? null,
		sharing: flagEnv('HEDDOHON_SHARING', true),
		downloads: flagEnv('HEDDOHON_DOWNLOADS', true),
		// The browsers are known to one process only, so a deployment of several
		// behind a load balancer turns it off.
		remoteControl: flagEnv('HEDDOHON_REMOTE_CONTROL', true),
		// On, an account that chooses to is shown to every other account on this
		// server with what it plays. It rides on the remote control streams, so it
		// needs those too.
		listeners: flagEnv('HEDDOHON_LISTENERS', true),
		// Off unless asked for: it sends the artist, title, album and length of
		// every track whose lyrics are opened to a third party.
		lrclibUrl: flagEnv('HEDDOHON_LYRICS_LRCLIB', false)
			? normaliseUrl('HEDDOHON_LYRICS_LRCLIB_URL', env('HEDDOHON_LYRICS_LRCLIB_URL') ?? 'https://lrclib.net')
			: null,
		// Off unless asked for: the host fetched from learns this server's
		// address and the headphones chosen.
		autoeqUrl: flagEnv('HEDDOHON_AUTOEQ', false)
			? normaliseUrl(
					'HEDDOHON_AUTOEQ_URL',
					env('HEDDOHON_AUTOEQ_URL') ?? 'https://raw.githubusercontent.com/jaakkopasanen/AutoEq/master/results'
				)
			: null,
		// Both off unless asked for: an account can then send the title, artist
		// and album of what it plays to a third party it chose.
		discordUrl: flagEnv('HEDDOHON_DISCORD', false)
			? normaliseUrl('HEDDOHON_DISCORD_URL', env('HEDDOHON_DISCORD_URL') ?? 'https://discord.com')
			: null,
		listenbrainzUrl: flagEnv('HEDDOHON_LISTENBRAINZ', false)
			? normaliseUrl('HEDDOHON_LISTENBRAINZ_URL', env('HEDDOHON_LISTENBRAINZ_URL') ?? 'https://api.listenbrainz.org')
			: null,
		// Off for a library whose layout on disk is not for its listeners: the
		// page shows folder names as the music server stores them.
		folders: flagEnv('HEDDOHON_FOLDERS', true),
		// The stations are the music server administrator's list, and a stream
		// is fetched only when a listener plays one. A station on a private
		// address is refused unless `radioPrivate` is set.
		radio: flagEnv('HEDDOHON_RADIO', true),
		radioPrivate: flagEnv('HEDDOHON_RADIO_PRIVATE', false),
		navidromePluginToken: navidromePluginToken(secret),
		androidFingerprints: androidFingerprints(),
		database: databaseConfig()
	};
}

/**
 * `HEDDOHON_DATABASE_URL`, with the user and password from their own variables
 * when set, so a password can stay out of the URL (or come from a Docker
 * secret through `HEDDOHON_DATABASE_PASSWORD_FILE`).
 *
 * The error messages name the variable and never its value, which can hold a
 * password.
 */
function databaseConfig(): DatabaseConfig {
	const raw = env('HEDDOHON_DATABASE_URL');
	if (!raw) return { kind: 'sqlite' };

	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new ConfigError('HEDDOHON_DATABASE_URL is not a valid URL');
	}
	if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
		throw new ConfigError('HEDDOHON_DATABASE_URL must start with postgres:// (PostgreSQL is the one server supported)');
	}
	if (!url.hostname) throw new ConfigError('HEDDOHON_DATABASE_URL has no host');

	let password = env('HEDDOHON_DATABASE_PASSWORD');
	const passwordFile = env('HEDDOHON_DATABASE_PASSWORD_FILE');
	if (passwordFile) {
		try {
			password = readFileSync(passwordFile, 'utf8').trim();
		} catch {
			throw new ConfigError(`HEDDOHON_DATABASE_PASSWORD_FILE ${passwordFile} could not be read`);
		}
	}

	const sslSetting = env('HEDDOHON_DATABASE_SSL')?.toLowerCase();
	let sslmode: 'disable' | 'no-verify' | 'verify-full' | undefined;
	if (sslSetting === undefined) sslmode = undefined;
	else if (['off', 'false', 'disable'].includes(sslSetting)) sslmode = 'disable';
	// Encrypted, certificate not checked: a self-signed server on the LAN.
	else if (sslSetting === 'require') sslmode = 'no-verify';
	else if (['verify', 'verify-full'].includes(sslSetting)) sslmode = 'verify-full';
	else throw new ConfigError('HEDDOHON_DATABASE_SSL must be off, require or verify-full');

	const database = url.pathname.replace(/^\//, '') || 'postgres';
	return {
		kind: 'postgres',
		connectionString: raw,
		user: env('HEDDOHON_DATABASE_USER'),
		password,
		sslmode,
		importSqlite: flagEnv('HEDDOHON_DATABASE_IMPORT', true),
		label: `${url.hostname}:${url.port || '5432'}/${database}`
	};
}

let cached: AppConfig | null = null;

/** Throws ConfigError if the deployment is misconfigured. */
export function config(): AppConfig {
	if (building) {
		// `vite build` imports server modules to analyse them, without a
		// deployment's environment.
		return {
			secret: 'x'.repeat(32),
			dataDir: '/data',
			sessionMaxHours: DEFAULT_SESSION_HOURS,
			cookieSecure: 'auto',
			upstreamTimeoutMs: 20_000,
			coverCacheBytes: 0,
			upstreams: [],
			appName: 'Heddohon',
			registrationHint: null,
			sharing: true,
			downloads: true,
			remoteControl: true,
			listeners: true,
			lrclibUrl: null,
			autoeqUrl: null,
			discordUrl: null,
			listenbrainzUrl: null,
			folders: true,
			radio: true,
			radioPrivate: false,
			navidromePluginToken: null,
			androidFingerprints: [ANDROID_RELEASE_KEY],
			database: { kind: 'sqlite' }
		};
	}
	if (!cached) cached = build();
	return cached;
}

export function upstreamFor(kind: BackendKind): UpstreamConfig {
	const found = config().upstreams.find((u) => u.kind === kind);
	if (!found) throw new ConfigError(`No ${kind} server is configured on this deployment.`);
	return found;
}
