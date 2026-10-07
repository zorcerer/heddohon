/**
 * Only allow paths on this origin, so `?next=` cannot become an open redirect.
 *
 * `startsWith('/')` and `!startsWith('//')` are not enough. The URL parser
 * folds a backslash into a path separator and strips tab, CR and LF, so
 * `/\evil.example` and `/<TAB>/evil.example` pass both and resolve to
 * `evil.example`. The value is parsed against a throwaway origin and kept only
 * if it stayed there, which asks the parser the browser will use.
 *
 * The parser also removes dot-segments after the origin is settled, so
 * `/.//evil.example`, `/..//evil.example` and `/%2e//evil.example` stay on the
 * throwaway origin with a pathname of `//evil.example`, which as a Location is
 * protocol-relative and leaves the site. A pathname that starts with two
 * slashes is refused.
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
