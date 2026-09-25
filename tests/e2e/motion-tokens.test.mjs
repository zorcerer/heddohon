/**
 * Every easing curve in the interface is one of the tokens in `app.css`.
 *
 * Before the tokens the tree had eight curves and fourteen durations, arrived
 * at one component at a time. This fails when a component writes its own
 * `cubic-bezier()`, `linear()` or keyword easing instead of a `--ease-*`
 * token, which is how that happened. Durations are not checked: a few are
 * functional delays (the 150ms before a spinner shows) rather than motion.
 *
 *   npm run test:e2e
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { test } from 'node:test';

const ROOT = resolve(import.meta.dirname, '../..');
const SRC = join(ROOT, 'src');

/** Where the curves are defined, and so allowed to be written out. */
const DEFINITIONS = new Set(['src/lib/styles/app.css', 'src/lib/client/motion.ts']);

/**
 * Loops rather than transitions between states: the spinners, the loading
 * sweep and the now-playing bars run for as long as the state lasts, on
 * whatever curve a loop needs.
 */
const ALLOWED = [/\binfinite\b/];

function files(dir) {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) return files(path);
		return /\.(svelte|css)$/.test(name) ? [path] : [];
	});
}

/** The text with comments blanked out, keeping line numbers. */
function withoutComments(text) {
	return text
		.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
		.replace(/<!--[\s\S]*?-->/g, (block) => block.replace(/[^\n]/g, ' '))
		.replace(/(^|[^:])\/\/.*$/gm, '$1');
}

test('no easing curve is written outside the motion tokens', () => {
	const found = [];
	for (const path of files(SRC)) {
		const name = relative(ROOT, path);
		if (DEFINITIONS.has(name)) continue;
		withoutComments(readFileSync(path, 'utf8'))
			.split('\n')
			.forEach((line, index) => {
				if (!/(transition|animation)[a-z-]*\s*:|^\s+[a-z-]+\s+[\d.]+m?s\b/.test(line) && !/cubic-bezier\(/.test(line)) return;
				if (ALLOWED.some((pattern) => pattern.test(line))) return;
				if (/cubic-bezier\(|linear\(|\b(ease-in-out|ease-in|ease-out|ease)\b(?!-)/.test(line.replace(/var\(--ease-[a-z]+\)/g, ''))) {
					found.push(`${name}:${index + 1}: ${line.trim()}`);
				}
			});
	}
	assert.deepEqual(found, [], 'use a --ease-* token from app.css');
});
