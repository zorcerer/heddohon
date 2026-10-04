/**
 * The browsers of one account that have the player open, and the commands one
 * sends to another: pause the desktop from the phone, or move the phone's
 * queue to the desktop.
 *
 * Each browser holds a server-sent events stream open (`/api/remote/events`),
 * which makes it a peer and is how commands reach it. The registry is in this
 * process's memory. A restart drops every stream and the browsers reconnect.
 * With several processes behind a load balancer, a browser sees only the peers
 * on its own process.
 *
 * A command goes only to a peer of the same account, and a report of what a
 * peer plays is taken only from the session that opened its stream.
 */
import { randomUUID } from 'node:crypto';

/** What a browser says it is playing, shown to the account's other browsers. */
export interface RemoteState {
	songId: string;
	title: string;
	artist: string | null;
	coverArt: string | null;
	/** Seconds, as of `at`. */
	position: number;
	duration: number;
	playing: boolean;
	volume: number;
	/** Epoch millis the report arrived, set here rather than trusted. */
	at: number;
}

export interface RemotePeer {
	id: string;
	/** "Firefox on Linux", from the stream request's user agent; see `deviceLabel`. */
	device: string | null;
	/** Epoch millis the stream opened, which tells two browsers of one kind apart. */
	since: number;
	/** Null until the browser has something to play. */
	state: RemoteState | null;
}

export type RemoteCommand =
	| { type: 'toggle' | 'play' | 'pause' | 'next' | 'previous' }
	| { type: 'seek'; position: number }
	| { type: 'volume'; volume: number }
	/** Plays these tracks from `index`, at `position`, paused unless `playing`. */
	| { type: 'transfer'; ids: string[]; index: number; position: number; playing: boolean }
	/** Asks the peer to send its own queue to `to` with `transfer`, and pause. */
	| { type: 'handoff'; to: string };

interface Peer extends RemotePeer {
	accountId: string;
	/** The session that opened the stream; see `sessionHandle`. */
	session: string;
	send(event: string, data: unknown): void;
}

/**
 * Peers one account may hold, one per open tab. An account has at most 50
 * sessions. 20 bounds a script that opens streams in a loop.
 */
const MAX_PEERS_PER_ACCOUNT = 20;

const accounts = new Map<string, Map<string, Peer>>();

function view(peer: Peer): RemotePeer {
	return { id: peer.id, device: peer.device, since: peer.since, state: peer.state };
}

/** Tells every peer of the account who else is there, and what each is playing. */
function announce(accountId: string): void {
	const peers = accounts.get(accountId);
	if (!peers) return;
	const list = [...peers.values()].map(view);
	// The server's clock goes with the list, so a browser can work out how far a
	// playing peer has got since its report, whatever its own clock says.
	const now = Date.now();
	for (const peer of peers.values()) peer.send('peers', { now, peers: list });
}

/** Adds a browser whose stream has just opened. Null when the account holds as many as it may. */
export function join(
	accountId: string,
	session: string,
	device: string | null,
	send: (event: string, data: unknown) => void
): RemotePeer | null {
	let peers = accounts.get(accountId);
	if (!peers) accounts.set(accountId, (peers = new Map()));
	if (peers.size >= MAX_PEERS_PER_ACCOUNT) return null;
	const peer: Peer = { id: randomUUID(), device, since: Date.now(), state: null, accountId, session, send };
	peers.set(peer.id, peer);
	peer.send('hello', { id: peer.id });
	announce(accountId);
	return view(peer);
}

/** Removes a browser whose stream has closed. */
export function leave(accountId: string, id: string): void {
	const peers = accounts.get(accountId);
	if (!peers?.delete(id)) return;
	if (peers.size === 0) accounts.delete(accountId);
	else announce(accountId);
}

/**
 * Records what a peer is playing, and tells the others. False when `id` is not
 * a stream this session opened.
 */
export function report(accountId: string, session: string, id: string, state: Omit<RemoteState, 'at'> | null): boolean {
	const peer = accounts.get(accountId)?.get(id);
	if (!peer || peer.session !== session) return false;
	peer.state = state ? { ...state, at: Date.now() } : null;
	announce(accountId);
	return true;
}

/** Sends a command to a peer of the account. False when there is no such peer. */
export function relay(accountId: string, to: string, command: RemoteCommand): boolean {
	const peer = accounts.get(accountId)?.get(to);
	if (!peer) return false;
	peer.send('command', command);
	return true;
}
