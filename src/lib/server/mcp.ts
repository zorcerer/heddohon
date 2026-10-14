/**
 * Tokens for the MCP endpoint (`routes/api/mcp`), through which an AI
 * assistant's client browses an account's library and, where the token
 * allows, changes its playlists, favourites and ratings. What it can call is
 * in `mcptools.ts`.
 *
 * An account makes a token under Settings and gives it to its client, which
 * sends it as `Authorization: Bearer`. The token is shown once. The database
 * keeps its HMAC digest, as for a session, so a copy of the database yields
 * no working token. A token has no expiry. It ends when the account withdraws
 * it, and with every session of the account (`destroyAllSessions` in
 * `auth.ts`): a changed password, a name given to another user, a credential
 * the music server rejects.
 *
 * The endpoint and the tokens' Settings section exist only while it is on:
 * `HEDDOHON_MCP` in the environment, or saved by the first-run setup or by an
 * administrator under Settings, AI (`saveMcp`). A token made before it was
 * turned off is listed, to be withdrawn, and opens nothing.
 */
import { randomUUID } from 'node:crypto';
import type { BackendKind } from '$lib/types';
import type { StoredCredential } from './backends';
import { mcpDigest, openJson, randomToken } from './crypto';
import { now, store } from './db';
import { log } from './log';

/** Tokens one account may hold. */
export const MAX_MCP_TOKENS = 20;
/** Characters of the name a token is listed under. */
export const MAX_MCP_TOKEN_NAME = 64;
/** Ahead of every token, for a secret scanner, and for a person reading a client's configuration. */
const PREFIX = 'hhmcp_';
/** The prefix and 43 characters of `randomToken`, with room. Anything longer is no token. */
const MAX_TOKEN_LENGTH = 128;
/** `last_used_at` is written at most this often, as a session's `last_seen_at` is. */
const LAST_USED_RESOLUTION_MS = 60_000;

export interface McpTokenSummary {
	id: string;
	name: string;
	writes: boolean;
	createdAt: number;
	/** To the minute. Null for a token never used. */
	lastUsedAt: number | null;
}

/** What a request with a live token acts as. */
export interface McpAccess {
	accountId: string;
	backend: BackendKind;
	credential: StoredCredential;
	/** Whether the token may change playlists, favourites and ratings. */
	writes: boolean;
}

interface TokenRow {
	id: string;
	name: string;
	writes: number;
	created_at: number;
	last_used_at: number | null;
}

/** The name as listed: control characters out, spaces folded, cut to length. */
export function tokenName(raw: string): string {
	return raw
		.replace(/[\p{Cc}\p{Cf}]/gu, '')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, MAX_MCP_TOKEN_NAME);
}

/** The account's tokens, newest first. */
export async function listMcpTokens(accountId: string): Promise<McpTokenSummary[]> {
	const rows = await (await store()).all<TokenRow>(
		'SELECT id, name, writes, created_at, last_used_at FROM mcp_tokens WHERE account_id = ? ORDER BY created_at DESC',
		accountId
	);
	return rows.map((row) => ({
		id: row.id,
		name: row.name,
		writes: Number(row.writes) === 1,
		createdAt: Number(row.created_at),
		lastUsedAt: row.last_used_at === null ? null : Number(row.last_used_at)
	}));
}

/**
 * Makes a token for the account. Returns the token itself, which is not kept
 * and cannot be shown again, or `full` at `MAX_MCP_TOKENS`.
 */
export async function createMcpToken(
	accountId: string,
	name: string,
	writes: boolean
): Promise<{ token: string; summary: McpTokenSummary } | 'full'> {
	const database = await store();
	const held = await database.get<{ count: number }>(
		'SELECT COUNT(*) AS count FROM mcp_tokens WHERE account_id = ?',
		accountId
	);
	if (Number(held?.count ?? 0) >= MAX_MCP_TOKENS) return 'full';

	const token = `${PREFIX}${randomToken()}`;
	const summary: McpTokenSummary = {
		id: randomUUID(),
		name: tokenName(name) || 'AI assistant',
		writes,
		createdAt: now(),
		lastUsedAt: null
	};
	await database.run(
		`INSERT INTO mcp_tokens (id, token_digest, account_id, name, writes, created_at, last_used_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		summary.id,
		mcpDigest(token),
		accountId,
		summary.name,
		writes ? 1 : 0,
		summary.createdAt,
		null
	);
	log.info('mcp-token-made', { account: accountId, writes });
	return { token, summary };
}

/** Withdraws one of the account's tokens. False when it was not there. */
export async function revokeMcpToken(accountId: string, id: string): Promise<boolean> {
	const result = await (await store()).run('DELETE FROM mcp_tokens WHERE id = ? AND account_id = ?', id, accountId);
	if (result.changes > 0) log.info('mcp-token-withdrawn', { account: accountId, tokens: result.changes });
	return result.changes > 0;
}

/** Withdraws every token of the account. Returns how many there were. */
export async function revokeMcpTokens(accountId: string): Promise<number> {
	const result = await (await store()).run('DELETE FROM mcp_tokens WHERE account_id = ?', accountId);
	if (result.changes > 0) log.info('mcp-token-withdrawn', { account: accountId, tokens: result.changes });
	return result.changes;
}

/**
 * The account a request's `Authorization` header names through a live token,
 * with its credential opened for this request. Null for anything else,
 * including a token whose account's credential no longer opens, as after
 * `HEDDOHON_SECRET` changes.
 */
export async function mcpAccess(header: string | null): Promise<McpAccess | null> {
	const match = /^Bearer\s+(\S+)\s*$/i.exec(header ?? '');
	const token = match?.[1];
	if (!token || !token.startsWith(PREFIX) || token.length > MAX_TOKEN_LENGTH) return null;

	const database = await store();
	// Looked up by its digest, as a session is. The digest is an HMAC under
	// the server's secret, so the lookup's timing says nothing of the token.
	const row = await database.get<{
		id: string;
		account_id: string;
		writes: number;
		last_used_at: number | null;
		backend: string;
		credential: string;
	}>(
		`SELECT t.id, t.account_id, t.writes, t.last_used_at, a.backend, a.credential
		 FROM mcp_tokens t JOIN accounts a ON a.id = t.account_id WHERE t.token_digest = ?`,
		mcpDigest(token)
	);
	if (!row) return null;

	let credential: StoredCredential;
	try {
		credential = openJson<StoredCredential>(row.credential);
	} catch {
		return null;
	}

	const seen = now();
	if (row.last_used_at === null || seen - Number(row.last_used_at) >= LAST_USED_RESOLUTION_MS) {
		await database.run('UPDATE mcp_tokens SET last_used_at = ? WHERE id = ?', seen, row.id);
	}
	return {
		accountId: row.account_id,
		backend: row.backend as BackendKind,
		credential,
		writes: Number(row.writes) === 1
	};
}
