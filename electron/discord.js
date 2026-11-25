/**
 * What plays, on the listener's Discord profile ("Listening to ..."), through
 * Discord's Rich Presence on the same computer (issue #358).
 *
 * Discord listens on a local socket, `discord-ipc-0` to `-9`: a named pipe on
 * Windows, a Unix socket in the runtime directory elsewhere (or inside a Flatpak
 * or Snap's own). A message is a frame: its kind and its length, each a 32-bit
 * little-endian number, then that much JSON. The first says who is asking (the
 * application id, made once in Discord's Developer Portal); each one after it
 * sets the activity, or clears it with none.
 *
 * Needs nothing of Electron, so the suite runs it under Node against a socket
 * of its own (`test/discord.test.mjs`).
 */
const net = require('node:net');
const path = require('node:path');

const HANDSHAKE = 0;
const FRAME = 1;
const CLOSE = 2;

/** The cover when there is none on Cover Art Archive: the app's icon, from heddohon.app. */
const ICON = 'https://heddohon.app/assets/apple-touch-icon.png';

/** Discord's own limit on each line of an activity. */
const MAX_TEXT = 128;

/**
 * Between two activities sent: a seek or a run of skips is sent as the last of
 * them. Discord takes five in 20 seconds from one client and drops the rest.
 */
const SETTLE_MS = 1000;

/** Where Discord may be listening, in the order it is tried. */
function socketPaths(platform = process.platform, env = process.env) {
	if (env.HEDDOHON_DESKTOP_DISCORD_SOCKET) return [env.HEDDOHON_DESKTOP_DISCORD_SOCKET];
	const numbers = [...Array(10).keys()];
	if (platform === 'win32') return numbers.map((n) => `\\\\?\\pipe\\discord-ipc-${n}`);
	const base = env.XDG_RUNTIME_DIR || env.TMPDIR || env.TMP || env.TEMP || '/tmp';
	// The desktop client, then Flatpak's and Snap's.
	const dirs = [base, path.join(base, 'app', 'com.discordapp.Discord'), path.join(base, 'snap.discord')];
	return dirs.flatMap((dir) => numbers.map((n) => path.join(dir, `discord-ipc-${n}`)));
}

/** A line of an activity: trimmed to Discord's 128 characters and at least 2, which it asks for. */
function line(value) {
	const text = typeof value === 'string' ? value.trim().slice(0, MAX_TEXT) : '';
	// U+2800, a blank Discord does not trim.
	return text ? text.padEnd(2, '⠀') : null;
}

const finite = (value) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null);

/**
 * What the page sent, held to what it can be: or null, for nothing playing.
 * The page is the server's, but it is a remote one and is not taken at its word.
 */
function stateOf(raw) {
	if (!raw || typeof raw !== 'object') return null;
	const title = line(raw.title);
	if (!title) return null;
	const albumId = typeof raw.albumId === 'string' && raw.albumId.length > 0 && raw.albumId.length < 256 ? raw.albumId : null;
	return {
		title,
		artist: line(raw.artist),
		album: line(raw.album),
		albumId,
		duration: finite(raw.duration),
		position: finite(raw.position) ?? 0,
		playing: raw.playing === true
	};
}

/** A release's front cover on Cover Art Archive, at 250px. */
const coverArtArchive = (release) => `https://coverartarchive.org/release/${release}/front-250`;

/**
 * The activity for a state: a Listening one, the title over the artist, the
 * cover with the album as its caption, and the start and end of the song, from
 * which Discord draws the bar. Null clears it: nothing playing, or paused.
 */
function activityOf(state, cover, now = Date.now()) {
	if (!state || !state.playing) return null;
	const activity = {
		type: 2,
		details: state.title,
		assets: { large_image: cover || ICON }
	};
	if (state.artist) activity.state = state.artist;
	if (state.album) activity.assets.large_text = state.album;
	if (state.duration) {
		const start = now - Math.min(state.position, state.duration) * 1000;
		activity.timestamps = { start: Math.round(start), end: Math.round(start + state.duration * 1000) };
	}
	return activity;
}

