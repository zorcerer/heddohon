/**
 * A username with its ASCII letters lower-cased and the rest untouched: the
 * comparison Navidrome makes (SQLite NOCASE).
 *
 * `toLowerCase()` maps the Kelvin sign (U+212A) to `k` and a dotted capital I
 * (U+0130) to `i`. `Kate` with a Kelvin sign and `kate` compared equal here
 * while the music server holds two users, and the second to sign in took over
 * the first one's account row.
 */
export function foldName(name: string): string {
	return name.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}
