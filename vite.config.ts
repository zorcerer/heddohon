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

export default defineConfig({
	css: { lightningcss: { targets } },
	build: { cssMinify: 'lightningcss' },
	plugins: [
		sveltekit({
			compilerOptions: {
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},
			adapter: adapter({ out: 'build' })
		})
	]
});
