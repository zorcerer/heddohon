/**
 * A backup of the database, as a ZIP an administrator downloads from Settings.
 *
 * The archive holds `heddohon.db`, a SQLite database in one file whichever
 * database the server runs on (`backup` on the store in `db.ts`), a
 * `backup.json` saying what it was made from and how many rows each table
 * has, and a `README.txt` with the steps to restore it. Restoring is putting
 * the file in the data directory: SQLite opens it, and an empty PostgreSQL
 * database is filled from it on the first start (`importFromSqlite`).
 *
 * What it holds is what the database holds: each account's music-server
 * credential and linked services sealed under `HEDDOHON_SECRET`, the digests
 * of shared links, settings, saved queues, listening history and profiles, of
 * every account. Sign-ins are left out. The secret is not in it, so the file
 * alone opens no account, and the server it is restored to needs the same
 * secret.
 *
 * The copy is written to a directory of its own in the data directory, read
 * into memory, and removed. One runs at a time. A database past 512MB is
 * refused: the archive is built in memory.
 */
import Database from 'better-sqlite3';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from './config';
import { store } from './db';
import { APP_VERSION } from './version';
import { zip } from './zip';

const MAX_BYTES = 512 * 1024 * 1024;
const WORK_PREFIX = 'backup-';

export class BackupBusyError extends Error {}
export class BackupTooLargeError extends Error {}

export interface Backup {
	/** `heddohon-backup-2026-10-08T12-00-00Z.zip`. */
	name: string;
	zip: Uint8Array;
	/** Rows per table in the copy. */
	tables: Record<string, number>;
}

let running = false;

function readme(madeAt: string, kind: string): string {
	return [
		'Heddohon database backup',
		`Made ${madeAt} by Heddohon ${APP_VERSION}, from a ${kind === 'postgres' ? 'PostgreSQL' : 'SQLite'} database.`,
		'',
		'heddohon.db is a SQLite database. It holds every account with its',
		'music-server credential encrypted, settings, saved queues, shared links,',
		'listening history, linked services and profiles. Sign-ins are left out, so',
		'everyone signs in once after a restore.',
		'',
		'It opens only with the HEDDOHON_SECRET of the server it came from. The',
		'secret is not in this archive. Keep a copy of it somewhere else.',
		'',
		'To restore on SQLite (the default):',
		'  1. Stop Heddohon.',
		'  2. Put heddohon.db in HEDDOHON_DATA_DIR, in place of the one there.',
		'  3. Delete heddohon.db-wal and heddohon.db-shm beside it, if they exist.',
		'  4. Start Heddohon with the same HEDDOHON_SECRET.',
		'',
		'To restore on PostgreSQL:',
		'  1. Stop Heddohon.',
		'  2. Point HEDDOHON_DATABASE_URL at an empty database.',
		'  3. Put heddohon.db in HEDDOHON_DATA_DIR.',
		'  4. Start Heddohon with the same HEDDOHON_SECRET. The file is copied',
		'     across on the first start.',
		''
	].join('\r\n');
}

/** Rows per table, read back from the copy. */
function count(file: string): Record<string, number> {
	const copy = new Database(file, { readonly: true, fileMustExist: true });
	try {
		const names = copy.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[];
		return Object.fromEntries(
			names.map(({ name }) => [name, (copy.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get() as { n: number }).n])
		);
	} finally {
		copy.close();
	}
}

export async function makeBackup(): Promise<Backup> {
	if (running) throw new BackupBusyError('A backup is being made.');
	running = true;
	const dataDir = config().dataDir;
	let work: string | null = null;
	try {
		// What a backup cut short by a restart left behind.
		for (const entry of await readdir(dataDir)) {
			if (entry.startsWith(WORK_PREFIX)) await rm(join(dataDir, entry), { recursive: true, force: true });
		}
		work = await mkdtemp(join(dataDir, WORK_PREFIX));
		const file = join(work, 'heddohon.db');
		const database = await store();
		await database.backup(file);

		if ((await stat(file)).size > MAX_BYTES) {
			throw new BackupTooLargeError('The database is larger than 512MB, which this does not pack.');
		}
		const tables = count(file);
		const made = new Date();
		const madeAt = made.toISOString();
		const manifest = {
			app: 'heddohon',
			version: APP_VERSION,
			madeAt,
			from: database.kind,
			file: 'heddohon.db',
			leftOut: ['sessions', 'login_attempts'],
			tables
		};
		const text = (value: string) => new TextEncoder().encode(value);
		return {
			name: `heddohon-backup-${madeAt.slice(0, 19).replace(/:/g, '-')}Z.zip`,
			zip: zip(
				[
					{ name: 'heddohon.db', data: await readFile(file) },
					{ name: 'backup.json', data: text(`${JSON.stringify(manifest, null, '\t')}\n`) },
					{ name: 'README.txt', data: text(readme(madeAt, database.kind)) }
				],
				made
			),
			tables
		};
	} finally {
		if (work) await rm(work, { recursive: true, force: true }).catch(() => undefined);
		running = false;
	}
}
