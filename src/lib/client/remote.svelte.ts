/**
 * The account's other browsers, and playback on them; `server/remote.ts` has
 * how the server keeps them.
 *
 * This browser holds one `EventSource` open while signed in. It is told its
 * own id, the list of every browser with the player open (itself left out of
 * `peers` here), and the commands the others send it. What it plays is
 * reported when the track, the play state or the volume changes, and every 5
 * seconds while it plays, so a controlling browser shows a moving position.
 */
import type { RemoteApp, RemoteCommand, RemotePeer, RemoteState } from '$lib/server/remote';
import type { ListenersEvent } from '$lib/server/listening';
import type { Song } from '$lib/types';
import { listeners } from './listeners.svelte';
import { player } from './player.svelte';

/** How often a playing browser reports its position. */
const PROGRESS_MS = 5_000;
/** How long a change waits for the next before it is reported. */
const REPORT_SETTLE_MS = 250;

class Remote {
	/** This browser's id, once the stream has said it. */
	self = $state<string | null>(null);
	/** The account's other browsers with the player open, the most recent first. */
	peers = $state<RemotePeer[]>([]);
	/**
	 * The account's other apps that are playing or paused, as the Navidrome
	 * plugin reports them, the most recently heard first. Empty without it.
	 */
	apps = $state<RemoteApp[]>([]);
	/** Whether the devices dialog is open. */
	open = $state(false);
	/** Set when a command could not be delivered; shown in the dialog. */
	error = $state<string | null>(null);

	#source: EventSource | null = null;
	#lastReport = '';
	#progress: ReturnType<typeof setInterval> | null = null;
	#pending: ReturnType<typeof setTimeout> | null = null;
	/** This clock minus the server's, from the last list. */
	#skew = 0;

	/** Where a peer has got to by `now` (this browser's clock), from its last report. */
	positionOf(state: RemoteState, now: number): number {
		const elapsed = state.playing ? Math.max(0, now - this.#skew - state.at) / 1000 : 0;
		return Math.min(state.position + elapsed, state.duration || Infinity);
	}

	start() {
		if (this.#source || typeof EventSource === 'undefined') return;
		const source = new EventSource('/api/remote/events');
		this.#source = source;
		source.addEventListener('hello', (event) => {
			this.self = JSON.parse((event as MessageEvent).data).id;
			// A new stream is a new peer on the server, which knows nothing of what
			// this browser plays until told.
			this.#lastReport = '';
			this.report();
		});
		source.addEventListener('peers', (event) => {
			const { now, peers, apps } = JSON.parse((event as MessageEvent).data) as {
				now: number;
				peers: RemotePeer[];
				apps?: RemoteApp[];
			};
			this.#skew = Date.now() - now;
			this.peers = peers.filter((peer) => peer.id !== this.self).sort((a, b) => b.since - a.since);
			this.apps = apps ?? [];
		});
		// What the other accounts are playing; see `listeners.svelte.ts`.
		source.addEventListener('listeners', (event) => {
			listeners.take(JSON.parse((event as MessageEvent).data) as ListenersEvent);
		});
		source.addEventListener('command', (event) => {
			void this.#apply(JSON.parse((event as MessageEvent).data) as RemoteCommand);
		});
		// The browser reconnects by itself and the server gives it a new id, so
		// the list is empty until then.
		source.addEventListener('error', () => {
			this.self = null;
			this.peers = [];
			this.apps = [];
			listeners.clear();
		});
		this.#progress = setInterval(() => {
			if (player.playing) this.report(true);
		}, PROGRESS_MS);
	}

