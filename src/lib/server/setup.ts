/**
 * The first-run setup: what a deployment that was started without its secret
 * or its music server is asked for, once, on a page.
 *
 * Whoever opens the page first is not thereby its owner. The page takes a
 * code that this process makes when it finds itself not set up and prints to
 * its own output, which is the container's log: reading that log is what
 * shows someone runs the deployment. The code is held in memory and nowhere
 * else, so a restart makes another, and it is gone when the setup is saved.
 *
 * What the code allows is small. It can have the server ask one address
 * whether a music server answers there (`probe`), and it can save the values
 * in `SETUP_NAMES`. The probe says yes or no and, on yes, the server's kind
 * and version; it returns nothing else of what the address sent, so it is not
 * a way to read a host on the server's network.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
	ConfigError,
	SetupRequired,
	config,
	forgetSavedSecret,
	fromEnvironment,
	parseOrigins,
	saveSetup,
	upstreamAddress,
	type BackendKind,
	type SetupName
} from './config';
import { log, reason } from './log';
import { addressesWithoutSecure } from './origin';

/** Crockford's alphabet: no I, L, O or U, so a code read off a log is not misread. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** 20 characters of 5 bits: 100 bits. */
const CODE_LENGTH = 20;
const PROBE_TIMEOUT_MS = 5000;
const MAX_LABEL = 60;
const MAX_ADDRESS = 2048;
/** How much of an answer the probe reads. A server's envelope is a few hundred bytes. */
const MAX_ANSWER = 64 * 1024;

let code: string | null = null;
let printed = false;

/**
 * What lets the page that finished the setup take the secret out of the
 * saved file: a token made with the secret, given to that page alone, good
 * once and for half an hour. The setup's code is spent by then, and there is
 * no account yet to ask.
 */
let forget: { token: string; until: number } | null = null;
const FORGET_FOR_MS = 30 * 60 * 1000;

/** Whether a page may still take the secret out of the file. The request gate serves the endpoint only then. */
export function forgetPending(): boolean {
	if (forget && Date.now() > forget.until) forget = null;
	return forget !== null;
}

/**
 * Takes the secret out of `setup.json` for the page that holds the token.
 * The token is spent by a right answer and not by a wrong one.
 */
export function forgetSecret(given: unknown): boolean {
	if (!forgetPending() || !forget) return false;
	const digest = (value: string) => createHash('sha256').update(value).digest();
	if (typeof given !== 'string' || given.length > 128 || !timingSafeEqual(digest(given), digest(forget.token))) return false;
	forget = null;
	const removed = forgetSavedSecret();
	if (removed) log.warn('setup-secret-forgotten', { detail: 'taken out of setup.json; set HEDDOHON_SECRET before the next start' });
	return removed;
}

/** What is missing, or null when the deployment is set up. Any other fault is thrown. */
export function setupPending(): { secret: boolean; upstream: boolean } | null {
	try {
		config();
		return null;
	} catch (err) {
		if (err instanceof SetupRequired) return err.missing;
		throw err;
	}
}

function makeCode(): string {
	const bytes = randomBytes(CODE_LENGTH);
	let made = '';
	// 256 is 8 times 32, so the low five bits of a byte are uniform.
	for (const byte of bytes) made += ALPHABET[byte & 31];
	return made;
}

const grouped = (value: string) => value.match(/.{1,5}/g)?.join('-') ?? value;

/**
 * Prints the code, once per start, straight to standard output: the log
 * level does not hold it back, and it is not written to the log files in the
 * data directory, which outlive the start it is good for.
 */
export function announceSetup(): void {
	if (printed) return;
	if (setupPending() === null) return;
	printed = true;
	code ??= makeCode();
	process.stdout.write(
		[
			'',
			'  Heddohon is not set up yet.',
			'  Open it in a browser and enter this code on the setup page:',
			'',
			`      ${grouped(code)}`,
			'',
			'  The code is for this start: a restart makes a new one.',
			'  To configure by environment variables instead, see .env.example;',
			'  HEDDOHON_SETUP=false switches the setup page off.',
			'',
			''
		].join('\n')
	);
}

/** As typed: any case, with or without the hyphens, and the letters the alphabet leaves out read as what they look like. */
function normalise(given: string): string {
	return given
		.toUpperCase()
		.replace(/[^0-9A-Z]/g, '')
		.replace(/O/g, '0')
		.replace(/[IL]/g, '1')
		.replace(/U/g, 'V');
}

/**
 * Whether `given` is this start's code. Compared as digests, in constant
 * time.
 *
 * Wrong codes are not counted. At 100 bits the code is not found by
 * guessing at any rate a server answers, and a count that dropped the code
 * after ten was a way for anyone who can reach the page to shut the operator
 * out of it until a restart. A wrong code costs the server one hash.
 */
