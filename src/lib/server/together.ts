/**
 * Listening together: a host plays, and anyone with the link hears the same
 * track at the same moment, without an account.
 *
 * A party belongs to one signed-in browser session. The host's browser reports
 * what it plays (`report`), and each listener's page holds a server-sent
 * events stream (`listen`) carrying that, the listener count and reactions. A
 * listener's audio comes through the party's link and is only the track the
 * party is on (`routes/together`).
 *
 * A listener signed in on the host's music server can join as a member
 * (`join`), is shown by name and adds tracks to the host's queue. The host's
 * player holds the queue and its order. An addition is kept here until the
 * host's browser has taken it (`admit`, `enqueue`), and that browser reports
 * what is up next (`reportQueue`), which everyone is shown.
 *
 * All of it is in this process's memory, like the remote-control registry: a
 * restart ends every party, and `HEDDOHON_REMOTE_CONTROL` off turns this off
 * too. The link's token is held with the party, so the host can show the link
 * again, and is looked up by its digest.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { shareDigest } from './crypto';
import type { AuthenticatedSession } from './auth';
import { config } from './config';
import type { Song } from '$lib/types';

/** The longest a party lasts. It also ends with the host's session. */
const PARTY_TTL_MS = 12 * 60 * 60 * 1000;
/** Listeners one party takes. */
const MAX_LISTENERS = 50;
/** Parties held at once across the process. */
const MAX_PARTIES = 200;
/** One reaction a second per listener. */
const REACTION_GAP_MS = 1000;
/** The reactions a listener can send; nothing else is relayed. */
export const REACTIONS = ['🔥', '❤️', '👏', '😂', '🎉'] as const;
/** One addition every 2 seconds per member, counted whether or not the track is accepted. */
const ADD_GAP_MS = 2000;
/** Additions of one member waiting in the queue, and of the whole party. */
const MAX_ADDED_PER_MEMBER = 50;
const MAX_ADDED = 500;
/** How much of what is up next the host reports, the cap of a saved queue. */
export const MAX_UPCOMING = 1000;
/** How much of it the listeners are sent. */
export const QUEUE_SHOWN = 50;

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

/** A member as the party sees it: an id made for this party, and the account's name. */
export interface MemberView {
	id: string;
	name: string;
}

/** One track of what is up next, as everyone in the party is shown it. */
export interface QueueRow {
	/** The addition's id, or null for a track the host queued. */
	entry: string | null;
	title: string;
	artist: string | null;
	by: MemberView | null;
}

/** One track of the host's upcoming queue, as its browser reports it. */
export interface UpcomingReport {
	songId: string;
	title: string;
	artist: string | null;
}

/** An addition as the host's browser is sent it, to put in its queue. */
export interface AdditionEvent {
	seq: number;
	entry: string;
	song: Song;
	by: MemberView;
}

interface Listener {
	id: string;
	send(event: string, data: unknown): void;
	/** Ends the stream from this side. */
	close(): void;
	lastReaction: number;
	/** The host's own browser, which is sent the additions. */
	host: boolean;
	/** The account signed in where the stream was opened, if any. */
	account: string | null;
	/** The account this stream joined as, and the session it did so with. */
	member: string | null;
	session: string | null;
}

interface Member extends MemberView {
	accountId: string;
	lastAdd: number;
}

