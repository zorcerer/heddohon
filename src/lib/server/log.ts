/**
 * Server logging.
 *
 * What an operator has to answer with this: whether a request arrived, what it
 * did, how long the music server took over it, and which account it belonged
 * to. Before this the server printed seven lines in total, all of them errors,
 * so a slow page or a request that never arrived left nothing behind at all.
 *
 * Lines are `key=value` after a fixed prefix, which greps and splits without a
 * parser. `HEDDOHON_LOG_FORMAT=json` emits one JSON object per line instead,
 * for a collector that would otherwise have to guess at the shape.
 *
 * Nothing here writes a file or rotates one. The process logs to stdout and
 * stderr and the thing that runs it decides where that goes, which is what
 * `docker logs`, journald and every process supervisor already expect.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

const ORDER: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };

export type LogFields = Record<string, string | number | boolean | null | undefined>;

/**
 * Read straight from the environment rather than through `config()`.
 *
 * A configuration error is one of the things worth logging, and `config()`
 * throws on exactly that, so a logger that needed it could not report it.
 */
/**
 * The default is the lightest setting there is: a working server writes
 * nothing. `warn` adds refused writes and rejected sign-ins, `info` adds who
 * signed in and what the server started with, `debug` adds a line per request
 * and per call to the music server.
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
 * Per-request context, so a line written deep in a backend adapter can name the
 * request it belongs to without every function in between taking a parameter
 * for it. The store is set once per request in `hooks.server.ts`.
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

/**
 * Values are quoted only when they need it, so the common case stays readable:
 * `path=/albums` rather than `path="/albums"`.
 */
function render(value: string | number | boolean): string {
	const text = String(value);
	return /[\s"=]/.test(text) ? JSON.stringify(text) : text;
}

function emit(want: LogLevel, event: string, fields: LogFields = {}): void {
	if (!isEnabled(want)) return;

	const active = context.getStore();
	const all: LogFields = { ...fields };
	if (active?.user !== undefined && all.user === undefined) all.user = active.user;
	if (active?.id !== undefined && all.req === undefined) all.req = active.id;

	const time = new Date().toISOString();
	let line: string;
	if (asJson) {
		const payload: Record<string, unknown> = { time, level: want, event };
		for (const [key, value] of Object.entries(all)) {
			// The three keys above name the line itself. A field of the same name
			// would replace one silently: a `level` field once relabelled every
			// line with the configured level rather than its own.
			if (value !== undefined && key !== 'time' && key !== 'level' && key !== 'event') {
				payload[key] = value;
			}
		}
		line = JSON.stringify(payload);
	} else {
		const parts = Object.entries(all)
			.filter((entry): entry is [string, string | number | boolean | null] => entry[1] !== undefined)
			.map(([key, value]) => `${key}=${value === null ? '-' : render(value)}`);
		line = `${time} ${want.padEnd(5)} ${event}${parts.length ? ' ' + parts.join(' ') : ''}`;
	}

	// Anything a human has to act on goes to stderr, the rest to stdout, so a
	// pipeline that only keeps one of the two keeps the right one.
	if (want === 'error' || want === 'warn') console.error(line);
	else console.log(line);
}

export const log = {
	error: (event: string, fields?: LogFields) => emit('error', event, fields),
	warn: (event: string, fields?: LogFields) => emit('warn', event, fields),
	info: (event: string, fields?: LogFields) => emit('info', event, fields),
	debug: (event: string, fields?: LogFields) => emit('debug', event, fields)
};

/**
 * The message of an unknown throw, for a field.
 *
 * An Error's `message` and nothing else: a stack belongs on the error path
 * (`hooks.server.ts` prints one), not on every warning about a music server
 * that answered slowly.
 */
export function reason(err: unknown): string {
	if (err instanceof Error) return err.message;
	return String(err);
}