export function checkCode(given: unknown): boolean {
	if (code === null) return false;
	const digest = (value: string) => createHash('sha256').update(value).digest();
	return typeof given === 'string' && given.length <= 64 && timingSafeEqual(digest(normalise(given)), digest(code));
}

export type ProbeResult = { ok: true; server: string } | { ok: false; why: 'address' | 'unreachable' | 'not_a_music_server' };

/** A short name and version out of a server's answer, as plain characters. */
function described(...parts: unknown[]): string {
	return parts
		.filter((part): part is string => typeof part === 'string')
		.map((part) => part.replace(/[^\w .+-]/g, '').slice(0, 40))
		.filter(Boolean)
		.join(' ');
}

/**
 * Asks an address whether a music server of the kind answers there, without
 * credentials: Subsonic's `ping` answers its envelope to anyone, with an
 * error inside it, and Jellyfin's public info is public.
 *
 * Redirects are not followed, no more than 64 KB of the answer is read, and
 * nothing of it is returned but the kind and version of a server that
 * answered as one.
 */
export async function probe(kind: BackendKind, raw: unknown): Promise<ProbeResult> {
	let base: string;
	try {
		if (typeof raw !== 'string' || raw.length > MAX_ADDRESS) throw new ConfigError('too long');
		base = upstreamAddress(raw.trim());
	} catch {
		return { ok: false, why: 'address' };
	}
	const url = kind === 'subsonic' ? `${base}/rest/ping.view?f=json&v=1.16.1&c=heddohon-setup` : `${base}/System/Info/Public`;
	let body: unknown;
	try {
		const response = await fetch(url, {
			redirect: 'manual',
			headers: { accept: 'application/json' },
			signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
		});
		body = JSON.parse(await readCapped(response));
	} catch (err) {
		// A refused connection, a timeout and a page of HTML are told apart for
		// the operator in the log, and not on the page.
		log.warn('setup-probe-failed', { kind, detail: reason(err) });
		return { ok: false, why: err instanceof SyntaxError ? 'not_a_music_server' : 'unreachable' };
	}
	if (typeof body !== 'object' || body === null) return { ok: false, why: 'not_a_music_server' };
	if (kind === 'subsonic') {
		const envelope = (body as Record<string, unknown>)['subsonic-response'];
		if (typeof envelope !== 'object' || envelope === null) return { ok: false, why: 'not_a_music_server' };
		const answer = envelope as Record<string, unknown>;
		return { ok: true, server: described(answer.type, answer.serverVersion ?? answer.version) || 'Subsonic' };
	}
	const info = body as Record<string, unknown>;
	if (typeof info.Version !== 'string' || typeof info.Id !== 'string') return { ok: false, why: 'not_a_music_server' };
	return { ok: true, server: described(info.ProductName ?? 'Jellyfin', info.Version) };
}

/** The start of a response's body as text, and the rest left unread: an address that never stops sending is cut off. */
async function readCapped(response: Response): Promise<string> {
	const reader = response.body?.getReader();
	if (!reader) return '';
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (size < MAX_ANSWER) {
			const { done, value } = await reader.read();
			if (done) break;
			chunks.push(value);
			size += value.byteLength;
		}
	} finally {
		await reader.cancel().catch(() => undefined);
	}
	return Buffer.concat(chunks).subarray(0, MAX_ANSWER).toString('utf8');
}

export interface SetupInput {
	subsonicUrl?: unknown;
	subsonicLabel?: unknown;
	jellyfinUrl?: unknown;
	jellyfinLabel?: unknown;
	theme?: unknown;
	sharing?: unknown;
	downloads?: unknown;
	lrclib?: unknown;
	/** Whether accounts may make tokens for an AI assistant; see `mcp.ts`. */
	mcp?: unknown;
	/** The address, or addresses, the deployment is opened at. */
	origin?: unknown;
	/** The cover cache's size in megabytes; 0 switches it off. */
	coverCacheMb?: unknown;
}

/** The most the cover cache may be set to, in megabytes: what `config.ts` holds the variable to. */
export const MAX_COVER_CACHE_MB = 65_536;

/**
 * What of the setup the environment already decides. A value it gives is not
 * asked for, and would not be read if it were saved.
 */
export function decidedByEnvironment(): { origin: boolean; coverCache: boolean; mcp: boolean } {
	return {
		origin: fromEnvironment('ORIGIN'),
		coverCache: fromEnvironment('HEDDOHON_COVER_CACHE_MB'),
		mcp: fromEnvironment('HEDDOHON_MCP')
	};
}

/**
 * The address and the cover cache's size, checked, as values to save. Shared
 * by the setup and by the administrator's form under Settings. A value the
 * environment gives is left alone. An error names the field.
 */
