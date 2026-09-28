/**
 * A username with its ASCII letters lower-cased and everything else left as
 * it is: the comparison Navidrome makes (SQLite NOCASE).
 *
 * `toLowerCase()` folds far more. It maps the Kelvin sign (U+212A) to `k` and
 * a dotted capital I (U+0130) to `i`, so `Kate` spelled with a Kelvin sign
 * and `kate` compared equal here while the music server holds them as two
 * users, and the second to sign in took over the first one's account row.
 */
export function foldName(name: string): string {
	return name.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}
