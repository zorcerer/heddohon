/**
 * The hardening headers every response carries.
 *
 * `harden()` in `hooks.server.ts` sets them on what SvelteKit answers. The
 * build also writes them into a middleware ahead of adapter-node's static file
 * server (`vite.config.ts`), which answers `/_app/*`, `/service-worker.js` and
 * `static/` before any hook runs, as SvelteKit does its trailing-slash
 * redirects. One list for both.
 *
 * HSTS is set unconditionally. Browsers ignore it over plain http.
 *
 * The microphone is allowed for this origin only: Chrome and Edge name the
 * audio outputs only once the page may use it (`client/output.svelte.ts`), and
 * it is asked for only when "List outputs" is pressed. The app's pages admit
 * no frames (`frame-src 'none'`).
 *
 * `x-heddohon` marks a response as Heddohon's own. The service worker and the
 * offline page read it to tell Heddohon's error page (the music server is
 * down) from a reverse proxy's (Heddohon is down). They read `/healthz` for
 * that before, which the operator checklist advises restricting at the proxy:
 * where it was, every 502 became the offline page, which never reloaded.
 */
export const MARKER = 'x-heddohon';

export const SECURITY_HEADERS: Record<string, string> = {
	'x-content-type-options': 'nosniff',
	'referrer-policy': 'same-origin',
	'x-frame-options': 'SAMEORIGIN',
	'strict-transport-security': 'max-age=31536000; includeSubDomains',
	'permissions-policy': 'camera=(), microphone=(self), geolocation=(), payment=()',
	'cross-origin-opener-policy': 'same-origin',
	'cross-origin-resource-policy': 'same-origin',
	[MARKER]: '1'
};

/**
 * The policy for the HTML files in `static/`, which SvelteKit does not render:
 * `offline.html`, with its stylesheet inline and its script from
 * `/offline.js`.
 */
export const STATIC_HTML_CSP =
	"default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; " +
	"font-src 'self'; connect-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'";

/**
 * The policy for HTML SvelteKit answers without one: the error page it builds
 * when an endpoint throws, outside the page renderer that attaches the
 * configured policy. It is fixed text with an inline stylesheet and no script.
 */
export const FALLBACK_HTML_CSP =
	"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";
