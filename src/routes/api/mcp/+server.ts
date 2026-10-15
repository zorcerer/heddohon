import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { destroyAllSessions } from '$lib/server/auth';
import { backendFor, UpstreamError } from '$lib/server/backends';
import { config } from '$lib/server/config';
import type { LibraryContext } from '$lib/server/library';
import { log, reason } from '$lib/server/log';
import { mcpAccess, type McpAccess } from '$lib/server/mcp';
import { describe, ToolInputError, toolsFor } from '$lib/server/mcptools';
import { APP_VERSION } from '$lib/server/version';

/**
 * The versions of the protocol this endpoint answers, newest first. A client
 * that asks for another is answered with the newest, and decides itself
 * whether to go on. Nothing here differs between them: the one feature of a
 * later version used is tool annotations, which an earlier client ignores.
 */
const VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

/** JSON-RPC's codes. */
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

type RpcId = string | number;

const refuse = (status: number, code: string, headers?: Record<string, string>) =>
	json({ error: code }, { status, headers });
const result = (id: RpcId, value: unknown) => json({ jsonrpc: '2.0', id, result: value });
const failure = (id: RpcId | null, code: number, message: string, status = 200) =>
	json({ jsonrpc: '2.0', id, error: { code, message } }, { status });
/** A tool's own failure, which the assistant reads, as against a fault in the request. */
const toolFailure = (id: RpcId, message: string) =>
	result(id, { content: [{ type: 'text', text: message }], isError: true });

const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The account the request's token acts as, or the answer that refuses it. The
 * token is the one authority: a session cookie the request carries is not
 * read.
 */
async function authorize(request: Request): Promise<McpAccess | Response> {
	// The hook answers the same for this path; this is for one spelled another
	// way (`/api/%6Dcp`), which reaches the route through the gate.
	if (!config().mcp) return refuse(404, 'not_found');
	const access = await mcpAccess(request.headers.get('authorization'));
	if (access) return access;
	log.warn('mcp-refused', {});
	return refuse(401, 'not_authenticated', { 'www-authenticate': 'Bearer' });
}

/**
 * The Model Context Protocol over its Streamable HTTP transport, for an AI
 * assistant's client. `lib/server/mcp.ts` has the tokens and
 * `lib/server/mcptools.ts` what a client can call.
 *
 * Each request is one JSON-RPC message, answered with one JSON body. No
 * session id is issued and no stream is opened, which the transport allows:
 * GET and DELETE answer 405 to a client with a token. `hooks.server.ts`
 * serves this path ahead of the origin check and the session gate, and the
 * comment there has why.
 */
export const POST: RequestHandler = async ({ request }) => {
	const access = await authorize(request);
	if (access instanceof Response) return access;
	if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
		return refuse(415, 'json_required');
	}
	const version = request.headers.get('mcp-protocol-version');
	if (version !== null && !VERSIONS.includes(version)) {
		return failure(null, INVALID_REQUEST, `MCP-Protocol-Version ${version.slice(0, 32)} is not one this server answers`, 400);
	}

	let message: unknown;
	try {
		message = JSON.parse(await request.text());
	} catch {
		return failure(null, PARSE_ERROR, 'The body is not JSON', 400);
	}
	// Taken out of the protocol in 2025-06-18.
	if (Array.isArray(message)) return failure(null, INVALID_REQUEST, 'A batch of messages is not taken', 400);
	if (!isObject(message) || message.jsonrpc !== '2.0') return failure(null, INVALID_REQUEST, 'Not a JSON-RPC 2.0 message', 400);
	// A notification (`notifications/initialized`) or an answer: nothing to say back.
	if (message.id === undefined || typeof message.method !== 'string') return new Response(null, { status: 202 });
	const id = message.id;
	if (typeof id !== 'string' && typeof id !== 'number') return failure(null, INVALID_REQUEST, 'id must be a string or a number', 400);
	const params = isObject(message.params) ? message.params : {};

	const ctx: LibraryContext = {
		backend: backendFor(access.backend),
		credential: access.credential,
		accountId: access.accountId
	};
	const tools = toolsFor(ctx, access.writes);

	switch (message.method) {
		case 'initialize': {
			const cfg = config();
			const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
			const label = cfg.upstreams.find((up) => up.kind === access.backend)?.label ?? 'the music server';
			return result(id, {
				protocolVersion: VERSIONS.includes(asked) ? asked : VERSIONS[0],
				capabilities: { tools: { listChanged: false } },
				serverInfo: { name: 'heddohon', title: cfg.appName, version: APP_VERSION },
				instructions:
					`${cfg.appName} plays one account's music library from ${label}. ` +
					'Ids from one tool are taken by the others: a song id from search goes into add_to_playlist. ' +
					(access.writes
						? 'Playlist entries are removed by position, counted from 0; read the playlist with get_playlist first, as positions change with every edit.'
						: 'This token reads the library and changes nothing.')
			});
		}
		case 'ping':
			return result(id, {});
		case 'tools/list':
			return result(id, { tools: tools.map(describe) });
		case 'tools/call': {
			const tool = tools.find((candidate) => candidate.name === params.name);
			if (!tool) return failure(id, INVALID_PARAMS, `There is no tool ${String(params.name).slice(0, 64)}`);
			const args = isObject(params.arguments) ? params.arguments : {};
			const started = performance.now();
			try {
				const value = await tool.run(ctx, args);
				log.debug('mcp-call', { tool: tool.name, ms: Math.round(performance.now() - started) });
				return result(id, { content: [{ type: 'text', text: JSON.stringify(value) }] });
			} catch (err) {
				log.debug('mcp-call', { tool: tool.name, ms: Math.round(performance.now() - started), error: reason(err) });
				if (err instanceof ToolInputError) return toolFailure(id, err.message);
				if (!(err instanceof UpstreamError)) throw err;
				// What the music server said stays here, as on a page (invariant 1).
				if (err.kind === 'auth') {
					// As `library()` does for a page: the credential stopped working.
					// This ends the token too.
					await destroyAllSessions(access.accountId);
					return toolFailure(id, 'The music server no longer accepts this account. Sign in to Heddohon again and make a new token under Settings.');
				}
				if (err.kind === 'not_found') return toolFailure(id, 'The music server has nothing with that id for this account.');
				if (err.kind === 'forbidden') {
					return toolFailure(id, 'The music server does not let this account do that. Only the owner of a playlist can change it.');
				}
				return toolFailure(id, 'The music server did not complete that. Try again.');
			}
		}
		default:
			return failure(id, METHOD_NOT_FOUND, `There is no method ${message.method.slice(0, 64)}`);
	}
};

/** The transport's stream from the server, which this endpoint does not open. */
export const GET: RequestHandler = async ({ request }) => {
	const access = await authorize(request);
	return access instanceof Response ? access : new Response(null, { status: 405, headers: { allow: 'POST' } });
};

/** The transport's end of a session, which this endpoint does not issue. */
export const DELETE: RequestHandler = async ({ request }) => {
	const access = await authorize(request);
	return access instanceof Response ? access : new Response(null, { status: 405, headers: { allow: 'POST' } });
};
