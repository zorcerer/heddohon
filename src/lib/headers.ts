/**
 * The hardening headers every response carries.
 *
 * `harden()` in `hooks.server.ts` sets them on what SvelteKit answers, and the
 * build writes them into a middleware placed ahead of adapter-node's static
 * file server (`vite.config.ts`), which answers `/_app/*`, `/service-worker.js`
 * and everything in `static/` before any hook runs. Those responses went out
 * without them, and so did the trailing-slash redirects SvelteKit answers
 * before the hooks. One list, so the two cannot drift apart.
 *
 * HSTS is set unconditionally rather than only on https. The app is always
 * behind a TLS-terminating proxy in the deployment it is written for, and the
 * header is ignored by browsers over plain http, so the only thing a condition
 * would add is a way to get it wrong.
 *
 * The microphone for this origin only: Chrome and Edge name the audio outputs
 * only once the page may use it (`client/output.svelte.ts`), and ask for it
 * only when "List outputs" is pressed. A frame from another origin cannot
 * ask, and the app's pages admit no frames at all (`frame-src 'none'`).
 *
 * `x-heddohon` marks a response as Heddohon's own. The service worker and the
 * offline page read it to tell Heddohon's error page (a music server that is
 * down) from a reverse proxy's (Heddohon itself is down). They read
 * `/healthz` for that before, which the operator checklist advises
 * restricting at the proxy, and where it was, every 502 became the offline
 * page and the offline page never reloaded.
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
 * The policy for the HTML files in `static/`, which SvelteKit does not render
 * and so gives no policy of its own. `offline.html` is the one: its own
 * stylesheet inline, its script from `/offline.js`.
 */
export const STATIC_HTML_CSP =
	"default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; " +
	"font-src 'self'; connect-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'";
