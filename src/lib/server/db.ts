/**
 * Persistence: accounts, sessions, settings, play state, share links and the
 * sign-in throttle.
 *
 * SQLite in the data directory by default, or PostgreSQL with
 * `HEDDOHON_DATABASE_URL` set. The cover cache is on disk either way.
 *
 * Every caller goes through `store()`, asynchronous since PostgreSQL is. The
 * SQL is written once, with `?` placeholders, in the subset both engines read
 * the same way. Timestamps are milliseconds: BIGINT on PostgreSQL, returned as
 * numbers.
 */
import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { config } from './config';
import { log, reason } from './log';

export interface AccountRow {
	id: string;
	backend: string;
	username: string;
	remote_user_id: string | null;
	credential: string;
	created_at: number;
	last_login_at: number;
	/** Bumped when the credential changes hands; see `rememberDevice` in auth.ts. Null reads as 0. */
	device_epoch: number | null;
}

export interface ShareRow {
	id: string;
	token_digest: string;
	account_id: string;
	backend: string;
	song_id: string;
	created_at: number;
	expires_at: number;
	kind: string | null;
}

const SQLITE_SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  id              TEXT PRIMARY KEY,
  backend         TEXT NOT NULL,
  username        TEXT NOT NULL,
  remote_user_id  TEXT,
  credential      TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  last_login_at   INTEGER NOT NULL,
  UNIQUE (backend, username)
);

CREATE TABLE IF NOT EXISTS sessions (
  token_digest      TEXT PRIMARY KEY,
  account_id        TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at        INTEGER NOT NULL,
  expires_at        INTEGER NOT NULL,
  last_seen_at      INTEGER NOT NULL,
  client_pseudonym  TEXT,
  -- "Firefox on Android", for the list in Settings; see device.ts.
  device            TEXT
);
CREATE INDEX IF NOT EXISTS sessions_account_idx ON sessions(account_id);
CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);

-- Failed sign-in counters, so restarting the container is not a way to clear
-- them. See ratelimit.ts for what the keys are and why there are two.
CREATE TABLE IF NOT EXISTS login_attempts (
  key         TEXT PRIMARY KEY,
  failures    INTEGER NOT NULL,
  window_from INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  account_id  TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  data        TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS play_state (
  account_id  TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  data        TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- Song links one account hands to others. Only the HMAC digest of a link's
-- token is kept, as with sessions; see shares.ts. The id is the handle the
-- owner withdraws a link by, and is never part of the link.
CREATE TABLE IF NOT EXISTS shares (
  id            TEXT PRIMARY KEY,
  token_digest  TEXT NOT NULL UNIQUE,
  account_id    TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  backend       TEXT NOT NULL,
  -- The shared item's id: a song, or by kind an album or a playlist.
  song_id       TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  -- "song", "album" or "playlist"; null in a row from before albums and
  -- playlists could be shared, which is a song.
  kind          TEXT
);
CREATE INDEX IF NOT EXISTS shares_account_idx ON shares(account_id);
CREATE INDEX IF NOT EXISTS shares_expiry_idx ON shares(expires_at);

-- Tracks an account has played past the scrobble threshold, newest last, for
-- the history page; see history.ts for how many are kept.
CREATE TABLE IF NOT EXISTS plays (
  account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  song_id     TEXT NOT NULL,
  played_at   INTEGER NOT NULL,
  -- The track as it was when played, for the stats page; see history.ts.
  -- Null in a row from before these were kept.
  title       TEXT,
  artist      TEXT,
  artist_id   TEXT,
  album       TEXT,
  album_id    TEXT,
  cover_art   TEXT,
  duration    INTEGER
);
CREATE INDEX IF NOT EXISTS plays_account_idx ON plays(account_id, played_at);

-- What an account has linked outside the music server: a Discord webhook, a
-- ListenBrainz token. The secret is sealed as a credential is; see
-- integrations.ts.
CREATE TABLE IF NOT EXISTS integrations (
  account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
  secret      TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (account_id, kind)
);

-- Values the server keeps for itself, not for an account: whose cover fill is
-- repeated daily (coverfill.ts) and, on PostgreSQL, whether the SQLite import
-- has run.
CREATE TABLE IF NOT EXISTS meta (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);
`;

/*
 * The same tables for PostgreSQL. Millisecond timestamps pass 2^31, so every
 * INTEGER is BIGINT. The index serves the lower-cased username lookup; see
 * `usernameMatch` in auth.ts.
 */
const POSTGRES_SCHEMA = `${SQLITE_SCHEMA.replace(/\bINTEGER\b/g, 'BIGINT')}
DROP INDEX IF EXISTS accounts_username_idx;
CREATE INDEX IF NOT EXISTS accounts_username_ascii_idx ON accounts (backend, lower(username COLLATE "C"));
`;

/**
 * Columns added after a table first shipped. `CREATE TABLE IF NOT EXISTS`
 * leaves an existing table as it was, so each is added when the database
 * opens. New ones go at the end and are nullable.
 */
const ADDED_COLUMNS: { table: string; column: string; type: string }[] = [
	{ table: 'sessions', column: 'device', type: 'TEXT' },
	{ table: 'shares', column: 'kind', type: 'TEXT' },
	{ table: 'accounts', column: 'device_epoch', type: 'INTEGER' },
	{ table: 'plays', column: 'title', type: 'TEXT' },
	{ table: 'plays', column: 'artist', type: 'TEXT' },
	{ table: 'plays', column: 'artist_id', type: 'TEXT' },
	{ table: 'plays', column: 'album', type: 'TEXT' },
	{ table: 'plays', column: 'album_id', type: 'TEXT' },
	{ table: 'plays', column: 'cover_art', type: 'TEXT' },
	{ table: 'plays', column: 'duration', type: 'INTEGER' }
];

/**
 * Indexes over columns in `ADDED_COLUMNS`, created after those: in the schema
 * above they would fail on a database from before the column.
 *
 * `plays_album_idx` serves `forgottenAlbums` in history.ts.
 */
const LATER_INDEXES = `
CREATE INDEX IF NOT EXISTS plays_album_idx ON plays(account_id, album_id, played_at);
`;

function addColumnsSqlite(instance: Database.Database) {
	for (const { table, column, type } of ADDED_COLUMNS) {
		const present = (instance.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some(
			(info) => info.name === column
		);
		if (!present) instance.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
	}
}

async function addColumnsPostgres(pool: pg.Pool) {
	for (const { table, column, type } of ADDED_COLUMNS) {
		await pool.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} ${type}`);
	}
}

