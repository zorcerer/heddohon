/**
 * Hosting a listen-together session from this browser; `server/together.ts`
 * has how the server keeps it.
 *
 * While a party is open, this browser tells the server what it plays: at once
 * when the track or the play state changes or the position jumps (a seek),
 * and every 15 seconds besides. It also holds the party's event stream, for
 * the count of listeners, their reactions, the members and what they add.
 *
 * An addition goes into the player's queue as it arrives, and what is up next
 * is reported whenever it changes, which is how the listeners see the queue
 * and how the server learns an addition was played or removed. Additions and
 * reports are handled one at a time, in the order they came: the server is
 * told the highest addition taken, so one taken out of turn would be counted
 * as taken with those before it.
 *
 * This module also knows whether the account has joined someone else's party
 * as a member, for "Add to listen together" on a track.
 */
import type { AdditionEvent, MemberView, PartyView } from '$lib/server/together';
import type { Song } from '$lib/types';
import { player } from './player.svelte';

/** A report that has not moved further than this from where it was is not sent again. */
const DRIFT_S = 1;
const CHECK_MS = 1000;
const HEARTBEAT_MS = 15_000;
/** How long a reaction floats on screen. */
const REACTION_MS = 2400;
/** What the server reads of the queue, and how many of its titles it keeps; see `server/together.ts`. */
const MAX_UPCOMING = 1000;
const QUEUE_SHOWN = 50;
/** How long the answer to "Add to listen together" stays on screen. */
const NOTICE_MS = 4000;

export interface FloatingReaction {
	key: number;
	emoji: string;
}

class Together {
	party = $state<PartyView | null>(null);
	/** Listeners other than this browser. */
	listeners = $state(0);
	/** Members with the party's page open, for the host to see and remove. */
	members = $state<MemberView[]>([]);
	reactions = $state<FloatingReaction[]>([]);
	/** Whether the dialog with the link is open. */
	open = $state(false);
	busy = $state(false);
	error = $state<string | null>(null);
	/** The party this account has joined as a member, with its page open in some browser. */
	joined = $state<{ url: string } | null>(null);
	/** What the last "Add to listen together" came to. */
	notice = $state<{ text: string; failed: boolean } | null>(null);

	#source: EventSource | null = null;
	#timer: ReturnType<typeof setInterval> | null = null;
	#last: { songId: string | null; playing: boolean; position: number; at: number } | null = null;
	#key = 0;
	/** The highest addition put in the player's queue. */
	#applied = 0;
	/** The queue last reported, as its ids. */
	#reported: string | null = null;
	/** Additions and queue reports, one after the other. */
	#work: Promise<unknown> = Promise.resolve();
	#waiting = 0;
	/** The saved queue coming back after a reload; see `after`. */
	#restored: Promise<unknown> = Promise.resolve();
	#noticeTimer: ReturnType<typeof setTimeout> | null = null;
	#watching = false;

	/**
	 * Holds queue reports until `restored` settles. A report made while the
	 * saved queue is still being looked up would say nothing is up next, and
	 * the server would let go of every addition in it.
	 */
	after(restored: Promise<unknown>) {
		this.#restored = restored;
	}

