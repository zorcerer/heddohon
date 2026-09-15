/**
 * Playlist mutations, and the state behind the "add to playlist" picker.
 *
 * The picker is a single dialog mounted once in the root layout rather than one
 * per track row: a library page can render hundreds of rows, and each carrying
 * its own copy of the playlist list would mean hundreds of identical fetches.
 */
import type { Playlist, Song } from '$lib/types';

export interface AddRequest {
	songIds: string[];
	/** What the user thinks they are adding, for the dialog's heading. */
	label: string;
}

async function send(url: string, method: string, body?: unknown): Promise<unknown> {
	const response = await fetch(url, {
		method,
		headers: body === undefined ? {} : { 'content-type': 'application/json' },
		body: body === undefined ? undefined : JSON.stringify(body)
	});
	if (!response.ok) {
		const payload = (await response.json().catch(() => null)) as { message?: string } | null;
		throw new Error(payload?.message ?? `Request failed (${response.status})`);
	}
	return response.json().catch(() => ({}));
}

export async function fetchPlaylists(): Promise<Playlist[]> {
	const payload = (await send('/api/playlists', 'GET')) as { playlists?: Playlist[] };
	return payload.playlists ?? [];
}

export async function createPlaylist(name: string, songIds: string[] = []): Promise<string> {
	const payload = (await send('/api/playlists', 'POST', { name, songIds })) as { id: string };
	return payload.id;
}

export async function renamePlaylist(id: string, name: string): Promise<void> {
	await send(`/api/playlists/${encodeURIComponent(id)}`, 'PATCH', { name });
}

export async function deletePlaylist(id: string): Promise<void> {
	await send(`/api/playlists/${encodeURIComponent(id)}`, 'DELETE');
}

export async function addTracks(id: string, songIds: string[]): Promise<void> {
	await send(`/api/playlists/${encodeURIComponent(id)}/tracks`, 'POST', { songIds });
}

/** Removes by position; see the API route for why not by song id. */
export async function removeTracks(id: string, indices: number[]): Promise<void> {
	await send(`/api/playlists/${encodeURIComponent(id)}/tracks`, 'DELETE', { indices });
}

class PlaylistPicker {
	request = $state<AddRequest | null>(null);
	playlists = $state<Playlist[]>([]);
	loading = $state(false);
	busy = $state(false);
	error = $state<string | null>(null);
	/** Set briefly after a successful add, for the confirmation line. */
	done = $state<string | null>(null);

	open(songIds: string[], label: string) {
		if (songIds.length === 0) return;
		this.request = { songIds, label };
		this.error = null;
		this.done = null;
		void this.refresh();
	}

	close() {
		this.request = null;
		this.done = null;
		this.error = null;
	}

	async refresh() {
		this.loading = true;
		try {
			this.playlists = await fetchPlaylists();
		} catch (err) {
			this.error = err instanceof Error ? err.message : 'Could not load your playlists';
		} finally {
			this.loading = false;
		}
	}

	async addTo(playlist: Playlist) {
		if (!this.request || this.busy) return;
		this.busy = true;
		this.error = null;
		try {
			await addTracks(playlist.id, this.request.songIds);
			this.done = playlist.name;
		} catch (err) {
			this.error = err instanceof Error ? err.message : 'Could not add to that playlist';
		} finally {
			this.busy = false;
		}
	}

	async createWith(name: string) {
		if (!this.request || this.busy) return;
		this.busy = true;
		this.error = null;
		try {
			await createPlaylist(name, this.request.songIds);
			this.done = name;
			await this.refresh();
		} catch (err) {
			this.error = err instanceof Error ? err.message : 'Could not create that playlist';
		} finally {
			this.busy = false;
		}
	}
}

export const playlistPicker = new PlaylistPicker();

/** Convenience for the common call site: a row, an album, the queue. */
export function addSongsToPlaylist(songs: Song[], label: string) {
	playlistPicker.open(
		songs.map((song) => song.id),
		label
	);
}
