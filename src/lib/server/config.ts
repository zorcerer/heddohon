/**
 * Administrator-supplied configuration.
 *
 * Every value here comes from the process environment. Nothing in this module
 * may ever be influenced by a request: the whole point of Heddohon's threat
 * model is that *the operator* decides which upstream servers exist, and the
 * end user only ever supplies a username and a password.
 */
import { building } from '$app/environment';

export type BackendKind = 'subsonic' | 'jellyfin';

export interface UpstreamConfig {
	kind: BackendKind;
	/** Normalised base URL, no trailing slash. */
	url: string;
	/** Human readable name shown on the login screen. */
	label: string;
}

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

/**
 * The session lifetime is capped at 72 hours by policy. An operator may make it
 * shorter; they may not make it longer, and asking for longer is clamped rather
 * than rejected so a typo cannot silently weaken the deployment.
 */
export const ABSOLUTE_SESSION_HOUR_CAP = 72;

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
		dataDir: env('HEDDOHON_DATA_DIR') ?? '/data',
		sessionMaxHours: intEnv('HEDDOHON_SESSION_HOURS', 72, 1, ABSOLUTE_SESSION_HOUR_CAP),
		cookieSecure: boolEnv('HEDDOHON_COOKIE_SECURE', 'auto'),
		upstreamTimeoutMs: intEnv('HEDDOHON_UPSTREAM_TIMEOUT_MS', 20_000, 1_000, 120_000),
		// Megabytes in, bytes out. 0 disables the cache; the ceiling is there so a
		// typo cannot promise the volume more than a volume tends to have.
		coverCacheBytes: intEnv('HEDDOHON_COVER_CACHE_MB', 512, 0, 65_536) * 1024 * 1024,
		upstreams,
		appName: env('HEDDOHON_APP_NAME') ?? 'Heddohon',
		registrationHint: env('HEDDOHON_LOGIN_HINT') ?? null
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
			registrationHint: null
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