interface Addition {
	id: string;
	/** Its place in the order of additions; the host's browser reports the highest it has taken. */
	seq: number;
	song: Song;
	by: Member;
	/** Its member took it back while the host's browser held it. */
	withdrawn: boolean;
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
	/** By account id. */
	members: Map<string, Member>;
	/** Accounts the host removed, refused for the rest of the party. */
	removed: Set<string>;
	/** Additions the host's queue has not played or dropped yet, oldest first. */
	additions: Addition[];
	seq: number;
	/** The highest `seq` the host's browser has put in its queue. */
	applied: number;
	/** The host's last report of what is up next, cut to `QUEUE_SHOWN`, and its full length. */
	upcoming: QueueRow[];
	upcomingTotal: number;
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

function behind(token: string): Party | null {
	if (!token || token.length > 128) return null;
	return live(byDigest.get(shareDigest(`together:${token}`)));
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

function toHost(party: Party, event: string, data: unknown): void {
	for (const listener of party.listeners.values()) if (listener.host) listener.send(event, data);
}

function announceCount(party: Party): void {
	broadcast(party, 'listeners', { count: party.listeners.size });
}

/** The members whose page is open, for the host. */
function membersHere(party: Party): MemberView[] {
	const here = new Set<string>();
	for (const listener of party.listeners.values()) if (listener.member) here.add(listener.member);
	return [...here].flatMap((accountId) => {
		const member = party.members.get(accountId);
		return member ? [{ id: member.id, name: member.name }] : [];
	});
}

function announceMembers(party: Party): void {
	toHost(party, 'members', { members: membersHere(party) });
}

const rowOf = (addition: Addition): QueueRow => ({
	entry: addition.id,
	title: addition.song.title,
	artist: addition.song.artist,
	by: { id: addition.by.id, name: addition.by.name }
});

/**
 * What is up next, for everyone: the host's last report, with the additions
 * its browser has not taken yet placed after the additions that lead the
 * queue, where it will put them.
 */
function queueView(party: Party): { queue: QueueRow[]; total: number } {
	const waiting = party.additions.filter((addition) => addition.seq > party.applied);
	let lead = 0;
	while (party.upcoming[lead]?.by) lead += 1;
	const queue = [...party.upcoming.slice(0, lead), ...waiting.map(rowOf), ...party.upcoming.slice(lead)];
	return { queue: queue.slice(0, QUEUE_SHOWN), total: party.upcomingTotal + waiting.length };
}

function announceQueue(party: Party): void {
	broadcast(party, 'queue', queueView(party));
}

const eventOf = (addition: Addition): AdditionEvent => ({
	seq: addition.seq,
	entry: addition.id,
	song: addition.song,
	by: { id: addition.by.id, name: addition.by.name }
});

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
		listeners: new Map(),
		members: new Map(),
		removed: new Set(),
		additions: [],
		seq: 0,
		applied: 0,
		upcoming: [],
		upcomingTotal: 0
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

/**
 * Ends every party these sessions host. A member whose session ends stays as
 * a listener: the name leaves the host's list, and adding needs the session.
 */
export function endPartiesOf(handles: string[]): void {
	for (const handle of handles) {
		const party = bySession.get(handle);
		if (party) end(party);
	}
	const ended = new Set(handles);
	for (const party of byDigest.values()) {
		let changed = false;
		for (const listener of party.listeners.values()) {
			if (!listener.session || !ended.has(listener.session)) continue;
			listener.member = null;
			listener.session = null;
			changed = true;
		}
		if (changed) announceMembers(party);
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

/**
 * Records what is up next in the host's queue, and tells everyone. `applied`
 * is the highest addition its browser has put in the queue.
 *
 * Additions are matched to the report by song id, each once and in the order
 * made, so a queue restored from its ids after a reload keeps who added what.
 * A taken addition missing from the report was played or removed, and is let
 * go. Returns, for each reported track, which addition it is. Null without a
 * party.
 */
export function reportQueue(
	session: AuthenticatedSession,
	applied: number,
	upcoming: UpcomingReport[]
): ({ entry: string; name: string } | null)[] | null {
	const party = live(bySession.get(session.handle));
	if (!party) return null;
	party.applied = Math.max(party.applied, Math.min(applied, party.seq));
	const taken = new Map<string, Addition[]>();
	for (const addition of party.additions) {
		if (addition.seq > party.applied) continue;
		const same = taken.get(addition.song.id);
		if (same) same.push(addition);
		else taken.set(addition.song.id, [addition]);
	}
	const found = upcoming.map((track) => taken.get(track.songId)?.shift() ?? null);
	const kept = new Set(found);
	party.additions = party.additions.filter((addition) => addition.seq > party.applied || kept.has(addition));
	party.upcoming = upcoming.slice(0, QUEUE_SHOWN).map((track, i) => {
		const addition = found[i];
		return addition ? rowOf(addition) : { entry: null, title: track.title, artist: track.artist, by: null };
	});
	party.upcomingTotal = upcoming.length;
	announceQueue(party);
	return found.map((addition) => (addition ? { entry: addition.id, name: addition.by.name } : null));
}

/**
 * Who a request is to a party.
 *
 * A `member` may join: an account on the host's music server, where the track
 * ids are the host's too. An account on a deployment's other server is a
 * `listener`, like a visitor without one. `removed` was removed by the host.
 */
type Standing = 'host' | 'member' | 'listener' | 'removed';

function standing(party: Party, viewer: AuthenticatedSession | null): Standing {
	if (!viewer) return 'listener';
	// Before `removed`: the host's account can join from another browser and be
	// removed there, which leaves the hosting session as it was.
	if (viewer.account.id === party.accountId && viewer.handle === party.session) return 'host';
	if (party.removed.has(viewer.account.id)) return 'removed';
	return viewer.account.backend === party.backend ? 'member' : 'listener';
}

/** What a listener's request may know of the party behind a token. */
export interface PartyAccess {
	accountId: string;
	session: string;
	backend: Party['backend'];
	state: PartyState | null;
	expiresAt: number;
	standing: Exclude<Standing, 'removed'>;
	/** What is up next, as the page starts with it. */
	queue: QueueRow[];
	queueTotal: number;
}

/**
 * The party behind a link. Null for one that has ended or never existed, and
 * for an account the host removed.
 */
export function partyFor(token: string, viewer: AuthenticatedSession | null): PartyAccess | null {
	const party = behind(token);
	if (!party) return null;
	const as = standing(party, viewer);
	if (as === 'removed') return null;
	const { queue, total } = queueView(party);
	return {
		accountId: party.accountId,
		session: party.session,
		backend: party.backend,
		state: party.state,
		expiresAt: party.expiresAt,
		standing: as,
		queue,
		queueTotal: total
	};
}

/** Whether the host removed this account from the party behind a link. */
export function removedFrom(token: string, viewer: AuthenticatedSession | null): boolean {
	const party = behind(token);
	return !!party && !!viewer && party.removed.has(viewer.account.id);
}

/**
 * Adds a listener's stream to the party behind a token. Null when there is no
 * such party, it is full, or the host removed the account. The listener is
 * sent its id, what plays, what is up next and the count. The host's browser
 * is also sent who is here and which additions it has yet to take or drop.
 */
export function listen(
	token: string,
	viewer: AuthenticatedSession | null,
	send: (event: string, data: unknown) => void,
	close: () => void
): { id: string; leave(): void } | null {
	const party = behind(token);
	if (!party || party.listeners.size >= MAX_LISTENERS) return null;
	const as = standing(party, viewer);
	if (as === 'removed') return null;
	const listener: Listener = {
		id: randomUUID(),
		send,
		close,
		lastReaction: 0,
		host: as === 'host',
		account: viewer?.account.id ?? null,
		member: null,
		session: null
	};
	party.listeners.set(listener.id, listener);
	send('hello', { id: listener.id });
	send('state', { now: Date.now(), state: party.state });
	send('queue', queueView(party));
	if (listener.host) {
		send('host', {
			applied: party.applied,
			waiting: party.additions.filter((addition) => addition.seq > party.applied).map(eventOf),
			withdrawn: party.additions.filter((addition) => addition.withdrawn).map((addition) => addition.id)
		});
		send('members', { members: membersHere(party) });
	}
	announceCount(party);
	return {
		id: listener.id,
		leave() {
			if (!party.listeners.delete(listener.id)) return;
			announceCount(party);
			if (listener.member) announceMembers(party);
		}
	};
}

/**
 * Relays a listener's reaction to everyone in the party. `unknown` for a
 * listener not in it, `limited` for a second reaction inside a second.
 */
export function react(token: string, listenerId: string, emoji: string): 'ok' | 'unknown' | 'limited' {
	const party = behind(token);
	const listener = party?.listeners.get(listenerId);
	if (!party || !listener) return 'unknown';
	const now = Date.now();
	if (now - listener.lastReaction < REACTION_GAP_MS) return 'limited';
	listener.lastReaction = now;
	broadcast(party, 'reaction', { emoji, from: listenerId });
	return 'ok';
}

/**
 * Makes a listener's stream a member's: the account is shown to the host by
 * name and may add to the queue. `unknown` without such a stream, `refused`
 * for an account that may not be a member.
 *
 * The stream must be one the account opened. Listener ids go to everyone with
 * a reaction, and joining by id alone let a member put their name on a
 * stranger's stream, which counted as the member being here and stayed open
 * when the host removed them.
 */
export function join(token: string, listenerId: string, viewer: AuthenticatedSession): MemberView | 'unknown' | 'refused' {
	const party = behind(token);
	const listener = party?.listeners.get(listenerId);
	if (!party || !listener || listener.account !== viewer.account.id) return 'unknown';
	if (standing(party, viewer) !== 'member') return 'refused';
	let member = party.members.get(viewer.account.id);
	if (!member) {
		member = { id: randomUUID(), accountId: viewer.account.id, name: viewer.account.username, lastAdd: 0 };
		party.members.set(member.accountId, member);
	}
	listener.member = member.accountId;
	listener.session = viewer.handle;
	announceMembers(party);
	return { id: member.id, name: member.name };
}

/** The party this account is a member of with a page open, for adding from the app. */
export function joinedBy(viewer: AuthenticatedSession): { url: string } | null {
	for (const candidate of byDigest.values()) {
		const party = live(candidate);
		if (!party?.members.has(viewer.account.id)) continue;
		for (const listener of party.listeners.values()) {
			if (listener.member === viewer.account.id) return { url: `/together/${party.token}` };
		}
	}
	return null;
}

export type AddRefusal = 'unknown' | 'not_member' | 'limited' | 'member_full' | 'party_full';

function room(party: Party, member: Member): AddRefusal | null {
	if (party.additions.length >= MAX_ADDED) return 'party_full';
	if (party.additions.filter((addition) => addition.by === member).length >= MAX_ADDED_PER_MEMBER) return 'member_full';
	return null;
}

/**
 * Whether this account may add a track now, checked before the track is looked
 * up on the music server. The attempt counts against the member's one per 2
 * seconds whether or not the track is accepted. Returns the host's account and
 * session, for the lookup.
 */
export function admit(token: string, viewer: AuthenticatedSession): { accountId: string; session: string } | AddRefusal {
	const party = behind(token);
	if (!party) return 'unknown';
	const member = standing(party, viewer) === 'member' ? party.members.get(viewer.account.id) : undefined;
	if (!member) return 'not_member';
	const now = Date.now();
	if (now - member.lastAdd < ADD_GAP_MS) return 'limited';
	member.lastAdd = now;
	return room(party, member) ?? { accountId: party.accountId, session: party.session };
}

/**
 * Adds a track `admit` let through, as the host's account reads it, and sends
 * it to the host's browser. The party is checked again: it can have ended,
 * filled or lost the member during the lookup.
 */
export function enqueue(token: string, viewer: AuthenticatedSession, song: Song): { entry: string } | AddRefusal {
	const party = behind(token);
	if (!party) return 'unknown';
	const member = standing(party, viewer) === 'member' ? party.members.get(viewer.account.id) : undefined;
	if (!member) return 'not_member';
	const full = room(party, member);
	if (full) return full;
	const addition: Addition = { id: randomUUID(), seq: ++party.seq, song, by: member, withdrawn: false };
	party.additions.push(addition);
	toHost(party, 'add', eventOf(addition));
	announceQueue(party);
	return { entry: addition.id };
}

/**
 * Takes back an addition, for the member who made it. One the host's browser
 * has not taken is dropped here. One in the host's queue is removed by the
 * host's browser, told now and again when its stream next opens.
 */
export function withdraw(token: string, viewer: AuthenticatedSession, entry: string): boolean {
	const party = behind(token);
	if (!party || standing(party, viewer) !== 'member') return false;
	const addition = party.additions.find((candidate) => candidate.id === entry && candidate.by.accountId === viewer.account.id);
	if (!addition) return false;
	if (addition.seq > party.applied) {
		party.additions = party.additions.filter((candidate) => candidate !== addition);
		announceQueue(party);
	} else {
		addition.withdrawn = true;
		toHost(party, 'remove', { entry: addition.id });
	}
	return true;
}

/**
 * Removes a member from the party this session hosts. Every stream the account
 * has open ends, joined or not, its additions the host's browser has not taken
 * are dropped, and it is refused for the rest of the party. Tracks already in
 * the host's queue stay for the host to remove.
 */
export function removeMember(session: AuthenticatedSession, memberId: string): boolean {
	const party = live(bySession.get(session.handle));
	if (!party) return false;
	const member = [...party.members.values()].find((candidate) => candidate.id === memberId);
	if (!member) return false;
	party.members.delete(member.accountId);
	party.removed.add(member.accountId);
	party.additions = party.additions.filter((addition) => addition.by !== member || addition.seq <= party.applied);
	for (const listener of [...party.listeners.values()]) {
		if (listener.account !== member.accountId || listener.host) continue;
		party.listeners.delete(listener.id);
		listener.send('removed', {});
		listener.close();
	}
	announceCount(party);
	announceMembers(party);
	announceQueue(party);
	return true;
}
