/**
 * Hosting a listen-together session from this browser; `server/together.ts`
 * has how the server keeps it.
 *
 * While a party is open, this browser tells the server what it plays: at once
 * when the track or the play state changes or the position jumps (a seek),
 * and every 15 seconds besides. It also holds the party's event stream, for
 * the count of listeners and their reactions.
 */
import type { PartyView } from '$lib/server/together';
import { player } from './player.svelte';

/** A report that has not moved further than this from where it was is not sent again. */
const DRIFT_S = 1;
const CHECK_MS = 1000;
const HEARTBEAT_MS = 15_000;
/** How long a reaction floats on screen. */
export const REACTION_MS = 2400;

export interface FloatingReaction {
	key: number;
	emoji: string;
}

class Together {
	party = $state<PartyView | null>(null);
	/** Listeners other than this browser. */
	listeners = $state(0);
	reactions = $state<FloatingReaction[]>([]);
	/** Whether the dialog with the link is open. */
	open = $state(false);
	busy = $state(false);
	error = $state<string | null>(null);

	#source: EventSource | null = null;
	#timer: ReturnType<typeof setInterval> | null = null;
	#last: { songId: string | null; playing: boolean; position: number; at: number } | null = null;
	#key = 0;

	/** Picks up a party this browser was already hosting, after a reload. */
	async resume() {
		const response = await fetch('/api/together').catch(() => null);
		const party = response?.ok ? ((await response.json()).party as PartyView | null) : null;
		if (party) this.#attach(party);
	}

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
	}

	/** The link to hand out, with this server's address. */
	get link(): string {
		return this.party ? new URL(this.party.url, location.origin).toString() : '';
	}

	#attach(party: PartyView) {
		this.#detach();
		this.party = party;
		this.listeners = 0;
		const source = new EventSource(`${party.url}/events`);
		this.#source = source;
		// This browser's own stream is one of the count.
		source.addEventListener('listeners', (event) => {
			this.listeners = Math.max(0, JSON.parse((event as MessageEvent).data).count - 1);
		});
		source.addEventListener('reaction', (event) => this.float(JSON.parse((event as MessageEvent).data).emoji));
		source.addEventListener('ended', () => this.#detach());
		this.#last = null;
		this.#report();
		this.#timer = setInterval(() => this.#report(), CHECK_MS);
	}

	#detach() {
		this.#source?.close();
		this.#source = null;
		if (this.#timer) clearInterval(this.#timer);
		this.#timer = null;
		this.party = null;
		this.listeners = 0;
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
