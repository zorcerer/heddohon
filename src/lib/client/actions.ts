import { player } from './player.svelte';
import type { Song } from '$lib/types';

type Source = 'album' | 'playlist' | 'artist' | 'genre' | 'starred' | 'random';

async function requestTracks(body: Record<string, unknown>): Promise<{ songs: Song[]; more: boolean }> {
	const response = await fetch('/api/tracks', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body)
	});
	if (!response.ok) return { songs: [], more: false };
	const payload = await response.json().catch(() => null);
	return {
		songs: Array.isArray(payload?.songs) ? payload.songs : [],
		more: payload?.more === true
	};
}

/** Fetches the tracks behind a container so a card's play button works in place. */
export async function fetchTracks(source: Source, id?: string, limit?: number): Promise<Song[]> {
	return (await requestTracks({ source, id, limit })).songs;
}

export async function playContainer(source: Source, id?: string, startAt = 0) {
	if (source === 'artist' && id) return playArtist(id);
	const songs = await fetchTracks(source, id);
	if (songs.length > 0) await player.playNow(songs, startAt);
}

/**
 * Plays an artist's first album as soon as it is known, and queues the rest
 * behind it when they arrive. The rest is dropped if the queue was replaced
 * in the meantime, since the listener has moved on to something else.
 */
async function playArtist(id: string) {
	const first = await requestTracks({ source: 'artist', id, part: 'first' });
	if (first.songs.length === 0) {
		if (first.more) {
			const rest = await fetchTracksPart(id);
			if (rest.length > 0) await player.playNow(rest);
		}
		return;
	}
	await player.playNow(first.songs);
	if (!first.more) return;
	const queue = player.queue;
	const rest = await fetchTracksPart(id);
	if (player.queue === queue) player.addToQueue(rest);
}

async function fetchTracksPart(id: string): Promise<Song[]> {
	return (await requestTracks({ source: 'artist', id, part: 'rest' })).songs;
}

export async function queueContainer(source: Source, id?: string) {
	const songs = await fetchTracks(source, id);
	if (songs.length > 0) player.addToQueue(songs);
}
