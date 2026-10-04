import { player } from './player.svelte';
import type { MixSeed, Song } from '$lib/types';

type Source = 'album' | 'playlist' | 'artist' | 'genre' | 'folder' | 'starred' | 'random';

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
 * meanwhile.
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

/**
 * Replaces the queue with an instant mix made from a song, an album or an
 * artist, and says whether there was one. Where the music server has none (on
 * Navidrome, without an external agent configured), the queue is left as it
 * was.
 */
export async function playInstantMix(of: MixSeed, id: string): Promise<boolean> {
	const { songs } = await requestTracks({ source: 'mix', of, id });
	if (songs.length === 0) return false;
	await player.playNow(songs);
	return true;
}
