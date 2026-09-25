/**
 * Persistence: accounts, sessions, settings, play state, share links and the
 * sign-in throttle.
 *
 * SQLite in the data directory by default: one file, no external service,
 * which keeps the Docker deployment to one container and a volume. With
 * `HEDDOHON_DATABASE_URL` set it is a PostgreSQL server instead, for people who
 * already run one. The cover cache stays on disk either way.
 *
 * Every caller goes through `store()`, which is asynchronous because
 * PostgreSQL is. The SQL is written once, with `?` placeholders and in the
 * subset both engines read the same way; the PostgreSQL store numbers the
 * placeholders. Timestamps are milliseconds, so they are BIGINT there, and the
 * driver is told to hand BIGINT back as a number rather than a string.
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
}

export interface SessionRow {
	token_digest: string;
	account_id: string;
	created_at: number;
	expires_at: number;
	last_seen_at: number;
	client_pseudonym: string | null;
}

export interface ShareRow {
	id: string;
	token_digest: string;
	account_id: string;
	backend: string;
	song_id: string;
	created_at: number;
	expires_at: number;
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
  client_pseudonym  TEXT
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
  song_id       TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS shares_account_idx ON shares(account_id);
CREATE INDEX IF NOT EXISTS shares_expiry_idx ON shares(expires_at);
`;

/*
 * The same tables for PostgreSQL. Millisecond timestamps pass 2^31, so every
 * INTEGER is BIGINT. The username lookup compares lower-cased, which SQLite's
 * primary key index does not need and PostgreSQL does.
 */
const POSTGRES_SCHEMA = `${SQLITE_SCHEMA.replace(/\bINTEGER\b/g, 'BIGINT')}
CREATE INDEX IF NOT EXISTS accounts_username_idx ON accounts (backend, lower(username));
CREATE TABLE IF NOT EXISTS meta (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);
`;

/** The PostgreSQL schema Heddohon keeps its tables in. */
const SCHEMA = 'heddohon';

export interface Store {
	readonly kind: 'sqlite' | 'postgres';
	get<R>(sql: string, ...params: unknown[]): Promise<R | undefined>;
	all<R>(sql: string, ...params: unknown[]): Promise<R[]>;
	run(sql: string, ...params: unknown[]): Promise<{ changes: number }>;
	/**
	 * Runs `work` with no other `exclusive` call for the same key running at
	 * once, for a read and a write that must not interleave. On PostgreSQL it is
	 * a transaction holding an advisory lock on the key; on SQLite, which runs
	 * one statement at a time in this process, `work` has to be a single
	 * statement, and is called as it is.
	 */
	exclusive<T>(key: string, work: (store: Store) => Promise<T>): Promise<T>;
}

/** Where the SQLite database lives, and where an import reads it from. */
export function sqliteFile(): string {
	return join(config().dataDir, 'heddohon.db');
}

function openSqlite(file: string): Database.Database {
	const instance = new Database(file);
	instance.pragma('journal_mode = WAL');
	instance.pragma('foreign_keys = ON');
	instance.pragma('busy_timeout = 5000');
	instance.exec(SQLITE_SCHEMA);
	return instance;
}

class SqliteStore implements Store {
	readonly kind = 'sqlite' as const;
	/*
	 * Prepared once per SQL text and reused. better-sqlite3 compiles on every
	 * `prepare`, and the statements that run on every request (the session, the
	 * settings) were prepared afresh each time, several times per cover on a
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
	 * A single statement was not enough here. Under READ COMMITTED each
	 * statement reads a snapshot from when it started, so of 160 link creations
	 * sent at once, 103 counted fewer than 100 and inserted. The advisory lock
	 * is released with the transaction, so a failure cannot leave it held.
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

// BIGINT (and COUNT(*)) as a number. Millisecond timestamps are exact up to
// 2^53, which is the year 287396.
pg.types.setTypeParser(20, (value) => Number(value));

let opening: Promise<Store> | null = null;

/** The database, opened (and on PostgreSQL, created and imported into) once. */
export function store(): Promise<Store> {
	if (!opening) {
		opening = open().catch((err) => {
			// Tried again on the next request rather than cached as a failure: a
			// database that was still starting beside this container comes up.
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
		// config() created the directory and proved it writable, so a broken
		// mount is reported as a misconfiguration rather than as SQLITE_CANTOPEN.
		return new SqliteStore(openSqlite(sqliteFile()));
	}

	/*
	 * The user, the password and the TLS mode go into the URL rather than beside
	 * it. The driver merges a parsed URL over the options it is given, keys the
	 * URL does not set included, so `user` and `ssl` passed alongside a URL
	 * without them were replaced with nothing: the first connection went out
	 * with no user name at all.
	 */
	const url = new URL(database.connectionString);
	if (database.user) url.username = database.user;
	if (database.password) url.password = database.password;
	if (database.sslmode) url.searchParams.set('sslmode', database.sslmode);
	/*
	 * A schema of Heddohon's own. The tables have common names (`accounts`,
	 * `sessions`, `settings`), and in the default `public` schema of a database
	 * another application also uses, `CREATE TABLE IF NOT EXISTS` would have
	 * quietly adopted that application's table of the same name. Set at
	 * connection start-up, so every connection in the pool has it from its
	 * first query.
	 */
	url.searchParams.set('options', `-c search_path=${SCHEMA}`);

	const pool = new pg.Pool({
		connectionString: url.toString(),
		max: 10,
		connectionTimeoutMillis: 5000,
		idleTimeoutMillis: 30_000,
		statement_timeout: 10_000,
		// The server enforces `statement_timeout`, which a server that has
		// stopped answering cannot do: with the database paused, a query on an
		// open connection waited indefinitely and `/healthz` with it. This one is
		// kept by the client.
		query_timeout: 8_000,
		application_name: 'heddohon'
	});
	// An idle client the server drops (a restart, a proxy timeout) is reported
	// here; unhandled, it would+31g.warn('database-connection-lost', { detail: reason(err) }));

	await pool.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
	await pool.query(POSTGRES_SCHEMA);
	if (database.importSqlite) await importFromSqlite(pool);
	log.info('database', { kind: 'postgres', at: database.label, schema: SCHEMA });

	// Said once, at start-up, where an operator looks: without TLS the session
	// and share digests, sealed credentials, settings and queues cross the
	// network as they are. Harmless on the same host, worth knowing otherwise.
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
 * `false`. Accounts, settings, play state and share links are copied; sessions
 * and throttle counters are not, so everyone signs in once. The stored
 * credentials are copied as they are, sealed, so the same `HEDDOHON_SECRET`
 * has to be set for them to open.
 *
 * One transaction: a failure leaves PostgreSQL empty and the import is tried
 * again on the next start. The SQLite file is only read. A row in `meta`
 * records that the import has run, so a database emptied later is not filled
 * from the old file again.
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
		shares: ['id', 'token_digest', 'account_id', 'backend', 'song_id', 'created_at', 'expires_at']
	} as const;
	const counts: Record<string, number> = {};

	const client = await pool.connect();
	try {
		await client.query('BEGIN');
		// Accounts first: the other three refer to them.
		for (const [table, columns] of Object.entries(tables)) {
			let rows: Record<string, unknown>[];
			try {
				rows = source.prepare(`SELECT ${columns.join(', ')} FROM ${table}`).all() as Record<string, unknown>[];
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
