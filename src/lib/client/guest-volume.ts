/**
 * The level a visitor without an account chose, on a shared link and on a
 * listen-together page (#297). Kept in this browser, since there is no
 * account to keep it on, and shared by the two pages. 0 to 1, multiplied by
 * the server's limit (`HEDDOHON_VOLUME_LIMIT`), as the player's volume is.
 */

const KEY = 'heddohon:guest-volume';

/** The kept level, or 1 where there is none or storage cannot be read. */
export function guestVolume(): number {
	try {
		const kept = Number(localStorage.getItem(KEY));
		return localStorage.getItem(KEY) !== null && Number.isFinite(kept) ? Math.min(1, Math.max(0, kept)) : 1;
	} catch {
		return 1;
	}
}

/** Keeps the level. Storage that throws (a private window, a full one) keeps nothing. */
export function keepGuestVolume(level: number): void {
	try {
		localStorage.setItem(KEY, String(Math.min(1, Math.max(0, level))));
	} catch {
		// Played at this level until the page goes; nothing kept.
	}
}

/**
 * Whether a page can set an element's volume. iPhone and iPad ignore it and
 * read it back as 1, so a slider there would move and change nothing; the
 * pages leave it out. The same probe as the player's (`rampsVolume`).
 */
export function volumeSettable(): boolean {
	const probe = document.createElement('audio');
	probe.volume = 0.5;
	return probe.volume === 0.5;
}
