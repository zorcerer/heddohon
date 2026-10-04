/**
 * Server logging: whether a request arrived, what it did, how long the music
 * server took and which account it belonged to.
 *
 * Lines are `key=value` after a fixed prefix. `HEDDOHON_LOG_FORMAT=json` emits
 * one JSON object per line instead.
 *
 * The process logs to stdout and stderr. The same lines are kept in a file per
 * day under the data directory for `HEDDOHON_LOG_KEEP_DAYS` days; see
 * `logfile.ts`.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { writeLogFile } from './logfile';

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

const ORDER: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };

export type LogFields = Record<string, string | number | boolean | null | undefined>;

/**
 * Read from the environment, not through `config()`: `config()` throws on a
 * configuration error, which is one of the things to log.
 */
/**
 * At the default, a working server writes nothing. `warn` adds refused writes
 * and rejected sign-ins, `info` adds who signed in and what the server started
 * with, `debug` adds a line per request and per call to the music server.
 */
function envLevel(): LogLevel {
	const raw = (process.env.HEDDOHON_LOG_LEVEL ?? '').trim().toLowerCase();
	return raw === 'error' || raw === 'warn' || raw === 'info' || raw === 'debug' ? raw : 'error';
}

const level = envLevel();
const asJson = (process.env.HEDDOHON_LOG_FORMAT ?? '').trim().toLowerCase() === 'json';

export function logLevel(): LogLevel {
	return level;
}

export function isEnabled(want: LogLevel): boolean {
	return ORDER[want] <= ORDER[level];
}

/**
 * Per-request context, so a line written in a backend adapter can name its
 * request without a parameter through every function between. Set once per
 * request in `hooks.server.ts`.
 */
interface RequestContext {
	id: string;
	user?: string;
}

const context = new AsyncLocalStorage<RequestContext>();

export function newRequestId(): string {
	return randomUUID().slice(0, 8);
}

export function withRequest<T>(ctx: RequestContext, run: () => T): T {
	return context.run(ctx, run);
}

/** Names the account on the current request, once the session has been resolved. */
export function nameRequestUser(user: string): void {
	const active = context.getStore();
	if (active) active.user = user;
}