/** The PostgreSQL schema Heddohon keeps its tables in. */
const SCHEMA = 'heddohon';

export interface Store {
	readonly kind: 'sqlite' | 'postgres';
	get<R>(sql: string, ...params: unknown[]): Promise<R | undefined>;
	all<R>(sql: string, ...params: unknown[]): Promise<R[]>;
	run(sql: string, ...params: unknown[]): Promise<{ changes: number }>;
	/**
	 * Runs `work` with no other `exclusive` call for the same key running, for
	 * a read and a write that must not interleave. On PostgreSQL it is a
	 * transaction holding an advisory lock on the key. On SQLite, which runs
	 * one statement at a time in this process, `work` must be a single
	 * statement.
	 */
	exclusive<T>(key: string, work: (store: Store) => Promise<T>): Promise<T>;
}

/** Where the SQLite database lives, and where an import reads it from. */
function sqliteFile(): string {
	return join(config().dataDir, 'heddohon.db');
}

function openSqlite(file: string): Database.Database {
	const instance = new Database(file);
	instance.pragma('journal_mode = WAL');
	instance.pragma('foreign_keys = ON');
	instance.pragma('busy_timeout = 5000');
	instance.exec(SQLITE_SCHEMA);
	addColumnsSqlite(instance);
	instance.exec(LATER_INDEXES);
	return instance;
}

class SqliteStore implements Store {
	readonly kind = 'sqlite' as const;
	/*
	 * Prepared once per SQL text. better-sqlite3 compiles on every `prepare`,
	 * and the session and settings statements run several times per cover on a
	 * library page. For fixed SQL only: the cache never evicts.
	 */
	#statements = new Map<string, Database.Statement>();

	constructor(private readonly handle: Database.Database) {}

