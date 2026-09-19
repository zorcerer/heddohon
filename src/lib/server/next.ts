/**
 * Only allow paths on this origin, so `?next=` cannot become an open redirect.
 *
 * Testing `startsWith('/')` and `!startsWith('//')` is not enough. The URL
 * parser folds a backslash into a path separator for special schemes and strips
 * tab, CR and LF before parsing, so `/\evil.example` and `/<TAB>/evil.example`
 * both pass those two tests and both resolve to `evil.example`. Parsing against
 * a throwaway origin and keeping the result only if it stayed there is the check
 * that cannot be spelled around, since it asks the same parser the browser will.
 *
 * The origin check alone is not enough either. The parser removes dot-segments
 * after the origin is settled, so `/.//evil.example`, `/..//evil.example` and
 * `/%2e//evil.example` all stay on the throwaway origin with a pathname of
 * `//evil.example`. Sent back as a Location, that is protocol-relative and
 * leaves the site. A pathname that starts with two slashes is refused for that
 * reason.
 */
const NEXT_BASE = 'http://heddohon.invalid';

export function safeNext(raw: unknown): string {
	if (typeof raw !== 'string') return '/';
	try {
		const url = new URL(raw, NEXT_BASE);
		if (url.origin !== NEXT_BASE) return '/';
		if (url.pathname.startsWith('//')) return '/';
		return `${url.pathname}${url.search}${url.hash}`;
	} catch {
		return '/';
	}
}