/** One frame as it goes on the socket. */
function encode(op, payload) {
	const body = Buffer.from(JSON.stringify(payload), 'utf8');
	const head = Buffer.alloc(8);
	head.writeInt32LE(op, 0);
	head.writeInt32LE(body.length, 4);
	return Buffer.concat([head, body]);
}

/**
 * The connection to Discord, opened when there is something to show and kept.
 * Only the newest activity matters: one asked for while another is on its way
 * replaces it. Discord not running is not an error; the next activity tries
 * again.
 */
class Presence {
	#clientId;
	#paths;
	#socket = null;
	#ready = false;
	#connecting = null;
	#wanted = undefined;
	#timer = null;
	#nonce = 0;
	/** Called with every frame sent, for the suite. */
	onSend = null;

	constructor(clientId, paths = socketPaths()) {
		this.#clientId = clientId;
		this.#paths = paths;
	}

	/** Shows an activity, or clears it with null, a second after the last call. */
	set(activity) {
		this.#wanted = activity;
		clearTimeout(this.#timer);
		this.#timer = setTimeout(() => void this.#flush(), SETTLE_MS);
	}

	/** Clears the activity now and closes the connection, on quit or when switched off. */
	async stop() {
		clearTimeout(this.#timer);
		this.#wanted = undefined;
		if (this.#ready) this.#send(FRAME, this.#command(null));
		const socket = this.#socket;
		this.#socket = null;
		this.#ready = false;
		if (socket) await new Promise((resolve) => socket.end(resolve));
	}

	#command(activity) {
		return { cmd: 'SET_ACTIVITY', args: { pid: process.pid, activity }, nonce: String(++this.#nonce) };
	}

	#send(op, payload) {
		this.onSend?.(op, payload);
		this.#socket?.write(encode(op, payload));
	}

	async #flush() {
		if (this.#wanted === undefined) return;
		// Nothing to clear on a Discord this has not shown anything on.
		if (this.#wanted === null && !this.#ready) return void (this.#wanted = undefined);
		if (!this.#ready && !(await this.#connect())) return;
		const activity = this.#wanted;
		this.#wanted = undefined;
		this.#send(FRAME, this.#command(activity));
	}

	/** Tries each path until Discord answers the handshake. False where none does. */
	#connect() {
		this.#connecting ??= (async () => {
			for (const at of this.#paths) {
				if (await this.#open(at)) return true;
			}
			return false;
		})().finally(() => (this.#connecting = null));
		return this.#connecting;
	}

	#open(at) {
		return new Promise((resolve) => {
			const socket = net.createConnection(at);
			let buffered = Buffer.alloc(0);
			let settled = false;
			const done = (ok) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				if (!ok) socket.destroy();
				resolve(ok);
			};
			// A socket that takes the connection and never answers is not Discord.
			const timer = setTimeout(() => done(false), 3000);
			socket.on('error', () => {
				done(false);
				if (this.#socket === socket) this.#lost();
			});
			socket.on('close', () => {
				done(false);
				if (this.#socket === socket) this.#lost();
			});
			socket.on('connect', () => {
				this.#socket = socket;
				this.#send(HANDSHAKE, { v: 1, client_id: this.#clientId });
			});
			socket.on('data', (chunk) => {
				buffered = Buffer.concat([buffered, chunk]);
				while (buffered.length >= 8) {
					const op = buffered.readInt32LE(0);
					const length = buffered.readInt32LE(4);
					if (buffered.length < 8 + length) break;
					let message = null;
					try {
						message = JSON.parse(buffered.subarray(8, 8 + length).toString('utf8'));
					} catch {
						// Not JSON: left alone.
					}
					buffered = buffered.subarray(8 + length);
					// Discord says READY once the handshake is taken, and closes the
					// socket with a reason when it is not (an unknown application id).
					if (op === FRAME && message?.evt === 'READY') {
						this.#ready = true;
						done(true);
					} else if (op === CLOSE) {
						done(false);
					}
				}
			});
		});
	}

	#lost() {
		this.#socket = null;
		this.#ready = false;
	}
}

module.exports = { Presence, socketPaths, stateOf, activityOf, coverArtArchive, encode, ICON, HANDSHAKE, FRAME, CLOSE };
