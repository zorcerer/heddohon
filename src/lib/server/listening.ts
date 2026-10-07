/**
 * What the accounts on this server are playing, for each other to see, and
 * the profile an account is shown under.
 *
 * An account is shown only after it has chosen to be, under Settings. Its
 * profile row holds that choice, a display name and a picture. Every signed-in
 * account sees the accounts that are shown, whether or not it is shown itself.
 *
 * Nothing new is collected for it. A browser already reports what it plays
 * for the account's own other browsers (`remote.ts`), and holds a stream open
 * for them. This takes the report of an account that is shown and sends it
 * down every stream, as a `listeners` event. Like that registry it is in this
 * process's memory: a restart empties it, and the browsers fill it again as
 * they reconnect.
 *
 * An account is known to the others by its profile's handle, a random value
 * made with the row, and never by its account id.
 */
import { randomBytes } from 'node:crypto';
import type { BackendKind } from '$lib/types';
import type { Account } from './auth';
import { now, store } from './db';
import { playingOn, present, tell, tellEveryone, watch } from './remote';

/** Characters in a display name, counted as a reader would (code points). */
export const MAX_NAME = 32;
/**
 * The picture arrives as a JPEG the browser has already cut square and scaled
 * to 256px (`client/listeners.svelte.ts`), and is kept in the database in
 * base64, a third larger.
 */
export const MAX_AVATAR_BYTES = 96 * 1024;
/**
 * The longest side a picture may declare. The size on the wire does not bound
 * what a browser allocates to decode it: a JPEG of a few kilobytes can declare
 * 65535 pixels a side, and every account that opens the list would decode it.
 */
export const MAX_AVATAR_SIDE = 512;

/** The accounts sent in one list. A server with more listening at once shows the first hundred to have started. */
const MAX_LISTED = 100;
/**
 * How far a report's position may be from where the last one sent puts the
 * track before the list is sent again. Browsers work the position out from the
 * time of the report, so the 5-second progress reports are not passed on, and
 * a seek is.
 */
const SEEK_TOLERANCE_S = 3;
/** The least time between two sendings of the list to everyone; see `publish`. */
const PUBLISH_GAP_MS = 250;

export interface Profile {
	/** What the other accounts know this one by. Null until the profile is first saved. */
	handle: string | null;
	/** The name the account chose, or null to go by its user name. */
	name: string | null;
	/** Whether what the account plays is shown to the others. */
	shown: boolean;
	/** Epoch millis the picture was set, which is its version in its address. Null without one. */
	avatarAt: number | null;
}

/** One account and what it is playing, as every other account is sent it. */
export interface Listener {
	/** The profile's handle. */
	id: string;
	name: string;
	/** The picture's version, for its address, or null. */
	avatar: number | null;
	/**
	 * Which kind of music server the track is on. Its ids mean something only to
	 * an account on the same one, so a browser on the other shows the title
	 * without the cover, the album link or the play button.
	 */
	backend: BackendKind;
	songId: string;
	title: string;
	artist: string | null;
	album: string | null;
	albumId: string | null;
	coverArt: string | null;
	/** Seconds, as of `at`. */
	position: number;
	duration: number;
	/** Epoch millis of the report, on this server's clock. */
	at: number;
}

/** The `listeners` event: the list, and the profile of the account it is sent to. */
export interface ListenersEvent {
	/** This server's clock, so a browser can tell how long ago `at` was. */
	now: number;
	you: { id: string | null; name: string | null; shown: boolean; avatar: number | null };
	listeners: Listener[];
}

const NO_PROFILE: Profile = { handle: null, name: null, shown: false, avatarAt: null };

interface ProfileRow {
	handle: string;
	name: string | null;
	shown: number;
	avatar_at: number | null;
}

export async function getProfile(accountId: string): Promise<Profile> {
	const row = await (await store()).get<ProfileRow>(
		'SELECT handle, name, shown, avatar_at FROM profiles WHERE account_id = ?',
		accountId
	);
	if (!row) return { ...NO_PROFILE };
	return {
		handle: row.handle,
		name: row.name,
		shown: Number(row.shown) === 1,
		avatarAt: row.avatar_at === null ? null : Number(row.avatar_at)
	};
}

/**
 * A display name from a request: a string of at most `MAX_NAME` characters
 * with its white space collapsed, or null for none. Undefined when the value
 * is neither a string nor null.
 *
 * Control characters go, and with them the marks that set the direction of
 * the text after them: U+202E in a name reverses the title shown beside it.
 */
