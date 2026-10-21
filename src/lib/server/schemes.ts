/**
 * Colour schemes for Terminal from files: the first part of a theme engine
 * (#182). An administrator puts a JSON file of colours in `themes/` in the data
 * directory, and it is offered under Settings beside the nine built-in
 * schemes, by its file name.
 *
 * A file is data, never a stylesheet: every value is a `#rrggbb` colour, so
 * nothing in it can load an address or reach past the custom properties it
 * sets, and the Content-Security-Policy needs nothing new. The stylesheet is
 * written here from the checked values, and goes into the page's head
 * (`hooks.server.ts`) so the first paint is in it, as the built-in schemes
 * are.
 *
 * Only a few colours are needed; the rest are made the way the built-in
 * schemes were made (see the head of `terminal-schemes.css`): the pane a third
 * of the way from the ground to the step above it, the muted and faint tones
 * taken toward the pane until they hold their contrast, an accent lightened
 * until it holds 5:1 under its dark label, and so on. A file whose text cannot
 * be read on its pane is refused, and so is a light ground: Terminal is drawn
 * light on dark.
 *
 * Read once, as the server starts. A file added later is offered after a
 * restart; one that is refused is named in the log with the reason.
 *
 * The format, version 1 (any key but the first four may be left out):
 *
 * ```json
 * {
 *   "heddohon": 1,
 *   "name": "Rosé Pine",
 *   "ground": "#191724",
 *   "raised": "#26233a",
 *   "foreground": "#e0def4",
 *   "text": "#cfcce4",
 *   "accents": { "green": "#9ccfd8", "amber": "#f6c177", "cyan": "#9ccfd8",
 *                "violet": "#c4a7e7", "rose": "#ebbcba", "white": "#e0def4" },
 *   "positive": "#9ccfd8",
 *   "danger": "#eb6f92"
 * }
 * ```
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config';
import { log, reason } from './log';

export const SCHEME_VERSION = 1;

/** The built-in schemes' names, which a file may not take (`SCHEMES` in `settings.ts`). */
const RESERVED = new Set([
	'heddohon',
	'nord',
	'dracula',
	'gruvbox',
	'catppuccin',
	'tokyo-night',
	'solarized',
	'one-dark',
	'monokai',
	'everforest'
]);

/** The fixed accents a scheme gives its own colour for (`ACCENTS` in `settings.ts`, less `artwork`). */
const ACCENT_NAMES = ['green', 'amber', 'cyan', 'violet', 'rose', 'white'] as const;

/** A file's name, less `.json`: written into the page's root as `data-scheme`. */
const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const HEX = /^#[0-9a-f]{6}$/i;

export interface CustomScheme {
	id: string;
	name: string;
	/** `--bg-base`, for `theme-color`. */
	ground: string;
	/** The custom properties it sets, under Terminal and for each fixed accent. */
	css: string;
}

// ── Colour ─────────────────────────────────────────────────────────────────

type Rgb = [number, number, number];

function rgb(hex: string): Rgb {
	const n = Number.parseInt(hex.slice(1), 16);
	return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function hex([r, g, b]: Rgb): string {
	return `#${[r, g, b].map((part) => Math.round(part).toString(16).padStart(2, '0')).join('')}`;
}

/** `a` taken `amount` (0…1) of the way to `b`. */
function mix(a: string, b: string, amount: number): string {
	const [x, y] = [rgb(a), rgb(b)];
	return hex([0, 1, 2].map((i) => x[i] + (y[i] - x[i]) * amount) as Rgb);
}

function luminance(colour: string): number {
	const linear = (part: number) => {
		const c = part / 255;
		return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
	};
	const [r, g, b] = rgb(colour).map(linear);
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: string, b: string): number {
	const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m);
	return (x + 0.05) / (y + 0.05);
}

/** `colour` taken toward `toward` in small steps for as long as it holds `ratio` on `ground`. */
function fadeUntil(colour: string, toward: string, ground: string, ratio: number): string {
	let last = colour;
	for (let step = 1; step <= 100; step++) {
		const next = mix(colour, toward, step / 100);
		if (contrast(next, ground) < ratio) break;
		last = next;
	}
	return last;
}

/** `colour` lightened toward white until it holds `ratio` against `other`, or as near as white gets. */
function lightenUntil(colour: string, other: string, ratio: number): string {
	for (let step = 0; step <= 100; step++) {
		const next = mix(colour, '#ffffff', step / 100);
		if (contrast(next, other) >= ratio) return next;
	}
	return '#ffffff';
}

function hue(colour: string): number {
	const [r, g, b] = rgb(colour).map((part) => part / 255);
	const max = Math.max(r, g, b);
	const d = max - Math.min(r, g, b);
	if (d === 0) return 0;
	const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
	return Math.round((h * 60 + 360) % 360);
}

// ── Files ──────────────────────────────────────────────────────────────────

class Refused extends Error {}

function colourAt(raw: Record<string, unknown>, key: string, fallback?: string): string {
	const value = raw[key];
	if (value === undefined && fallback !== undefined) return fallback;
	if (typeof value !== 'string' || !HEX.test(value)) throw new Refused(`"${key}" is not a colour written #rrggbb`);
	return value.toLowerCase();
}