	#prepare(sql: string): Database.Statement {
		let prepared = this.#statements.get(sql);
		if (!prepared) {
			prepared = this.handle.prepare(sql);
			this.#statements.set(sql, prepared);
		}
		return prepared;
	}

	async get<R>(sql: string, ...params: unknown[]): Promise<R | undefined> {
		return this.#prepare(sql).get(...params) as R | undefined;
	}

	async all<R>(sql: string, ...params: unknown[]): Promise<R[]> {
		return this.#prepare(sql).all(...params) as R[];
	}

	async run(sql: string, ...params: unknown[]): Promise<{ changes: number }> {
		return { changes: this.#prepare(sql).run(...params).changes };
	}

	exclusive<T>(_key: string, work: (store: Store) => Promise<T>): Promise<T> {
		return work(this);
	}
}

/** `?` to `$1`, `$2`... None of the SQL here has a `?` inside a string. */
function numbered(sql: string): string {
	let n = 0;
	return sql.replace(/\?/g, () => `$${++n}`);
}

class PostgresStore implements Store {
	readonly kind = 'postgres' as const;
	/** A pool, or one client inside a transaction. */
	constructor(private readonly db: pg.Pool | pg.PoolClient) {}

	async get<R>(sql: string, ...params: unknown[]): Promise<R | undefined> {
		return (await this.db.query(numbered(sql), params)).rows[0] as R | undefined;
	}

	async all<R>(sql: string, ...params: unknown[]): Promise<R[]> {
		return (await this.db.query(numbered(sql), params)).rows as R[];
	}

	async run(sql: string, ...params: unknown[]): Promise<{ changes: number }> {
		return { changes: (await this.db.query(numbered(sql), params)).rowCount ?? 0 };
	}

	/*
	 * Under READ COMMITTED each statement reads a snapshot from its own start,
	 * so one statement is not enough: of 160 link creations sent at once, 103
	 * counted fewer than 100 and inserted. The advisory lock is released with
	 * the transaction.
	 */
	async exclusive<T>(key: string, work: (store: Store) => Promise<T>): Promise<T> {
		if (!(this.db instanceof pg.Pool)) return work(this);
		const client = await this.db.connect();
		try {
			await client.query('BEGIN');
			await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key]);
			const result = await work(new PostgresStore(client));
			await client.query('COMMIT');
			return result;
		} catch (err) {
			await client.query('ROLLBACK').catch(() => undefined);
			throw err;
		} finally {
			client.release();
		}
	}
}

// BIGINT (and COUNT(*)) as a number, exact up to 2^53 milliseconds.
pg.types.setTypeParser(20, (value) => Number(value));

let opening: Promise<Store> | null = null;

/** The database, opened (and on PostgreSQL, created and imported into) once. */
export function store(): Promise<Store> {
	if (!opening) {
		opening = open().catch((err) => {
			// Not cached as a failure: a database still starting beside this
			// container is tried again on the next request.
			opening = null;
			throw err;
		});
	}
	return opening;
}

async function open(): Promise<Store> {
	const cfg = config();
	const database = cfg.database;
	if (database.kind === 'sqlite') {
		// config() has created the directory and proved it writable.
		return new SqliteStore(openSqlite(sqliteFile()));
	}

	/*
	 * The user, the password and the TLS mode go into the URL. The driver
	 * merges the parsed URL over its options, including keys the URL leaves
	 * out, so `user` and `ssl` passed beside it were replaced with nothing and
	 * the first connection had no user name.
	 */
	const url = new URL(database.connectionString);
	if (database.user) url.username = database.user;
	if (database.password) url.password = database.password;
	if (database.sslmode) url.searchParams.set('sslmode', database.sslmode);
	/*
	 * A schema of Heddohon's own. In `public`, shared with another application,
	 * `CREATE TABLE IF NOT EXISTS` would adopt that application's `accounts`,
	 * `sessions` or `settings`. Set at connection start-up, so every pooled
	 * connection has it from its first query.
	 */
	url.searchParams.set('options', `-c search_path=${SCHEMA}`);

	const pool = new pg.Pool({
		connectionString: url.toString(),
		max: 10,
		connectionTimeoutMillis: 5000,
		idleTimeoutMillis: 30_000,
		statement_timeout: 10_000,
		// `statement_timeout` is enforced by the server, which cannot do so once
		// it stops answering: with the database paused, a query (and `/healthz`)
		// waited indefinitely. This one is kept by the client.
		query_timeout: 8_000,
		application_name: 'heddohon'
	});
	// Reports an idle client the server dropped (a restart, a proxy timeout).
	// Without a listener the unhandled 'error' event ends the process.
	pool.on('error', (err) => log.warn('database-connection-lost', { detail: reason(err) }));

	await pool.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
	await pool.query(POSTGRES_SCHEMA);
	await addColumnsPostgres(pool);
	await pool.query(LATER_INDEXES);
	if (database.importSqlite) await importFromSqlite(pool);
	log.info('database', { kind: 'postgres', at: database.label, schema: SCHEMA });

	// Without TLS the session and share digests, sealed credentials, settings
	// and queues cross the network as they are.
	const tls = await pool
		.query('SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()')
		.then((result) => result.rows[0]?.ssl === true)
		.catch(() => false);
	if (!tls) {
		log.warn('database-unencrypted', {
			at: database.label,
			detail: 'the connection to PostgreSQL is not encrypted; set HEDDOHON_DATABASE_SSL=require or verify-full if it crosses a network'
		});
	}
	return new PostgresStore(pool);
}