export function cleanName(value: unknown): string | null | undefined {
	if (value === null) return null;
	if (typeof value !== 'string') return undefined;
	const text = value
		.normalize('NFC')
		.replace(/[\p{Cc}\p{Cs}\p{Co}؜‎‏‪-‮⁦-⁩]/gu, ' ')
		.replace(/\s+/g, ' ')
		.trim();
	return Array.from(text).slice(0, MAX_NAME).join('').trim() || null;
}

/**
 * Saves the name and whether the account is shown. `name_taken` when the name
 * is another account's user name, which is what an account without a display
 * name goes by.
 */
export async function saveProfile(
	account: Account,
	patch: { name?: string | null; shown?: boolean }
): Promise<Profile | 'name_taken'> {
	const database = await store();
	const current = await getProfile(account.id);
	const name = patch.name === undefined ? current.name : patch.name;
	const shown = patch.shown ?? current.shown;

	if (name !== null && name !== current.name) {
		// Compared as the engine folds case. It keeps one account from going by
		// another's name in the list, and decides nothing about who may sign in.
		const taken = await database.get<{ id: string }>(
			'SELECT id FROM accounts WHERE id <> ? AND lower(username) = lower(?) LIMIT 1',
			account.id,
			name
		);
		if (taken) return 'name_taken';
	}

	// A handle is made with every write and kept only by the one that makes the row.
	await database.run(
		`INSERT INTO profiles (account_id, handle, name, shown, avatar, avatar_at, updated_at) VALUES (?, ?, ?, ?, NULL, NULL, ?)
		 ON CONFLICT(account_id) DO UPDATE SET name = excluded.name, shown = excluded.shown, updated_at = excluded.updated_at`,
		account.id,
		randomBytes(12).toString('hex'),
		name,
		shown ? 1 : 0,
		now()
	);
	return changed(account);
}

/** Sets the account's picture, or removes it with null. The bytes have been through `jpegSize`. */
export async function setAvatar(account: Account, jpeg: Uint8Array | null): Promise<Profile> {
	const at = now();
	await (await store()).run(
		`INSERT INTO profiles (account_id, handle, name, shown, avatar, avatar_at, updated_at) VALUES (?, ?, NULL, 0, ?, ?, ?)
		 ON CONFLICT(account_id) DO UPDATE SET avatar = excluded.avatar, avatar_at = excluded.avatar_at, updated_at = excluded.updated_at`,
		account.id,
		randomBytes(12).toString('hex'),
		jpeg ? Buffer.from(jpeg).toString('base64') : null,
		jpeg ? at : null,
		at
	);
	return changed(account);
}

/** The picture of the profile with this handle, or null. */
export async function readAvatar(handle: string): Promise<Buffer | null> {
	const row = await (await store()).get<{ avatar: string | null }>(
		'SELECT avatar FROM profiles WHERE handle = ?',
		handle
	);
	return row?.avatar ? Buffer.from(row.avatar, 'base64') : null;
}

/**
 * Removes an account's profile, when its row passes to a different upstream
 * user (see `storeAccount` in auth.ts). Its sessions have ended by then, so
 * it is in no list.
 */
export async function clearProfile(accountId: string): Promise<void> {
	await (await store()).run('DELETE FROM profiles WHERE account_id = ?', accountId);
	known.delete(accountId);
}

/**
 * The width and height a JPEG declares, or null for anything that is not one.
 *
 * Only the markers up to the frame header are read. The picture is never
 * decoded here: it is served as `image/jpeg` whatever its bytes are, under a
 * policy that keeps it from being a document.
 */
export function jpegSize(bytes: Uint8Array): { width: number; height: number } | null {
	if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
	let at = 2;
	while (at + 3 < bytes.length) {
		if (bytes[at] !== 0xff) return null;
		const marker = bytes[at + 1];
		// A marker may be padded with any number of 0xFF before it.
		if (marker === 0xff) {
			at++;
			continue;
		}
		// The scan, or the end: the frame header comes before both.
		if (marker === 0xda || marker === 0xd9) return null;
		// Markers that stand alone, with no length after them.
		if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
			at += 2;
			continue;
		}
		const length = (bytes[at + 2] << 8) | bytes[at + 3];
		if (length < 2) return null;
		// A frame header: SOF0 to SOF15, less the three in that range that are
		// tables (DHT, JPG and DAC).
		if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
			if (length < 7 || at + 8 >= bytes.length) return null;
			const height = (bytes[at + 5] << 8) | bytes[at + 6];
			const width = (bytes[at + 7] << 8) | bytes[at + 8];
			return width > 0 && height > 0 ? { width, height } : null;
		}
		at += 2 + length;
	}
	return null;
}

