/**
 * Administrator-supplied configuration.
 *
 * Every value here comes from the process environment. Nothing in this module
 * may ever be influenced by a request: the whole point of Heddohon's threat
 * model is that *the operator* decides which upstream servers exist, and the
 * end user only ever supplies a username and a password.
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
export type DatabaseConfig =
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
	/** LRCLIB base URL for lyrics the music server lacks, or null when off. */
	lrclibUrl: string | null;
	database: DatabaseConfig;
}

export class ConfigError extends Error {}

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
	// Keep any sub-path (Navidrome behind /music), drop the trailing slash so
	// callers can always join with `${base}/rest/...`.
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
 * The session lifetime is capped at 72 hours by policy. An operator may make it
 * shorter; they may not make it longer, and asking for longer is clamped rather
 * than rejected so a typo cannot silently weaken the deployment.
 */
export const ABSOLUTE_SESSION_HOUR_CAP = 72;

/**
 * Who this process is, for a message an operator can act on. `getuid` is
 * POSIX-only and absent on Windows, where the question does not arise.
 */
function identity(): string {
	const uid = process.getuid?.();
	const gid = process.getgid?.();
	return uid === undefined || gid === undefined ? 'this container' : `uid ${uid}:${gid}`;
}

/**
 * The data directory, created and proven writable before anything asks for it.
 *
 * The database and the cover cache both live here, and on a fresh deployment
 * the first thing to touch the database is the login rate limiter. Without this
 * check an unwritable directory surfaces as `SQLITE_CANTOPEN` thrown out of a
 * sign-in POST: a 500 whose stack names better-sqlite3 and never names the
 * mount that is actually wrong, on the one request an operator is least likely
 * to read as a permissions problem.
 *
 * `mkdirSync` on its own does not catch it, because the failing case is a
 * directory that already exists. Docker creates a missing bind-mount source
 * itself, owned by root; the image runs unprivileged, and the Unraid template
 * runs it as 99:100. The directory is then present, `recursive: true` returns
 * happily, and the first write is denied.
 *
 * Raising it as a ConfigError puts it through the path every other
 * misconfiguration already takes: hooks.server.ts serves one plain 500 and logs
 * `config-invalid` with this message, and `/healthz` reports `misconfigured`,
 * which fails the container's HEALTHCHECK. Before this, a deployment that could
 * not write a single row still reported itself healthy.
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

	// W_OK to create the database, X_OK to reach anything inside the directory.
	// A directory can grant one without the other, and the cover cache needs both.
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
		sessionMaxHours: intEnv('HEDDOHON_SESSION_HOURS', 72, 1, ABSOLUTE_SESSION_HOUR_CAP),
		cookieSecure: boolEnv('HEDDOHON_COOKIE_SECURE', 'auto'),
		upstreamTimeoutMs: intEnv('HEDDOHON_UPSTREAM_TIMEOUT_MS', 20_000, 1_000, 120_000),
		// Megabytes in, bytes out. 0 disables the cache; the ceiling is there so a
		// typo cannot promise the volume more than a volume tends to have.
		coverCacheBytes: intEnv('HEDDOHON_COVER_CACHE_MB', 512, 0, 65_536) * 1024 * 1024,
		upstreams,
		appName: env('HEDDOHON_APP_NAME') ?? 'Heddohon',
		registrationHint: env('HEDDOHON_LOGIN_HINT') ?? null,
		sharing: flagEnv('HEDDOHON_SHARING', true),
		downloads: flagEnv('HEDDOHON_DOWNLOADS', true),
		// Off unless asked for: turning it on sends the artist, title, album and
		// length of every track whose lyrics are opened to a third party.
		lrclibUrl: flagEnv('HEDDOHON_LYRICS_LRCLIB', false)
			? normaliseUrl('HEDDOHON_LYRICS_LRCLIB_URL', env('HEDDOHON_LYRICS_LRCLIB_URL') ?? 'https://lrclib.net')
			: null,
		database: databaseConfig()
	};
}

/**
 * `HEDDOHON_DATABASE_URL`, with the user and password from their own
 * variables when set, so a password can stay out of the URL (or come from a
 * Docker secret through `HEDDOHON_DATABASE_PASSWORD_FILE`).
 *
 * The error messages name the variable and never echo its value: the value is
 * a URL that can hold a password.
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
		// `vite build` imports server modules to analyse them; it must never
		// require a live deployment's secrets to be present.
		return {
			secret: 'x'.repeat(32),
			dataDir: '/data',
			sessionMaxHours: 72,
			cookieSecure: 'auto',
			upstreamTimeoutMs: 20_000,
			coverCacheBytes: 0,
			upstreams: [],
			appName: 'Heddohon',
			registrationHint: null,
			sharing: true,
			downloads: true,
			lrclibUrl: null,
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
