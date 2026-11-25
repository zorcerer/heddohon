/**
 * The Discord activity's parts that need nothing of Electron (issue #358):
 * what the page's word is held to, the activity made of it, and the socket
 * client against a Discord of our own, a Unix socket that answers as Discord
 * does. Runs under Node:
 *
 *   node --test test/discord.test.mjs
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

const require = createRequire(import.meta.url);
const { Presence, socketPaths, stateOf, activityOf, coverArtArchive, encode, ICON, HANDSHAKE, FRAME } = require('../discord.js');

/** Splits what was written to the socket into frames. */
function frames(buffer) {
	const found = [];
	while (buffer.length >= 8) {
		const length = buffer.readInt32LE(4);
		found.push({ op: buffer.readInt32LE(0), body: JSON.parse(buffer.subarray(8, 8 + length).toString('utf8')) });
		buffer = buffer.subarray(8 + length);
	}
	return found;
}

/** A Discord on a socket of its own: it answers the handshake with READY and keeps what it is sent. */
async function fakeDiscord(at) {
	const received = [];
	const server = createServer((socket) => {
		let buffered = Buffer.alloc(0);
		socket.on('data', (chunk) => {
			buffered = Buffer.concat([buffered, chunk]);
			for (const frame of frames(buffered)) {
				received.push(frame);
				if (frame.op === HANDSHAKE) socket.write(encode(FRAME, { cmd: 'DISPATCH', evt: 'READY', data: { v: 1 } }));
			}
			buffered = Buffer.alloc(0);
		});
	});
	await new Promise((resolve) => server.listen(at, resolve));
	return { received, close: () => new Promise((resolve) => server.close(resolve)) };
}

const until = async (check, ms = 5000) => {
	const deadline = Date.now() + ms;
	while (!check()) {
		if (Date.now() > deadline) throw new Error('timed out');
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
};

const PLAYING = { title: 'Song 4a', artist: 'Artist 4', album: 'Album 4', albumId: 'al4', duration: 200, position: 50, playing: true };

describe('what the page says plays', () => {
	test('is held to what it can be', () => {
		assert.deepEqual(stateOf(PLAYING), PLAYING);
		assert.equal(stateOf(null), null);
		assert.equal(stateOf('Song'), null);
		assert.equal(stateOf({ ...PLAYING, title: '  ' }), null, 'a song with no title');
		const odd = stateOf({ title: 'x'.repeat(500), artist: 5, album: 'A', albumId: 'y'.repeat(300), duration: -1, position: Number.NaN, playing: 'yes' });
		assert.equal(odd.title.length, 128);
		assert.equal(odd.artist, null);
		// Discord asks for two characters at least.
		assert.equal(odd.album, 'A⠀');
		assert.deepEqual([odd.albumId, odd.duration, odd.position, odd.playing], [null, null, 0, false]);
	});

	test('becomes a Listening activity with its cover, or the icon, and clears when paused', () => {
		const now = 1_000_000;
		const cover = coverArtArchive('de5c6a49-a5ec-41d9-9117-a128898fa099');
		assert.equal(cover, 'https://coverartarchive.org/release/de5c6a49-a5ec-41d9-9117-a128898fa099/front-250');
		assert.deepEqual(activityOf(stateOf(PLAYING), cover, now), {
			type: 2,
			details: 'Song 4a',
			state: 'Artist 4',
			assets: { large_image: cover, large_text: 'Album 4' },
			// 50s in, 200s long.
			timestamps: { start: now - 50_000, end: now + 150_000 }
		});
		assert.equal(activityOf(stateOf(PLAYING), null, now).assets.large_image, ICON);
		assert.equal(activityOf(stateOf({ ...PLAYING, playing: false }), cover, now), null);
		assert.equal(activityOf(null, cover, now), null);
		assert.equal(activityOf(stateOf({ ...PLAYING, duration: null }), cover, now).timestamps, undefined);
	});

	test('is looked for where Discord listens on each system', () => {
		assert.equal(socketPaths('win32', {})[0], '\\\\?\\pipe\\discord-ipc-0');
		const linux = socketPaths('linux', { XDG_RUNTIME_DIR: '/run/user/1000' });
		assert.equal(linux[0], '/run/user/1000/discord-ipc-0');
		assert.ok(linux.includes('/run/user/1000/app/com.discordapp.Discord/discord-ipc-0'), 'Flatpak');
		assert.ok(linux.includes('/run/user/1000/snap.discord/discord-ipc-0'), 'Snap');
	});
});

describe('the socket to Discord', { skip: process.platform === 'win32' ? 'a Unix socket' : false }, () => {
	let dir;
	before(() => {
		dir = mkdtempSync(join(tmpdir(), 'heddohon-discord-'));
	});
	after(() => rmSync(dir, { recursive: true, force: true }));

	test('says who is asking, sets the newest activity, and clears it', async () => {
		const at = join(dir, 'discord-ipc-0');
		const discord = await fakeDiscord(at);
		const presence = new Presence('123456789012345678', [join(dir, 'nothing-here'), at]);
		try {
			const activity = activityOf(stateOf(PLAYING), null);
			// Two at once: only the second is sent.
			presence.set({ ...activity, details: 'An earlier song' });
			presence.set(activity);
			await until(() => discord.received.length >= 2);
			assert.deepEqual(discord.received[0], { op: HANDSHAKE, body: { v: 1, client_id: '123456789012345678' } });
			assert.equal(discord.received[1].body.cmd, 'SET_ACTIVITY');
			assert.deepEqual(discord.received[1].body.args, { pid: process.pid, activity });
			await new Promise((resolve) => setTimeout(resolve, 1300));
			assert.equal(discord.received.length, 2, 'the earlier activity was sent too');

			presence.set(null);
			await until(() => discord.received.length >= 3);
			assert.equal(discord.received[2].body.args.activity, null);

			await presence.stop();
			await until(() => discord.received.length >= 4);
			assert.equal(discord.received[3].body.args.activity, null, 'the activity stayed on quit');
		} finally {
			await presence.stop();
			await discord.close();
		}
	});

	test('does nothing where Discord is not running, and finds it once it is', async () => {
		const at = join(dir, 'discord-ipc-1');
		const presence = new Presence('123456789012345678', [at]);
		const sent = [];
		presence.onSend = (op, body) => sent.push({ op, body });
		try {
			presence.set(activityOf(stateOf(PLAYING), null));
			await new Promise((resolve) => setTimeout(resolve, 1500));
			assert.deepEqual(sent, []);

			const discord = await fakeDiscord(at);
			try {
				presence.set(activityOf(stateOf(PLAYING), null));
				await until(() => discord.received.length >= 2);
				assert.equal(discord.received[1].body.args.activity.details, 'Song 4a');
			} finally {
				await presence.stop();
				await discord.close();
			}
		} finally {
			await presence.stop();
		}
	});

	test('connects to nothing to clear an activity it never showed', async () => {
		const at = join(dir, 'discord-ipc-2');
		const discord = await fakeDiscord(at);
		const presence = new Presence('123456789012345678', [at]);
		try {
			presence.set(null);
			await new Promise((resolve) => setTimeout(resolve, 1500));
			assert.deepEqual(discord.received, []);
		} finally {
			await presence.stop();
			await discord.close();
		}
	});
});
