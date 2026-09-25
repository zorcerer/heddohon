import adapter from '@sveltejs/adapter-node';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

/** Lightning CSS encodes versions as (major << 16) | (minor << 8) | patch. */
const browser = (major: number, minor = 0) => (major << 16) | (minor << 8);

/*
 * The floor is set by features the design system already depends on: `color-mix`,
 * registered custom properties (`@property`) and `backdrop-filter`. Declaring it
 * explicitly also stops Lightning CSS from assuming an older baseline and
 * emitting only `-webkit-backdrop-filter`, which would leave Firefox with a
 * translucent player bar and no blur behind it.
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
 * This is configured here rather than written in `harden()` alongside the other
 * response headers because SvelteKit puts an inline bootstrap script in every
 * page. A policy without `unsafe-inline` blocks it, and the nonce or hash that
 * would admit it can only be produced by whatever emitted the script. Handing
 * the directives to the framework lets it add that itself.
 *
 * `default-src 'none'` denies first and the rest of the list is what the app
 * actually loads, which is everything from its own origin: bundles, the two
 * bundled font families, covers from `/api/cover`, audio from `/api/stream`,
 * and fetches to `/api/*`. The tree carries no external origin, no `data:` or
 * `blob:` URL and no worker.
 *
 * `style-src-attr` is separate on purpose. The shell in `app.html` and every
 * component that sizes itself in markup, `Logo` among them, emit a `style`
 * attribute, so those have to be admitted. Listing `unsafe-inline` only under
 * `style-src` would not be enough: a directive carrying a nonce or a hash
 * ignores `unsafe-inline` altogether, and the framework adds one to `style-src`
 * for any inline stylesheet of its own. `style-src-attr` takes over attributes
 * when it is present and nothing adds a nonce to it. Writing `--art-*` onto the
 * root from `artwork.ts` is not affected either way, since CSP does not govern
 * changes made through the CSSOM.
 *
 * `frame-ancestors` is carried by `x-frame-options` in `harden()` as well. It
 * is ignored when a policy is delivered in a `<meta>` element, which is how
 * SvelteKit delivers it for a prerendered page.
 *
 * `upgrade-insecure-requests` is deliberately absent. A plain-http deployment is
 * supported (see `HEDDOHON_COOKIE_SECURE`), and upgrading would break it.
 */
export default defineConfig({
	css: { lightningcss: { targets } },
	/*
	 * Nothing inlined as a `data:` URL. Vite inlines any asset under 4 KB by
	 * default, and the small subsets of both variable fonts came under it: the
	 * built CSS carried them as `data:font/woff2` URLs, which `font-src 'self'`
	 * refuses, so those subsets never loaded. Served as files they are `self`.
	 */
	build: { cssMinify: 'lightningcss', assetsInlineLimit: 0 },
	plugins: [
		sveltekit({
			compilerOptions: {
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},
			adapter: adapter({ out: 'build' }),
			// Written in place rather than lifted to a named constant so the
			// keywords are typed against what the plugin accepts. Pulled out, they
			// widen to `string[]` and stop matching the directive types.
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
					'worker-src': ['none'],
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