export function serverValues(
	input: Pick<SetupInput, 'origin' | 'coverCacheMb'>
): { values: Partial<Record<SetupName, string>> } | { field: 'origin' | 'coverCacheMb'; message: string } {
	const values: Partial<Record<SetupName, string>> = {};
	const decided = decidedByEnvironment();
	if (!decided.origin && typeof input.origin === 'string') {
		try {
			// Empty saves none: the address is then worked out from the request, as before.
			values.ORIGIN = parseOrigins(input.origin.slice(0, 4096)).join(' ');
		} catch (err) {
			return { field: 'origin', message: err instanceof Error ? err.message : 'That is not an address.' };
		}
	}
	if (!decided.coverCache && input.coverCacheMb !== undefined && input.coverCacheMb !== null && input.coverCacheMb !== '') {
		const size = Number(input.coverCacheMb);
		if (!Number.isInteger(size) || size < 0 || size > MAX_COVER_CACHE_MB) {
			return { field: 'coverCacheMb', message: `The cover cache is a whole number of megabytes from 0 to ${MAX_COVER_CACHE_MB.toLocaleString('en')}.` };
		}
		values.HEDDOHON_COVER_CACHE_MB = String(size);
	}
	return { values };
}

export type SetupOutcome =
	| { ok: true; secret: string | null; forgetToken: string | null; withoutSecure: string[] }
	| { ok: false; field: 'subsonicUrl' | 'jellyfinUrl' | 'server' | 'origin' | 'coverCacheMb'; message: string };

const text = (value: unknown, max: number): string =>
	typeof value === 'string' ? value.trim().slice(0, max) : '';

/**
 * Saves the setup and ends it. The secret is made here when the environment
 * has none: 48 random bytes, the length the README asks an operator for. It
 * is returned once, for the page to show with what keeping it means.
 *
 * The caller has checked the code. After this the deployment is set up, the
 * code is gone, and the routes of the setup answer as if they were not there.
 */
export function finishSetup(input: SetupInput): SetupOutcome {
	const missing = setupPending();
	if (missing === null) return { ok: false, field: 'server', message: 'This deployment is already set up.' };

	const values: Partial<Record<SetupName, string>> = {};
	for (const [field, name, label] of [
		['subsonicUrl', 'HEDDOHON_SUBSONIC_URL', 'HEDDOHON_SUBSONIC_LABEL'],
		['jellyfinUrl', 'HEDDOHON_JELLYFIN_URL', 'HEDDOHON_JELLYFIN_LABEL']
	] as const) {
		// Only where the environment names no music server. Where it names one,
		// an address saved here would wait unseen for that variable to be removed.
		const address = missing.upstream ? text(input[field], MAX_ADDRESS) : '';
		if (!address) continue;
		try {
			values[name] = upstreamAddress(address);
		} catch (err) {
			return { ok: false, field, message: err instanceof Error ? err.message : 'That address is not valid.' };
		}
		const named = text(input[field === 'subsonicUrl' ? 'subsonicLabel' : 'jellyfinLabel'], MAX_LABEL);
		if (named) values[label] = named;
	}
	if (missing.upstream && !values.HEDDOHON_SUBSONIC_URL && !values.HEDDOHON_JELLYFIN_URL) {
		return { ok: false, field: 'server', message: 'Give the address of a music server.' };
	}

	if (input.theme === 'terminal' || input.theme === 'liquid' || input.theme === 'paper' || input.theme === 'phosphor') {
		values.HEDDOHON_DEFAULT_THEME = input.theme;
	}
	for (const [field, name] of [
		['sharing', 'HEDDOHON_SHARING'],
		['downloads', 'HEDDOHON_DOWNLOADS'],
		['lrclib', 'HEDDOHON_LYRICS_LRCLIB'],
		['mcp', 'HEDDOHON_MCP']
	] as const) {
		if (typeof input[field] === 'boolean') values[name] = String(input[field]);
	}

	const server = serverValues(input);
	if ('field' in server) return { ok: false, ...server };
	Object.assign(values, server.values);

	let secret: string | null = null;
	if (missing.secret) {
		secret = randomBytes(48).toString('base64');
		values.HEDDOHON_SECRET = secret;
	}

	saveSetup(values);
	let withoutSecure: string[];
	try {
		// What was saved has to make a deployment that starts.
		const saved = config();
		withoutSecure = addressesWithoutSecure(saved.origins, saved.cookieSecure);
	} catch (err) {
		log.error('setup-save-invalid', { detail: reason(err) });
		return { ok: false, field: 'server', message: 'The setup was saved, but the configuration is not valid. See the server log.' };
	}
	code = null;
	// Only for a secret made here: one from the environment is not in the file.
	forget = secret ? { token: randomBytes(24).toString('base64url'), until: Date.now() + FORGET_FOR_MS } : null;
	log.warn('setup-finished', {
		subsonic: values.HEDDOHON_SUBSONIC_URL ? 'saved' : 'unchanged',
		jellyfin: values.HEDDOHON_JELLYFIN_URL ? 'saved' : 'unchanged',
		secret: secret ? 'generated' : 'environment'
	});
	return { ok: true, secret, forgetToken: forget?.token ?? null, withoutSecure };
}
