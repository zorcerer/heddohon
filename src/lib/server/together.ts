/**
 * Listening together: a host plays, and anyone with the link hears the same
 * track at the same moment, without an account.
 *
 * A session ("party") belongs to one signed-in browser session. The host's
 * browser reports what it plays (`report`), and every listener's page holds
 * a server-sent events stream (`listen`) that carries it on, with the count of
 * listeners and the reactions they send. A listener's audio comes through the
 * party's link and is only ever the track the party is on (`routes/together`).
 *
 * Everything here is in the process's memory, like the remote-control
 * registry: a restart ends every party, and a deployment of several processes
 * behind a load balancer needs `HEDDOHON_REMOTE_CONTROL` off, which turns this
 * off too. The link's token is held with the party, so the host can show the
 * link again, and looked up by its digest.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { shareDigest } from './crypto';
import type { AuthenticatedSession } from './auth';
import { config } from './config';

/** How long a party lasts at most, and never past the host's session. */
export const PARTY_TTL_MS = 12 * 60 * 60 * 1000;
/** Listeners one party takes. */
export const MAX_LISTENERS = 50;
/** Parties held at once across the process. */
const MAX_PARTIES = 200;
/** One reaction a second per listener. */
const REACTION_GAP_MS = 1000;
/** The reactions a listener can send; nothing else is relayed. */
export const REACTIONS = ['🔥', '❤️', '👏', '😂', '🎉'] as const;

/** What the host is playing, as the listeners are told it. */
export interface PartyState {
	songId: string;
	title: string;
	artist: string | null;
	album: string | null;
	coverArt: string | null;
	/** Seconds. */
	duration: number;
	/** Seconds, as of `at`. */
	position: number;
	playing: boolean;
	/** Epoch millis the report arrived, set here. */
	at: number;
}

interface Listener {
	id: string;
	send(event: string, data: unknown): void;
	lastReaction: number;
}

interface Party {
	id: string;
	token: string;
	digest: string;
	accountId: string;
	/** The host's session; see `sessionHandle`. */
	session: string;
	backend: AuthenticatedSession['account']['backend'];
	createdAt: number;
	expiresAt: number;
	state: PartyState | null;
	listeners: Map<string, Listener>;
}

const byDigest = new Map<string, Party>();
const bySession = new Map<string, Party>();

/** Whether this deployment offers listening together. */
export function togetherEnabled(): boolean {
	const cfg = config();
	return cfg.sharing && cfg.remoteControl;
}

function live(party: Party | undefined): Party | null {
	if (!party) return null;
	if (Date.now() >= party.expiresAt) {
		end(party);
		return null;
	}
	return party;
}

function end(party: Party): void {
	byDigest.delete(party.digest);
	if (bySession.get(party.session) === party) bySession.delete(party.session);
	for (const listener of party.listeners.values()) listener.send('ended', {});
	party.listeners.clear();
}

function broadcast(party: Party, event: string, data: unknown): void {
	for (const listener of party.listeners.values()) listener.send(event, data);
}

function announceCount(party: Party): void {
	broadcast(party, 'listeners', { count: party.listeners.size });
}

export interface PartyView {
	id: string;
	url: string;
	expiresAt: number;
	listeners: number;
}

function view(party: Party): PartyView {
	return { id: party.id, url: `/together/${party.token}`, expiresAt: party.expiresAt, listeners: party.listeners.size };
}

/** The party this session hosts, if any. */
export function hostedBy(session: AuthenticatedSession): PartyView | null {
	const party = live(bySession.get(session.handle));
	return party ? view(party) : null;
}

/** Starts a party for this session, or returns the one it already hosts. Null when the process holds too many. */
export function startParty(session: AuthenticatedSession): PartyView | null {
	const existing = hostedBy(session);
	if (existing) return existing;
	if (byDigest.size >= MAX_PARTIES) return null;
	const token = randomBytes(24).toString('base64url');
	const party: Party = {
		id: randomUUID(),
		token,
		digest: shareDigest(`together:${token}`),
		accountId: session.account.id,
		session: session.handle,
		backend: session.account.backend,
		createdAt: Date.now(),
		expiresAt: Math.min(Date.now() + PARTY_TTL_MS, session.expiresAt),
		state: null,
		listeners: new Map()
	};
	byDigest.set(party.digest, party);
	bySession.set(party.session, party);
	return view(party);
}

/** Ends the party this session hosts. */
export function endParty(session: AuthenticatedSession): boolean {
	const party = bySession.get(session.handle);
	if (!party) return false;
	end(party);
	return true;
}

/** Ends every party hosted by these sessions, when they end. */
export function endPartiesOf(handles: string[]): void {
	for (const handle of handles) {
		const party = bySession.get(handle);
		if (party) end(party);
	}
}

/** Records what the host plays, and tells the listeners. False without a party. */
export function report(session: AuthenticatedSession, state: Omit<PartyState, 'at'> | null): boolean {
	const party = live(bySession.get(session.handle));
	if (!party) return false;
	party.state = state ? { ...state, at: Date.now() } : null;
	broadcast(party, 'state', { now: Date.now(), state: party.state });
	return true;
}

/** What a listener's request may know of the party behind a token. */
export interface PartyAccess {
	accountId: string;
	session: string;
	backend: Party['backend'];
	state: PartyState | null;
	expiresAt: number;
}

/** The party behind a link, or null for one that has ended or never was. */
export function partyFor(token: string): PartyAccess | null {
	if (!token || token.length > 128) return null;
	const party = live(byDigest.get(shareDigest(`together:${token}`)));
	if (!party) return null;
	return {
		accountId: party.accountId,
		session: party.session,
		backend: party.backend,
		state: party.state,
		expiresAt: party.expiresAt
	};
}

/**
 * Adds a listener's stream to the party behind a token. Null when there is no
 * such party, or it is full. The listener is told its id, what plays, and the
 * count; `leave` takes it out.
 */
export function listen(token: string, send: (event: string, data: unknown) => void): { id: string; leave(): void } | null {
	const party = live(byDigest.get(shareDigest(`together:${token}`)));
	if (!party || party.listeners.size >= MAX_LISTENERS) return null;
	const listener: Listener = { id: randomUUID(), send, lastReaction: 0 };
	party.listeners.set(listener.id, listener);
	send('hello', { id: listener.id });
	send('state', { now: Date.now(), state: party.state });
	announceCount(party);
	return {
		id: listener.id,
		leave() {
			if (party.listeners.delete(listener.id)) announceCount(party);
		}
	};
}

/**
 * Relays a reaction from a listener of the party to everyone in it. `ok` is
 * false for an unknown listener, `limited` for a second one inside a second.
 */
export function react(token: string, listenerId: string, emoji: string): 'ok' | 'unknown' | 'limited' {
	const party = live(byDigest.get(shareDigest(`together:${token}`)));
	const listener = party?.listeners.get(listenerId);
	if (!party || !listener) return 'unknown';
	const now = Date.now();
	if (now - listener.lastReaction < REACTION_GAP_MS) return 'limited';
	listener.lastReaction = now;
	broadcast(party, 'reaction', { emoji, from: listenerId });
	return 'ok';
}
