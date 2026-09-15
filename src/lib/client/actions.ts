import { player } from './player.svelte';
import type { Song } from '$lib/types';

type Source = 'album' | 'playlist' | 'artist' | 'starred' | 'random';

/** Fetches the tracks behind a container so a card's play button works in place. */
export async function fetchTracks(source: Source, id?: string, limit?: number): Promise<Song[]> {
	const response = await fetch('/api/tracks', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ source, id, limit })
	});
	if (!response.ok) return [];
	const payload = await response.json().catch(() => null);
	return Array.isArray(payload?.songs) ? payload.songs : [];
}

export async function playContainer(source: Source, id?: string, startAt = 0) {
	const songs = await fetchTracks(source, id);
	if (songs.length > 0) await player.playNow(songs, startAt);
}

export async function queueContainer(source: Source, id?: string) {
	const songs = await fetchTracks(source, id);
	if (songs.length > 0) player.addToQueue(songs);
}
