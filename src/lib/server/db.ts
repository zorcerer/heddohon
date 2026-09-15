/**
 * SQLite persistence. One file, no external service, which keeps the Docker
 * deployment to a single container plus a volume.
 */
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config';

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

const SCHEMA = `
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
`;

let handle: Database.Database | null = null;

export function db(): Database.Database {
	if (handle) return handle;

	const dir = config().dataDir;
	mkdirSync(dir, { recursive: true });

	const instance = new Database(join(dir, 'heddohon.db'));
	instance.pragma('journal_mode = WAL');
	instance.pragma('foreign_keys = ON');
	instance.pragma('busy_timeout = 5000');
	instance.exec(SCHEMA);

	handle = instance;
	return instance;
}

export function now(): number {
	return Date.now();
}
