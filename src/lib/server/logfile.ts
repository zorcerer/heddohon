/**
 * The log, kept on disk as well as written to stdout and stderr.
 *
 * One file a day in `HEDDOHON_DATA_DIR/logs`, `heddohon-YYYY-MM-DD.log`, by
 * the UTC date its lines carry. `HEDDOHON_LOG_KEEP_DAYS` is how many days of
 * files are kept, 7 unless set: when the process starts and each time the
 * date changes, files whose date is more than that many days back are
 * deleted. 0 writes no files and deletes none.
 *
 * `docker logs` already rotates by size where the daemon is told to, and is
 * gone with the container. This is for the deployment where it is not
 * configured and the log is wanted after an update replaced the container.
 *
 * The files hold the lines stdout and stderr get, at the same level, so at
 * the default level a working server writes an empty directory.
 *
 * Read from the environment, as `log.ts` does and for its reason: a
 * configuration error is logged before `config()` can be read. A directory
 * that cannot be made or written to turns the files off for the life of the
 * process and is reported once, on stderr; logging never throws.
 */
import { closeSync, mkdirSync, openSync, readdirSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { building } from '$app/environment';

const DEFAULT_KEEP_DAYS = 7;
/** Ten years; the bound only keeps the date arithmetic sane. */
const MAX_KEEP_DAYS = 3650;
const FILE = /^heddohon-(\d{4}-\d{2}-\d{2})\.log$/;
const DAY_MS = 24 * 60 * 60 * 1000;

function envKeepDays(): number {
	const raw = (process.env.HEDDOHON_LOG_KEEP_DAYS ?? '').trim();
	if (raw === '') return DEFAULT_KEEP_DAYS;
	const value = Number.parseInt(raw, 10);
	return Number.isFinite(value) && value >= 0 ? Math.min(value, MAX_KEEP_DAYS) : DEFAULT_KEEP_DAYS;
}

const keepDays = envKeepDays();
const directory = join((process.env.HEDDOHON_DATA_DIR ?? '').trim() || '/data', 'logs');

let open: { day: string; fd: number } | null = null;
let off = keepDays === 0 || building;

/** How many days of log files are kept; 0 when none are written. */
export function logKeepDays(): number {
	return off ? 0 : keepDays;
}

/** Deletes the files dated more than `keepDays` days before `today`. Other files in the directory are left. */
function prune(today: string): void {
	const cutoff = Date.parse(`${today}T00:00:00Z`) - keepDays * DAY_MS;
	for (const name of readdirSync(directory)) {
		const day = FILE.exec(name)?.[1];
		if (!day) continue;
		const at = Date.parse(`${day}T00:00:00Z`);
		if (Number.isFinite(at) && at < cutoff) {
			try {
				unlinkSync(join(directory, name));
			} catch {
				// Gone already, or not ours to delete; the next change of date tries again.
			}
		}
	}
}

/**
 * Appends a line to the file of the day in `time` (an ISO timestamp). Returns
 * what went wrong the one time the files are turned off, and null otherwise.
 */
export function writeLogFile(time: string, line: string): string | null {
	if (off) return null;
	const day = time.slice(0, 10);
	try {
		if (open?.day !== day) {
			if (open) closeSync(open.fd);
			open = null;
			mkdirSync(directory, { recursive: true });
			// Appended to: a restart on the same day carries on in the same file.
			open = { day, fd: openSync(join(directory, `heddohon-${day}.log`), 'a', 0o640) };
			prune(day);
		}
		writeSync(open.fd, `${line}\n`);
		return null;
	} catch (err) {
		off = true;
		if (open) {
			try {
				closeSync(open.fd);
			} catch {
				// Nothing left to close.
			}
			open = null;
		}
		return err instanceof Error ? err.message : String(err);
	}
}