/*
 * A one-time copy of an existing SQLite database into PostgreSQL.
 *
 * Runs on the first start against an empty PostgreSQL database, when
 * `heddohon.db` is in the data directory and `HEDDOHON_DATABASE_IMPORT` is not
 * `false`. Sessions and throttle counters are not copied, so everyone signs in
 * once. Credentials are copied sealed, so `HEDDOHON_SECRET` must be the same.
 *
 * One transaction: a failure leaves PostgreSQL empty and the next start tries
 * again. A row in `meta` records the import, so a database emptied later is
 * not filled from the old file again.
 */
async function importFromSqlite(pool: pg.Pool): Promise<void> {
	const marker = await pool.query("SELECT value FROM meta WHERE key = 'sqlite_import'");
	if (marker.rowCount) return;

	const existing = await pool.query('SELECT COUNT(*) AS count FROM accounts');
	const file = sqliteFile();
	const record = (value: string) =>
		pool.query("INSERT INTO meta (key, value) VALUES ('sqlite_import', $1) ON CONFLICT (key) DO NOTHING", [value]);

	if (Number(existing.rows[0]?.count) > 0) return void (await record('skipped: database not empty'));
	if (!existsSync(file)) return void (await record('skipped: no SQLite file'));

	const source = new Database(file, { readonly: true, fileMustExist: true });
	const tables = {
		accounts: ['id', 'backend', 'username', 'remote_user_id', 'credential', 'created_at', 'last_login_at'],
		settings: ['account_id', 'data', 'updated_at'],
		play_state: ['account_id', 'data', 'updated_at'],
		shares: ['id', 'token_digest', 'account_id', 'backend', 'song_id', 'created_at', 'expires_at', 'kind'],
		plays: ['account_id', 'song_id', 'played_at', 'title', 'artist', 'artist_id', 'album', 'album_id', 'cover_art', 'duration'],
		integrations: ['account_id', 'kind', 'secret', 'created_at'],
		meta: ['key', 'value']
	} as const;
	const counts: Record<string, number> = {};

	const client = await pool.connect();
	try {
		await client.query('BEGIN');
		// Accounts first: the others refer to them.
		for (const [table, wanted] of Object.entries(tables)) {
			// Only the columns the file has: a file from before a column was added
			// (`ADDED_COLUMNS`) is copied without it. Asked for by name, a missing
			// column failed the whole table, which was then skipped as absent.
			let present: Set<string>;
			try {
				present = new Set(
					(source.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((info) => info.name)
				);
			} catch {
				present = new Set();
			}
			const columns = wanted.filter((column) => present.has(column));
			let rows: Record<string, unknown>[];
			try {
				rows = columns.length
					? (source.prepare(`SELECT ${columns.join(', ')} FROM ${table}`).all() as Record<string, unknown>[])
					: [];
			} catch {
				// A database from before this table existed.
				rows = [];
			}
			const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
			const insert = `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`;
			for (const row of rows) await client.query(insert, columns.map((column) => row[column]));
			counts[table] = rows.length;
		}
		await client.query("INSERT INTO meta (key, value) VALUES ('sqlite_import', $1)", [
			`imported ${new Date().toISOString()}`
		]);
		await client.query('COMMIT');
	} catch (err) {
		await client.query('ROLLBACK').catch(() => undefined);
		throw err;
	} finally {
		client.release();
		source.close();
	}
	log.warn('database-imported', { from: 'sqlite', ...counts });
}

export function now(): number {
	return Date.now();
}
