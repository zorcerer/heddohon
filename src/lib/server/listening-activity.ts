/**
 * When audio last went to a listener: the player's stream, a shared link,
 * listen-together and casting. Sound analysis pauses while someone listens
 * (`analysis/queue.ts`), so that measuring the library never takes the
 * processor or the music server from a song being played.
 *
 * In memory, for this process: after a restart nobody has listened yet,
 * which the next stream corrects. The analysis's own reads do not come
 * through here.
 */

let last = 0;

/** Called as each listener's audio request is answered. */
export function noteListening(now = Date.now()): void {
	last = now;
}

/** When audio last went to a listener, in ms since the epoch, or 0. */
export function lastListened(): number {
	return last;
}