	/** Picks up a party this browser was already hosting, after a reload, and one the account has joined. */
	async resume() {
		if (!this.#watching && typeof window !== 'undefined') {
			this.#watching = true;
			window.addEventListener('focus', this.#look);
			document.addEventListener('visibilitychange', this.#look);
		}
		const response = await fetch('/api/together').catch(() => null);
		const body = response?.ok ? ((await response.json()) as { party: PartyView | null; joined: { url: string } | null }) : null;
		this.joined = body?.joined ?? null;
		if (body?.party) this.#attach(body.party);
	}

	/**
	 * Whether the account has joined a party, asked when this tab is come back
	 * to: joining happens on the party's own page, in another tab or browser.
	 */
	#look = () => {
		if (document.hidden) return;
		void fetch('/api/together').then(
			async (response) => {
				if (response.ok) this.joined = (await response.json()).joined ?? null;
			},
			() => undefined
		);
	};

	async start() {
		this.busy = true;
		this.error = null;
		try {
			const response = await fetch('/api/together', { method: 'POST' });
			if (!response.ok) {
				this.error = (await response.json().catch(() => null))?.message ?? 'Listening together could not start.';
				return;
			}
			this.#attach((await response.json()).party as PartyView);
			this.open = true;
		} catch {
			this.error = 'Listening together could not start.';
		} finally {
			this.busy = false;
		}
	}

	async end() {
		await fetch('/api/together', { method: 'DELETE' }).catch(() => undefined);
		this.#detach();
		this.open = false;
	}

	/** Stops following without ending the party, when the page goes away. */
	stop() {
		this.#detach();
		if (this.#watching) {
			this.#watching = false;
			window.removeEventListener('focus', this.#look);
			document.removeEventListener('visibilitychange', this.#look);
		}
	}

	/** The link to hand out, with this server's address. */
	get link(): string {
		return this.party ? new URL(this.party.url, location.origin).toString() : '';
	}

	/** Removes a member from the party this browser hosts, for the rest of it. */
	async remove(member: MemberView) {
		await fetch('/api/together/members', {
			method: 'DELETE',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ member: member.id })
		}).catch(() => undefined);
	}

	/** Adds a track to the party this account has joined, and says what came of it. */
	async add(song: Song) {
		const joined = this.joined;
		if (!joined) return;
		const response = await fetch(`${joined.url}/queue`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ songId: song.id })
		}).catch(() => null);
		if (response?.ok) this.#say(`${song.title} was added to listen together.`, false);
		else {
			this.#say((await response?.json().catch(() => null))?.message ?? 'The track could not be added.', true);
			// The party ended, or the host removed this account.
			if (response?.status === 404 || response?.status === 403) this.#look();
		}
	}

	#say(text: string, failed: boolean) {
		if (this.#noticeTimer) clearTimeout(this.#noticeTimer);
		this.notice = { text, failed };
		this.#noticeTimer = setTimeout(() => (this.notice = null), NOTICE_MS);
	}

	#attach(party: PartyView) {
		this.#detach();
		this.party = party;
		this.listeners = 0;
		const source = new EventSource(`${party.url}/events`);
		this.#source = source;
		const data = (event: Event) => JSON.parse((event as MessageEvent).data);
		// This browser's own stream is one of the count.
		source.addEventListener('listeners', (event) => {
			this.listeners = Math.max(0, data(event).count - 1);
		});
		source.addEventListener('members', (event) => (this.members = data(event).members));
		source.addEventListener('reaction', (event) => this.float(data(event).emoji));
		source.addEventListener('ended', () => this.#detach());
		// Sent as the stream opens, and again each time it reopens.
		source.addEventListener('host', (event) => {
			const told = data(event) as { applied: number; waiting: AdditionEvent[]; withdrawn: string[] };
			this.#then(async () => {
				this.#applied = Math.max(this.#applied, told.applied);
				// First, so a queue restored from its ids has its additions named
				// again before any is looked for.
				await this.#reportQueue(true);
				for (const entry of told.withdrawn) this.#drop(entry);
				for (const addition of told.waiting) this.#take(addition);
				await this.#reportQueue();
			});
		});
		source.addEventListener('add', (event) => {
			const addition = data(event) as AdditionEvent;
			this.#then(async () => {
				this.#take(addition);
				await this.#reportQueue();
			});
		});
		source.addEventListener('remove', (event) => {
			const { entry } = data(event) as { entry: string };
			this.#then(async () => {
				this.#drop(entry);
				await this.#reportQueue();
			});
		});
		this.#last = null;
		this.#reported = null;
		this.#applied = 0;
		this.#report();
		this.#timer = setInterval(() => {
			this.#report();
			// One waiting is enough: it reports the queue as it is when it runs.
			if (this.#waiting === 0) this.#then(() => this.#reportQueue());
		}, CHECK_MS);
	}

	#detach() {
		this.#source?.close();
		this.#source = null;
		if (this.#timer) clearInterval(this.#timer);
		this.#timer = null;
		this.party = null;
		this.listeners = 0;
		this.members = [];
	}

	/** Runs `step` after the steps before it, for the party it was asked for and once the saved queue is back. */
	#then(step: () => void | Promise<void>) {
		const source = this.#source;
		this.#waiting += 1;
		this.#work = this.#work
			.then(() => this.#restored)
			.then(() => (this.#source === source ? step() : undefined))
			.catch(() => undefined)
			.finally(() => (this.#waiting -= 1));
	}

	/** Puts an addition in the player's queue, once. */
	#take(addition: AdditionEvent) {
		if (addition.seq <= this.#applied) return;
		this.#applied = addition.seq;
		player.queueAddition({ ...addition.song, addedBy: { entry: addition.entry, name: addition.by.name } });
	}

	/** Takes out an addition its member took back, unless it is playing or has played. */
	#drop(entry: string) {
		const at = player.queue.findIndex((song, i) => i > player.index && song.addedBy?.entry === entry);
		if (at >= 0) player.removeAt(at);
	}

	/**
	 * Tells the server what is up next, when it has changed, and marks the
	 * tracks the server says are additions. The marks are lost with the page;
	 * the server keeps who added what and finds the tracks again by their ids.
	 */
	async #reportQueue(always = false) {
		if (!this.party) return;
		const upcoming = player.queue.slice(player.index + 1, player.index + 1 + MAX_UPCOMING);
		const signature = `${this.#applied}:${upcoming.map((song) => song.id).join(',')}`;
		if (!always && signature === this.#reported) return;
		this.#reported = signature;
		const response = await fetch('/api/together/queue', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				applied: this.#applied,
				upcoming: upcoming.map((song, i) => (i < QUEUE_SHOWN ? { songId: song.id, title: song.title, artist: song.artist } : { songId: song.id }))
			})
		}).catch(() => null);
		if (!response?.ok) {
			// Asked again on the next check.
			this.#reported = null;
			return;
		}
		const { added } = (await response.json()) as { added: ({ entry: string; name: string } | null)[] };
		upcoming.forEach((song, i) => {
			const by = added[i] ?? undefined;
			if (song.addedBy?.entry !== by?.entry) song.addedBy = by;
		});
	}

	/** Shows a reaction floating up, and takes it away when it has. */
	float(emoji: string) {
		const key = ++this.#key;
		this.reactions = [...this.reactions.slice(-11), { key, emoji }];
		setTimeout(() => (this.reactions = this.reactions.filter((reaction) => reaction.key !== key)), REACTION_MS);
	}

	#report() {
		const song = player.current;
		const playing = player.engaged;
		const position = player.currentTime;
		const now = Date.now();
		const last = this.#last;
		const expected = last ? last.position + (last.playing ? (now - last.at) / 1000 : 0) : 0;
		const changed =
			!last ||
			last.songId !== (song?.id ?? null) ||
			last.playing !== playing ||
			Math.abs(position - expected) > DRIFT_S ||
			now - last.at > HEARTBEAT_MS;
		if (!changed) return;
		this.#last = { songId: song?.id ?? null, playing, position, at: now };
		void fetch('/api/together/state', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				state: song
					? {
							songId: song.id,
							title: song.title,
							artist: song.artist,
							album: song.album,
							coverArt: song.coverArt,
							duration: player.duration || song.duration,
							position,
							playing
						}
					: null
			})
		}).then((response) => {
			// The party ended elsewhere, or with the session.
			if (response.status === 404) this.#detach();
		}, () => undefined);
	}
}

export const together = new Together();