/** The scheme a file describes, or the reason it cannot be one. Exported for the tests' sake as much as the loader's. */
export function readScheme(id: string, input: unknown): CustomScheme {
	if (!ID.test(id)) throw new Refused('the file name is not lower-case letters, digits and hyphens, up to 40');
	if (RESERVED.has(id)) throw new Refused('a built-in scheme has that name');
	if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Refused('it is not a JSON object');
	const raw = input as Record<string, unknown>;
	if (raw.heddohon !== SCHEME_VERSION) throw new Refused(`"heddohon" is not ${SCHEME_VERSION}, the version this server reads`);
	const name = typeof raw.name === 'string' ? raw.name.trim() : '';
	if (!name || name.length > 40) throw new Refused('"name" is missing or longer than 40 characters');

	const ground = colourAt(raw, 'ground');
	if (luminance(ground) > 0.06) throw new Refused('"ground" is too light: Terminal is drawn light on dark');
	const raised = colourAt(raw, 'raised');
	const foreground = colourAt(raw, 'foreground');
	const pane = mix(ground, raised, 1 / 3);
	if (contrast(foreground, pane) < 7) {
		throw new Refused(`"foreground" holds ${contrast(foreground, pane).toFixed(1)}:1 on the pane, under 7:1`);
	}
	const sunken = colourAt(raw, 'sunken', mix(ground, '#000000', 0.16));
	const hover = colourAt(raw, 'hover', mix(raised, foreground, 0.07));
	const active = colourAt(raw, 'active', mix(raised, foreground, 0.12));
	const text = colourAt(raw, 'text', fadeUntil(foreground, pane, pane, Math.max(7, contrast(foreground, pane) * 0.85)));
	const faint = fadeUntil(text, pane, pane, 4.6);
	const muted = fadeUntil(text, pane, pane, Math.max(5.3, 4.6 + 0.3 * (contrast(text, pane) - 4.6)));
	if (contrast(text, pane) < 4.6) throw new Refused(`"text" holds ${contrast(text, pane).toFixed(1)}:1 on the pane, under 4.6:1`);
	const positive = lightenUntil(colourAt(raw, 'positive', '#7fd48a'), pane, 4.5);
	const danger = lightenUntil(colourAt(raw, 'danger', '#e06c75'), pane, 4.5);

	const given = (typeof raw.accents === 'object' && raw.accents !== null ? raw.accents : {}) as Record<string, unknown>;
	const fallbackAccent: Record<(typeof ACCENT_NAMES)[number], string> = {
		green: positive,
		amber: '#e5c07b',
		cyan: '#56b6c2',
		violet: '#c678dd',
		rose: danger,
		white: foreground
	};
	const accents = ACCENT_NAMES.map((accent) => {
		const published = colourAt(given, accent, fallbackAccent[accent]);
		// Under the dark label of a filled key, the playing row and the primary button.
		const shown = lightenUntil(published, sunken, 5);
		return `:root[data-theme='terminal'][data-scheme='${id}'][data-accent='${accent}'] {
	--accent: ${shown};
	--accent-strong: ${mix(shown, '#ffffff', 0.35)};
	--accent-quiet: ${mix(ground, shown, 0.3)};
	--art-h: ${hue(published)} !important;
	--art-s: 40% !important;
	--art-l: 52% !important;
}`;
	});

	const css = `/* ${id}.json */
:root[data-theme='terminal'][data-scheme='${id}'] {
	--bg-base: ${ground};
	--bg-sunken: ${sunken};
	--bg-surface: ${pane};
	--bg-raised: ${raised};
	--bg-hover: ${hover};
	--bg-active: ${active};
	--text-strong: ${foreground};
	--text-default: ${text};
	--text-muted: ${muted};
	--text-faint: ${faint};
	--border-hairline: ${raised};
	--border-strong: ${active};
	--accent-contrast: ${sunken};
	--positive: ${positive};
	--danger: ${danger};
}
${accents.join('\n')}`;
	return { id, name, ground, css };
}

let loaded: CustomScheme[] | null = null;

/** The schemes in `themes/` in the data directory, read on the first call. */
export function customSchemes(): CustomScheme[] {
	if (loaded) return loaded;
	let dir: string;
	try {
		dir = join(config().dataDir, 'themes');
	} catch {
		// Not set up yet: the setup page is drawn in the defaults.
		return [];
	}
	loaded = [];
	let files: string[];
	try {
		files = readdirSync(dir).filter((file) => file.endsWith('.json')).sort();
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log.warn('schemes-unreadable', { dir, detail: reason(err) });
		return loaded;
	}
	for (const file of files) {
		const id = file.slice(0, -'.json'.length);
		try {
			loaded.push(readScheme(id, JSON.parse(readFileSync(join(dir, file), 'utf8'))));
		} catch (err) {
			log.warn('scheme-refused', { file, detail: err instanceof Refused ? err.message : reason(err) });
		}
	}
	if (loaded.length) log.info('schemes-loaded', { schemes: loaded.map((scheme) => scheme.id).join(', ') });
	return loaded;
}

/** The custom schemes' stylesheet for the page's head, or nothing when there are none. */
export function customSchemeStyle(): string {
	const schemes = customSchemes();
	return schemes.length ? `<style id="hh-schemes">\n${schemes.map((scheme) => scheme.css).join('\n')}\n</style>` : '';
}
