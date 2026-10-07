/**
 * What the other accounts on this server are playing, and the profile this
 * account is shown under; `server/listening.ts` has how the server keeps them.
 *
 * The list arrives as `listeners` events on the stream `remote.svelte.ts`
 * holds open, once when the stream opens and again whenever it changes. A
 * track's position is worked out here from the time of its report.
 */
import type { Listener, ListenersEvent } from '$lib/server/listening';
import type { Song } from '$lib/types';
import { player } from './player.svelte';

/** The side of the square picture sent to the server, in pixels. Shown at 28 to 72 CSS pixels. */
const AVATAR_PX = 256;
/** `MAX_AVATAR_BYTES` on the server. */
const MAX_AVATAR_BYTES = 96 * 1024;

/** Where a profile's picture is served from, or null without one. */
export function avatarUrl(id: string | null, version: number | null): string | null {
	return id && version ? `/api/profile/avatar/${id}?v=${version}` : null;
}

/**
 * A chosen image as a square JPEG: the middle of it, scaled to `AVATAR_PX`.
 *
 * Drawn from the file's own bitmap, since the page's policy allows no `blob:`
 * address to load it from. Drawing it again also leaves behind whatever the
 * file carried besides its pixels, a phone's location among it.
 */
async function squareJpeg(file: Blob): Promise<Blob | null> {
	const bitmap = await createImageBitmap(file).catch(() => null);
	if (!bitmap) return null;
	const canvas = document.createElement('canvas');
	canvas.width = canvas.height = AVATAR_PX;
	const context = canvas.getContext('2d');
	if (!context) return null;
	// JPEG has no transparency, and a canvas turns what is clear to black.
	context.fillStyle = '#d9d9d9';
	context.fillRect(0, 0, AVATAR_PX, AVATAR_PX);
	context.imageSmoothingQuality = 'high';
	const side = Math.min(bitmap.width, bitmap.height);
	context.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, AVATAR_PX, AVATAR_PX);
	bitmap.close();
	// The second quality is for a picture too detailed for the cap at the first.
	for (const quality of [0.85, 0.6]) {
		const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
		if (blob && blob.size <= MAX_AVATAR_BYTES) return blob;
	}
	return null;
}

class Listeners {
	/** The other accounts playing something now, in the order they started. */
	others = $state<Listener[]>([]);
	/** This account's profile. Null until the stream or a save has said. */
	you = $state<ListenersEvent['you'] | null>(null);
	/** Whether the popup is open. */
	open = $state(false);
	/** Why the last save or the last press on play did nothing; shown where it was asked. */
	error = $state<string | null>(null);

	/** This clock minus the server's, from the last list. */
	#skew = 0;

	take(event: ListenersEvent) {
		this.#skew = Date.now() - event.now;
		this.others = event.listeners;
		this.you = event.you;
	}

	/** The stream has closed. The list is sent again when it reopens. */
	clear() {
		this.others = [];
	}

	/** Where a listener's track has got to by `now` (this browser's clock). */
	positionOf(listener: Listener, now: number): number {
		const elapsed = Math.max(0, now - this.#skew - listener.at) / 1000;
		return Math.min(listener.position + elapsed, listener.duration || Infinity);
	}

	/** Saves the display name, whether this account is shown, or both. False when refused. */
	async save(patch: { name?: string | null; shown?: boolean }): Promise<boolean> {
		return this.#write('/api/profile', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) });
	}

	/** Sets the picture from a file the listener chose. */
	async setPicture(file: Blob): Promise<boolean> {
		this.error = null;
		const jpeg = await squareJpeg(file);
		if (!jpeg) {
			this.error = 'That file could not be read as a picture.';
			return false;
		}
		return this.#write('/api/profile/avatar', { method: 'PUT', headers: { 'content-type': 'image/jpeg' }, body: jpeg });
	}

	async removePicture(): Promise<boolean> {
		return this.#write('/api/profile/avatar', { method: 'DELETE' });
	}

	async #write(url: string, init: RequestInit): Promise<boolean> {
		this.error = null;
		const response = await fetch(url, init).catch(() => null);
		const body = (await response?.json().catch(() => null)) as
			| (Partial<ListenersEvent['you']> & { message?: string })
			| null;
		if (!response?.ok || !body) {
			this.error = body?.message ?? 'That could not be saved. Try again.';
			return false;
		}
		// The stream says the same a moment later, where there is one.
		this.you = {
			id: body.id ?? this.you?.id ?? null,
			name: 'name' in body ? (body.name ?? null) : (this.you?.name ?? null),
			shown: body.shown ?? this.you?.shown ?? false,
			avatar: body.avatar ?? null
		};
		return true;
	}

	/**
	 * Plays here what a listener is playing, in place of the queue or at the end
	 * of it. The track is read with this account's own credential, so one it may
	 * not read does not play.
	 */
	async tune(listener: Listener, how: 'play' | 'queue'): Promise<boolean> {
		this.error = null;
		const response = await fetch('/api/songs', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ ids: [listener.songId] })
		}).catch(() => null);
		const songs = ((await response?.json().catch(() => null))?.songs ?? []) as Song[];
		if (songs.length === 0) {
			this.error = `“${listener.title}” is not in the library you can play from.`;
			return false;
		}
		if (how === 'queue') player.addToQueue(songs);
		else await player.playNow(songs);
		return true;
	}
}

export const listeners = new Listeners();