/* ── Who is listening ─────────────────────────────────────────────────────── */

/**
 * The profile of each account with a stream open, read once as its first
 * stream opens and replaced as it is saved, so a report costs no query.
 */
const known = new Map<string, { account: Account; profile: Profile }>();

/** What each account that is shown and playing was last sent as, in the order they started. */
const playing = new Map<string, { peer: string; key: string; listener: Listener }>();

/** After a write: the saved profile, held if the account is connected, and the list sent again. */
async function changed(account: Account): Promise<Profile> {
	const profile = await getProfile(account.id);
	if (present(account.id)) known.set(account.id, { account, profile });
	refresh(account.id);
	// Whether or not the list changed: the account's own browsers show its profile.
	publish();
	return profile;
}

/**
 * Brings what the account is shown as playing up to date with its browsers'
 * reports. True when the list the others hold is no longer right.
 */
function refresh(accountId: string): boolean {
	const held = known.get(accountId);
	const before = playing.get(accountId);
	const handle = held?.profile.handle;

	const reports = held?.profile.shown && handle ? playingOn(accountId) : [];
	// Two browsers of one account playing at once: the one already shown stays,
	// so the list does not flip between them with each one's progress report.
	const chosen =
		reports.find((report) => report.peer === before?.peer) ??
		reports.reduce<(typeof reports)[number] | null>(
			(latest, report) => (latest && latest.state.at >= report.state.at ? latest : report),
			null
		);

	if (!held || !handle || !chosen) return playing.delete(accountId);

	const { state } = chosen;
	const listener: Listener = {
		id: handle,
		name: held.profile.name ?? held.account.username,
		avatar: held.profile.avatarAt,
		backend: held.account.backend,
		songId: state.songId,
		title: state.title,
		artist: state.artist,
		album: state.album,
		albumId: state.albumId,
		coverArt: state.coverArt,
		position: state.position,
		duration: state.duration,
		at: state.at
	};
	// Everything but where the track has got to, which moves on its own.
	const key = JSON.stringify({ ...listener, position: 0, at: 0 });
	if (before && before.key === key) {
		const expected = before.listener.position + (state.at - before.listener.at) / 1000;
		if (Math.abs(expected - state.position) <= SEEK_TOLERANCE_S) return false;
	}
	playing.set(accountId, { peer: chosen.peer, key, listener });
	return true;
}

function eventFor(accountId: string): ListenersEvent {
	const profile = known.get(accountId)?.profile ?? NO_PROFILE;
	const listeners: Listener[] = [];
	for (const [id, entry] of playing) {
		if (id === accountId) continue;
		if (listeners.push(entry.listener) >= MAX_LISTED) break;
	}
	return {
		now: Date.now(),
		you: { id: profile.handle, name: profile.name, shown: profile.shown, avatar: profile.avatarAt },
		listeners
	};
}

let publishHeld: ReturnType<typeof setTimeout> | null = null;
let publishAgain = false;

/**
 * Sends every browser the list. At once, and then not again for
 * `PUBLISH_GAP_MS`, with one more at the end of that if anything changed in
 * it: one account's writes reach every other account's browsers, and this is
 * what bounds how often.
 */
function publish(): void {
	if (publishHeld) {
		publishAgain = true;
		return;
	}
	tellEveryone('listeners', eventFor);
	publishHeld = setTimeout(() => {
		publishHeld = null;
		if (!publishAgain) return;
		publishAgain = false;
		publish();
	}, PUBLISH_GAP_MS);
	// Not a reason to keep the process from exiting.
	publishHeld.unref();
}

/**
 * A browser's stream has opened: its account's profile is read if this is the
 * account's first, and the browser is sent the list as it stands.
 */
export async function arrived(account: Account, peer: string): Promise<void> {
	if (!known.has(account.id)) {
		const profile = await getProfile(account.id);
		// The stream may have closed while that was read, and a save in the
		// meantime has put a newer profile here than the one read.
		if (!present(account.id)) return;
		if (!known.has(account.id)) known.set(account.id, { account, profile });
	}
	tell(account.id, peer, 'listeners', eventFor(account.id));
}

watch((accountId) => {
	if (!present(accountId)) known.delete(accountId);
	if (refresh(accountId)) publish();
});
