import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import adapter from '@sveltejs/adapter-node';
import type { Adapter } from '@sveltejs/kit';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import { SECURITY_HEADERS, STATIC_HTML_CSP } from './src/lib/headers';

/*
 * adapter-node, with the hardening headers on the files it serves itself.
 *
 * Its server answers `/_app/*`, `/service-worker.js` and everything in
 * `static/` from disk (sirv) before SvelteKit, so before `harden()` in
 * `hooks.server.ts`, and SvelteKit answers a trailing-slash redirect before
 * the hooks too. Those went out without `nosniff`, framing protection or HSTS,
 * and `offline.html` without a policy. The adapter has no option for this, so
 * after it writes `build/index.js` a middleware that sets the same headers is
 * put ahead of its handler. A response SvelteKit renders sets them again from
 * `harden()`, to the same values.
 *
 * The build fails if the entry no longer has the shape this edits.
 */
function hardenedAdapter(): Adapter {
	const base = adapter({ out: 'build' });
	return {
		...base,
		async adapt(builder) {
			await base.adapt(builder);
			const entry = join('build', 'index.js');
			const source = await readFile(entry, 'utf8');
			const hook = '.use(handler)';
			if (source.split(hook).length !== 2) {
				throw new Error(`adapter-node's ${entry} no longer calls ${hook} once; see hardenedAdapter in vite.config.ts`);
			}
			await writeFile(
				join('build', 'security-headers.js'),
				[
					'// Written by hardenedAdapter in vite.config.ts; the values are in src/lib/headers.ts.',
					`const headers = ${JSON.stringify(SECURITY_HEADERS)};`,
					`const htmlPolicy = ${JSON.stringify(STATIC_HTML_CSP)};`,
					'export function securityHeaders(req, res, next) {',
					'\tfor (const name in headers) res.setHeader(name, headers[name]);',
					"\tif (/\\.html?(?:$|\\?)/.test(req.url ?? '')) res.setHeader('content-security-policy', htmlPolicy);",
					'\tnext();',
					'}',
					''
				].join('\n')
			);
			await writeFile(
				entry,
				`import { securityHeaders } from './security-headers.js';\n${source.replace(hook, '.use(securityHeaders, handler)')}`
			);
		}
	};
}

/** Lightning CSS encodes versions as (major << 16) | (minor << 8) | patch. */
const browser = (major: number, minor = 0) => (major << 16) | (minor << 8);

/*
 * The floor is set by features the design system depends on: `color-mix`,
 * registered custom properties (`@property`) and `backdrop-filter`. Declared
 * explicitly, it also stops Lightning CSS assuming an older baseline and
 * emitting only `-webkit-backdrop-filter`, which leaves Firefox without the
 * blur.
 */
const targets = {
	chrome: browser(111),
	edge: browser(111),
	firefox: browser(128),
	safari: browser(16, 4)
};

/*
 * Content-Security-Policy.
 *
 * Configured here and not in `harden()`: SvelteKit puts an inline bootstrap
 * script in every page, and only the framework that emits it can produce the
 * nonce or hash a policy without `unsafe-inline` needs.
 *
 * `default-src 'none'` denies first, and the rest is what the app loads, all
 * from its own origin: bundles, the bundled fonts, covers from `/api/cover`,
 * audio from `/api/stream`, fetches to `/api/*`, and the service worker that
 * serves the offline page (`src/service-worker.ts`). The tree carries no
 * external origin and no `data:` or `blob:` URL.
 *
 * `style-src-attr` is separate. The shell in `app.html` and every component
 * that sizes itself in markup, `Logo` among them, emit a `style` attribute.
 * `unsafe-inline` under `style-src` would not admit them: a directive carrying
 * a nonce or a hash ignores `unsafe-inline`, and the framework adds one to
 * `style-src` for its own inline stylesheets. `style-src-attr` governs
 * attributes when present, and nothing adds a nonce to it. Writing `--art-*`
 * onto the root from `artwork.ts` goes through the CSSOM, which CSP does not
 * govern.
 *
 * `frame-ancestors` is carried by `x-frame-options` in `harden()` as well: it
 * is ignored in a policy delivered by `<meta>`, which is how SvelteKit
 * delivers it for a prerendered page.
 *
 * `upgrade-insecure-requests` is absent: a plain-http deployment is supported
 * (see `HEDDOHON_COOKIE_SECURE`), and upgrading would break it.
 */
export default defineConfig({
	css: { lightningcss: { targets } },
	/*
	 * Nothing is inlined as a `data:` URL. Vite inlines any asset under 4 KB by
	 * default, and the small subsets of both variable fonts came under it as
	 * `data:font/woff2` URLs, which `font-src 'self'` refuses, so they never
	 * loaded.
	 */
	build: { cssMinify: 'lightningcss', assetsInlineLimit: 0 },
	plugins: [
		sveltekit({
			compilerOptions: {
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},
			adapter: hardenedAdapter(),
			// How often an open tab asks whether the server runs a newer build. The
			// root layout takes the update on the next page change made while
			// nothing is playing.
			version: { pollInterval: 300_000 },
			// Written in place, so the keywords are typed against what the plugin
			// accepts. As a named constant they widen to `string[]`.
			csp: {
				directives: {
					'default-src': ['none'],
					'script-src': ['self'],
					'style-src': ['self', 'unsafe-inline'],
					'style-src-attr': ['unsafe-inline'],
					'img-src': ['self'],
					'font-src': ['self'],
					'media-src': ['self'],
					'connect-src': ['self'],
					'manifest-src': ['self'],
					'worker-src': ['self'],
					'object-src': ['none'],
					'frame-src': ['none'],
					'base-uri': ['self'],
					'form-action': ['self'],
					'frame-ancestors': ['self']
				}
			}
		})
	]
});