	stop() {
		this.#source?.close();
		this.#source = null;
		if (this.#progress) clearInterval(this.#progress);
		this.#progress = null;
		if (this.#pending) clearTimeout(this.#pending);
		this.#pending = null;
		this.self = null;
		this.peers = [];
		this.apps = [];
		this.open = false;
		listeners.clear();
		// Signed out: the next account in this tab has a profile of its own.
		listeners.you = null;
		listeners.open = false;
	}

	/**
	 * Tells the other browsers what this one plays. Sent only when it changed,
	 * unless `progress` asks for the position anyway.
	 */
	report(progress = false) {
		// A volume drag changes the level every frame. One report after it
		// settles says the same.
		if (this.#pending) clearTimeout(this.#pending);
		this.#pending = setTimeout(() => this.#send(progress), progress ? 0 : REPORT_SETTLE_MS);
	}

	#send(progress: boolean) {
		this.#pending = null;
		const self = this.self;
		if (!self) return;
		const song = player.current;
		const state: Omit<RemoteState, 'at'> | null = song
			? {
					songId: song.id,
					title: song.title,
					artist: song.artist,
					coverArt: song.coverArt,
					album: song.album,
					albumId: song.albumId,
					position: player.currentTime,
					duration: player.duration || song.duration,
					playing: player.engaged,
					volume: player.volume
				}
			: null;
		// Everything but the position, which moves on its own.
		const key = JSON.stringify(state ? { ...state, position: 0 } : null);
		if (!progress && key === this.#lastReport) return;
		this.#lastReport = key;
		void fetch('/api/remote/state', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ peer: self, state })
		}).catch(() => undefined);
	}

	/** Sends a command to another browser. False when it did not arrive. */
	async send(to: string, command: RemoteCommand): Promise<boolean> {
		this.error = null;
		const response = await fetch('/api/remote', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ to, command })
		}).catch(() => null);
		if (!response?.ok) {
			this.error = 'That browser could not be reached. It may have closed.';
			return false;
		}
		return true;
	}

	/** Moves this browser's queue and position to another, and pauses here. */
	async playOn(to: string): Promise<void> {
		const command = this.#transfer();
		if (!command) return;
		if (await this.send(to, command)) player.pause();
	}

	/** Asks another browser for its queue and position, which then play here. */
	async playHere(from: string): Promise<void> {
		if (this.self) await this.send(from, { type: 'handoff', to: this.self });
	}

	/**
	 * Plays here the track another app is on, from where that app has got to,
	 * in place of the queue. The app is not told: Navidrome has no way to pause
	 * a client, so it goes on playing until it is stopped by hand.
	 */
	async pickUp(app: RemoteApp): Promise<void> {
		this.error = null;
		await this.#apply({
			type: 'transfer',
			ids: [app.state.songId],
			index: 0,
			position: this.positionOf(app.state, Date.now()),
			playing: true
		});
		if (player.current?.id !== app.state.songId) this.error = `“${app.state.title}” could not be opened here.`;
	}

	#transfer(): RemoteCommand | null {
		if (player.queue.length === 0) return null;
		// The saved queue's cap: a longer queue sends the thousand from the
		// current track on.
		const start = player.queue.length > 1000 ? player.index : 0;
		return {
			type: 'transfer',
			ids: player.queue.slice(start, start + 1000).map((song) => song.id),
			index: player.index - start,
			position: player.currentTime,
			playing: true
		};
	}

	async #apply(command: RemoteCommand) {
		switch (command.type) {
			case 'toggle':
				return player.toggle();
			case 'play':
				return player.engaged ? undefined : player.play();
			case 'pause':
				return player.pause();
			case 'next':
				return player.next();
			case 'previous':
				return player.previous();
			case 'seek':
				return player.seek(command.position);
			case 'volume':
				return player.setVolume(command.volume);
			case 'handoff': {
				const transfer = this.#transfer();
				if (transfer && (await this.send(command.to, transfer))) player.pause();
				return;
			}
			case 'transfer': {
				const response = await fetch('/api/songs', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ ids: command.ids })
				}).catch(() => null);
				const songs = ((await response?.json().catch(() => null))?.songs ?? []) as Song[];
				if (songs.length === 0) return;
				// A track deleted since leaves the list shorter. The current one is
				// found again by its id.
				const found = songs.findIndex((song) => song.id === command.ids[command.index]);
				player.stop();
				await player.restore(songs, {
					index: found >= 0 ? found : Math.min(command.index, songs.length - 1),
					position: found >= 0 ? command.position : 0,
					repeat: player.repeat,
					shuffle: false
				});
				// A browser not clicked since it loaded may refuse to start sound. The
				// player then shows the error, and the queue waits for a press on play.
				if (command.playing) await player.play();
				this.report();
			}
		}
	}
}

export const remote = new Remote();
