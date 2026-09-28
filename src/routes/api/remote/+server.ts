import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { config } from '$lib/server/config';
import { relay, type RemoteCommand } from '$lib/server/remote';

const SIMPLE = ['toggle', 'play', 'pause', 'next', 'previous'] as const;
/** The saved queue's cap; see `/api/play-state`. */
const MAX_TRANSFER_IDS = 1000;
/** A day. A position past any track's end is refused rather than clamped by the player. */
const MAX_POSITION_S = 86_400;

const isId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length < 256;
const isPosition = (value: unknown): value is number =>
	typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_POSITION_S;

/** The command in a request body, checked field by field, or null. */
function commandOf(raw: unknown): RemoteCommand | null {
	if (typeof raw !== 'object' || raw === null) return null;
	const command = raw as Record<string, unknown>;
	switch (command.type) {
		case 'seek':
			return isPosition(command.position) ? { type: 'seek', position: command.position } : null;
		case 'volume': {
			const volume = command.volume;
			return typeof volume === 'number' && volume >= 0 && volume <= 1 ? { type: 'volume', volume } : null;
		}
		case 'transfer': {
			const { ids, index, position, playing } = command;
			if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_TRANSFER_IDS || !ids.every(isId)) return null;
			if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= ids.length) return null;
			if (!isPosition(position) || typeof playing !== 'boolean') return null;
			return { type: 'transfer', ids, index, position, playing };
		}
		case 'handoff':
			return isId(command.to) ? { type: 'handoff', to: command.to } : null;
		default:
			return SIMPLE.includes(command.type as (typeof SIMPLE)[number])
				? { type: command.type as (typeof SIMPLE)[number] }
				: null;
	}
}

/**
 * Sends a command to another browser of the same account. The peer ids are
 * random and handed only to the account's own browsers, and the lookup is by
 * account as well, so a browser of another account is never reached.
 */
export const POST: RequestHandler = async ({ locals, request }) => {
	const session = locals.session;
	if (!session) error(401, 'Not signed in');
	if (!config().remoteControl) error(404, 'Not found');

	const body = (await request.json().catch(() => null)) as { to?: unknown; command?: unknown } | null;
	if (!body || !isId(body.to)) error(400, 'to is required');
	const command = commandOf(body.command);
	if (!command) error(400, 'command is not one this route takes');
	// A handoff names who the queue goes to, which has to be of this account too.
	if (command.type === 'handoff' && command.to === body.to) error(400, 'a browser cannot hand off to itself');

	if (!relay(session.account.id, body.to, command)) error(404, 'That browser is not connected');
	return json({ sent: true });
};