/** Values are quoted only when they need it: `path=/albums`, not `path="/albums"`. */
function render(value: string | number | boolean): string {
	const text = String(value);
	return /[\s"=\\\p{C}]/u.test(text) ? escapeInvisible(JSON.stringify(text)) : text;
}

/*
 * Characters that change how a line reads without being seen, escaped as
 * `\uXXXX`.
 *
 * A username and an Origin header are written here by anyone who can reach the
 * sign-in page. An ESC sequence in a username cleared or recoloured the
 * terminal of whoever ran `docker logs`, and a right-to-left override made
 * `mallory<U+202E>gnp.exe` display as `malloryexe.png`. `JSON.stringify`
 * escapes the C0 controls. This covers the rest: C1 controls, the Unicode
 * format characters (bidi overrides and isolates, zero-width characters, the
 * BOM) and the two line separators.
 */
function escapeInvisible(text: string): string {
	return text.replace(
		/[\u0080-\u009f\p{Cf}\u2028\u2029]/gu,
		(char) => {
			const point = char.codePointAt(0) ?? 0;
			return point > 0xffff ? `\\u{${point.toString(16)}}` : `\\u${point.toString(16).padStart(4, '0')}`;
		}
	);
}

/** One line of the log, with the time it carries. */
function format(want: LogLevel, event: string, fields: LogFields): { time: string; line: string } {
	const active = context.getStore();
	const all: LogFields = { ...fields };
	// Every string field, not only those a call site passed through `redact`:
	// an error message can quote a path, and SvelteKit's "Failed to decode URI"
	// quotes all of it, token included.
	for (const [key, value] of Object.entries(all)) {
		if (typeof value === 'string') all[key] = redact(value);
	}
	if (active?.user !== undefined && all.user === undefined) all.user = active.user;
	if (active?.id !== undefined && all.req === undefined) all.req = active.id;

	const time = new Date().toISOString();
	let line: string;
	if (asJson) {
		const payload: Record<string, unknown> = { time, level: want, event };
		for (const [key, value] of Object.entries(all)) {
			// The three keys above name the line. A field called `level` once
			// relabelled every line with the configured level.
			if (value !== undefined && key !== 'time' && key !== 'level' && key !== 'event') {
				payload[key] = value;
			}
		}
		line = escapeInvisible(JSON.stringify(payload));
	} else {
		const parts = Object.entries(all)
			.filter((entry): entry is [string, string | number | boolean | null] => entry[1] !== undefined)
			.map(([key, value]) => `${key}=${value === null ? '-' : render(value)}`);
		line = `${time} ${want.padEnd(5)} ${event}${parts.length ? ' ' + parts.join(' ') : ''}`;
	}

	return { time, line };
}

function emit(want: LogLevel, event: string, fields: LogFields = {}): void {
	if (!isEnabled(want)) return;
	const { time, line } = format(want, event, fields);

	// warn and error go to stderr, the rest to stdout.
	if (want === 'error' || want === 'warn') console.error(line);
	else console.log(line);

	// And to the day's file. A directory that cannot be written turns the files
	// off and says so once, on stderr, whatever the level.
	const failed = writeLogFile(time, line);
	if (failed) console.error(format('warn', 'log-file-failed', { detail: failed }).line);
}

export const log = {
	error: (event: string, fields?: LogFields) => emit('error', event, fields),
	warn: (event: string, fields?: LogFields) => emit('warn', event, fields),
	info: (event: string, fields?: LogFields) => emit('info', event, fields),
	debug: (event: string, fields?: LogFields) => emit('debug', event, fields)
};

/**
 * A path or query string with any share, cast or listen-together token taken out.
 *
 * Each is a bearer credential carried in the path (`/cast/<token>`, see
 * `cast.ts`), and `/login?next=` carries it again, percent-encoded. Matching
 * is done on the decoded text: `/%73hare/...` routes to the same page. Text
 * with neither such a segment nor a Last.fm callback parameter (`LINK_PARAMS`)
 * is returned as given.
 */
const SHARE_SEGMENT = /(\/(?:share|cast|together)\/+[\s"'%]*)[^/?#&\s"]+/gi;

/**
 * The query parameters of the Last.fm callback (`/settings/lastfm`): last.fm's
 * token, Navidrome's link token and Heddohon's state. Each is a credential
 * while valid, and the callback URL reaches the log as a request query or
 * inside `next`.
 */
const LINK_PARAMS = /([?&](?:token|uid|state)=)[^&#\s"]+/gi;

/**
 * One layer of percent-encoding removed, byte by byte, never throwing.
 * `decodeURIComponent` stops at the first malformed escape, and one `%E0` in a
 * query left an encoded token in the line.
 */
function unescapeOnce(text: string): string {
	return text.replace(/%([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

export function redact(text: string): string {
	// Repeated until nothing changes, so `%252Fshare%252F...` and
	// `?next=%2F%2573hare%2F...` both come down to `/share/`. At most eight
	// layers.
	let current = text;
	for (let layer = 0; layer < 8; layer++) {
		const next = unescapeOnce(current);
		if (next === current) break;
		current = next;
	}
	SHARE_SEGMENT.lastIndex = 0;
	LINK_PARAMS.lastIndex = 0;
	if (!SHARE_SEGMENT.test(current) && !LINK_PARAMS.test(current)) return text;
	return current.replace(SHARE_SEGMENT, '$1-').replace(LINK_PARAMS, '$1-');
}

/**
 * The message of an unknown throw, for a field. A stack is printed only on the
 * error path (`hooks.server.ts`).
 */
export function reason(err: unknown): string {
	if (err instanceof Error) return err.message;
	return String(err);
}
