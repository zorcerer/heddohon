/**
 * The rules of a smart playlist, as the editor shows them and as Navidrome
 * keeps them.
 *
 * Navidrome stores a smart playlist's rules as JSON (its `criteria` package,
 * the same format as an `.nsp` file) and evaluates them itself, so the
 * playlist plays in every Subsonic app. Heddohon edits a subset of that
 * format: one list of rules, all or any of which a song meets, each a field,
 * an operator and a value, then a sort, an order and a limit. `toCriteria`
 * writes it, and `fromCriteria` reads it back, or answers null for rules made
 * in Navidrome or a file that use more of the format (groups inside groups,
 * tags, other playlists, a limit in percent). Those are left as they are.
 *
 * The browser sends this model, never criteria: `checkRules` holds it to the
 * fields, operators and bounds below before anything reaches the music
 * server. Navidrome 0.64.2 stores a rule on a field it does not know and
 * answers 200, so the check here is the only one.
 *
 * Checked against Navidrome 0.64.2 (`model/criteria`, `persistence/criteria_sql.go`)
 * and its server on the test rig on 2026-10-20. `notInTheLast` there also
 * matches a song with no date at all (never played), and `lt` on the year
 * matches a song with no year, which Navidrome holds as 0.
 */

export type RuleKind = 'text' | 'number' | 'boolean' | 'days';

export const RULE_FIELDS = [
	'title',
	'artist',
	'album',
	'albumartist',
	'genre',
	'year',
	'rating',
	'playcount',
	'duration',
	'loved',
	'lastplayed',
	'dateadded'
] as const;
export type RuleField = (typeof RULE_FIELDS)[number];

export const RULE_OPS = [
	'is',
	'isNot',
	'contains',
	'notContains',
	'startsWith',
	'gt',
	'lt',
	'inTheRange',
	'inTheLast',
	'notInTheLast'
] as const;
export type RuleOp = (typeof RULE_OPS)[number];

interface FieldInfo {
	label: string;
	kind: RuleKind;
	/** Bounds of a number, inclusive. */
	min?: number;
	max?: number;
	/** A unit for the value's input, where it has one. */
	unit?: string;
}

export const FIELDS: Record<RuleField, FieldInfo> = {
	title: { label: 'Title', kind: 'text' },
	artist: { label: 'Artist', kind: 'text' },
	album: { label: 'Album', kind: 'text' },
	albumartist: { label: 'Album artist', kind: 'text' },
	genre: { label: 'Genre', kind: 'text' },
	year: { label: 'Year', kind: 'number', min: 0, max: 9999 },
	rating: { label: 'Rating', kind: 'number', min: 0, max: 5, unit: 'stars' },
	playcount: { label: 'Play count', kind: 'number', min: 0, max: 1_000_000, unit: 'plays' },
	duration: { label: 'Length', kind: 'number', min: 0, max: 86_400, unit: 'seconds' },
	loved: { label: 'Favourite', kind: 'boolean' },
	lastplayed: { label: 'Last played', kind: 'days' },
	dateadded: { label: 'Added', kind: 'days' }
};

/** The operators each kind of field takes, in the order the editor lists them. */
export const OPS_BY_KIND: Record<RuleKind, readonly RuleOp[]> = {
	text: ['contains', 'notContains', 'is', 'isNot', 'startsWith'],
	number: ['gt', 'lt', 'is', 'inTheRange'],
	boolean: ['is'],
	days: ['inTheLast', 'notInTheLast']
};

export const OP_LABELS: Record<RuleOp, string> = {
	is: 'is',
	isNot: 'is not',
	contains: 'contains',
	notContains: "doesn't contain",
	startsWith: 'starts with',
	gt: 'is more than',
	lt: 'is less than',
	inTheRange: 'is between',
	inTheLast: 'in the last',
	notInTheLast: 'not in the last'
};

/** What a playlist can be sorted by: every field but the two that are not one value a song. */
export const SORT_FIELDS = [
	'title',
	'artist',
	'album',
	'albumartist',
	'year',
	'rating',
	'playcount',
	'duration',
	'lastplayed',
	'dateadded',
	'random'
] as const;
export type SortField = (typeof SORT_FIELDS)[number];

export const MAX_RULES = 20;
export const MAX_TEXT = 200;
export const MAX_LIMIT = 1000;
/** A hundred years, the most "in the last" takes. */
export const MAX_DAYS = 36_500;

export type RuleValue = string | number | boolean | [number, number];

export interface SmartRule {
	field: RuleField;
	op: RuleOp;
	value: RuleValue;
}

export interface SmartRules {
	match: 'all' | 'any';
	rules: SmartRule[];
	sort: SortField;
	order: 'asc' | 'desc';
	/** Songs at most, or null for every song that matches. */
	limit: number | null;
}

/** A rule set for the editor to start from: songs added in the last 30 days, newest first. */
export function blankRules(): SmartRules {
	return {
		match: 'all',
		rules: [{ field: 'dateadded', op: 'inTheLast', value: 30 }],
		sort: 'dateadded',
		order: 'desc',
		limit: 100
	};
}

/** The value a rule starts with when its field or operator changes in the editor. */
export function defaultValue(field: RuleField, op: RuleOp): RuleValue {
	const info = FIELDS[field];
	if (info.kind === 'boolean') return true;
	if (info.kind === 'days') return 30;
	if (info.kind === 'text') return '';
	if (op === 'inTheRange') return field === 'year' ? [1990, 1999] : [info.min ?? 0, info.max ?? 0];
	return field === 'year' ? 2000 : field === 'rating' ? 3 : 0;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

function within(value: unknown, min: number, max: number, whole: boolean): number | null {
	if (typeof value !== 'number' || !Number.isFinite(value)) return null;
	if (whole && !Number.isInteger(value)) return null;
	return value >= min && value <= max ? value : null;
}

/** One rule's value checked against its field and operator, or null. */
function checkValue(field: RuleField, op: RuleOp, value: unknown): RuleValue | null {
	const info = FIELDS[field];
	if (!OPS_BY_KIND[info.kind].includes(op)) return null;
	switch (info.kind) {
		case 'text': {
			if (typeof value !== 'string') return null;
			const text = value.trim();
			return text.length > 0 && text.length <= MAX_TEXT ? text : null;
		}
		case 'boolean':
			return typeof value === 'boolean' ? value : null;
		case 'days':
			return within(value, 1, MAX_DAYS, true);
		case 'number': {
			// Length may be part of a second; the others are whole numbers.
			const whole = field !== 'duration';
			if (op === 'inTheRange') {
				if (!Array.isArray(value) || value.length !== 2) return null;
				const low = within(value[0], info.min!, info.max!, whole);
				const high = within(value[1], info.min!, info.max!, whole);
				return low !== null && high !== null && low <= high ? [low, high] : null;
			}
			return within(value, info.min!, info.max!, whole);
		}
	}
}

/**
 * A rule set from the browser, held to the fields, operators and bounds
 * above. The rule set, or the reason it was refused, for a 400.
 */
export function checkRules(input: unknown): { rules: SmartRules } | { error: string } {
	if (!isRecord(input)) return { error: 'Rules are required' };
	if (input.match !== 'all' && input.match !== 'any') return { error: 'Match must be all or any' };
	if (!Array.isArray(input.rules) || input.rules.length === 0) return { error: 'At least one rule is required' };
	if (input.rules.length > MAX_RULES) return { error: `At most ${MAX_RULES} rules` };
	const rules: SmartRule[] = [];
	for (const [n, rule] of input.rules.entries()) {
		if (!isRecord(rule)) return { error: `Rule ${n + 1} is not a rule` };
		const field = RULE_FIELDS.find((name) => name === rule.field);
		const op = RULE_OPS.find((name) => name === rule.op);
		if (!field) return { error: `Rule ${n + 1} has no known field` };
		if (!op) return { error: `Rule ${n + 1} has no known operator` };
		const value = checkValue(field, op, rule.value);
		if (value === null) return { error: `Rule ${n + 1}: ${FIELDS[field].label.toLowerCase()} ${OP_LABELS[op]} needs a valid value` };
		rules.push({ field, op, value });
	}
	const sort = SORT_FIELDS.find((name) => name === input.sort);
	if (!sort) return { error: 'Sort by a known field' };
	if (input.order !== 'asc' && input.order !== 'desc') return { error: 'Order must be asc or desc' };
	const limit = input.limit === null ? null : within(input.limit, 1, MAX_LIMIT, true);
	if (limit === null && input.limit !== null) return { error: `The limit must be 1 to ${MAX_LIMIT} songs, or none` };
	return { rules: { match: input.match, rules, sort, order: input.order, limit } };
}

/** The rule set in Navidrome's format, for `/api/playlist`. */
export function toCriteria(rules: SmartRules): Record<string, unknown> {
	return {
		[rules.match]: rules.rules.map((rule) => ({ [rule.op]: { [rule.field]: rule.value } })),
		sort: rules.sort,
		order: rules.order,
		...(rules.limit === null ? {} : { limit: rules.limit })
	};
}

/** A number as Navidrome may hold it: a `.nsp` file can write one as a string. */
function numberOf(value: unknown): unknown {
	if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim())) return Number(value);
	return value;
}

function booleanOf(value: unknown): unknown {
	if (value === 'true' || value === 1) return true;
	if (value === 'false' || value === 0) return false;
	return value;
}

/**
 * Navidrome's rules as the editor shows them, or null where they use more of
 * the format than the editor edits. Keys are read in any case, as Navidrome
 * reads them.
 */
export function fromCriteria(criteria: unknown): SmartRules | null {
	if (!isRecord(criteria)) return null;
	let match: 'all' | 'any' | null = null;
	let list: unknown = null;
	let sort: SortField = 'title';
	let order: 'asc' | 'desc' = 'asc';
	let limit: number | null = null;
	for (const [key, value] of Object.entries(criteria)) {
		switch (key.toLowerCase()) {
			case 'all':
			case 'any':
				if (match !== null) return null;
				match = key.toLowerCase() as 'all' | 'any';
				list = value;
				break;
			case 'sort': {
				if (typeof value !== 'string' || value === '') break;
				const named = SORT_FIELDS.find((name) => name === value.trim().toLowerCase());
				if (!named) return null;
				sort = named;
				break;
			}
			case 'order':
				if (value === '' || value === undefined) break;
				if (typeof value !== 'string' || !['asc', 'desc'].includes(value.toLowerCase())) return null;
				order = value.toLowerCase() as 'asc' | 'desc';
				break;
			case 'limit':
				if (value === 0) break;
				limit = within(value, 1, MAX_LIMIT, true);
				if (limit === null) return null;
				break;
			case 'limitpercent':
			case 'offset':
			case 'refreshdelay':
				if (value !== 0 && value !== undefined && value !== null) return null;
				break;
			default:
				return null;
		}
	}
	if (match === null || !Array.isArray(list) || list.length === 0 || list.length > MAX_RULES) return null;

	const rules: SmartRule[] = [];
	for (const entry of list) {
		if (!isRecord(entry)) return null;
		const keys = Object.keys(entry);
		if (keys.length !== 1) return null;
		const op = RULE_OPS.find((name) => name.toLowerCase() === keys[0].toLowerCase());
		const operand = entry[keys[0]];
		if (!op || !isRecord(operand) || Object.keys(operand).length !== 1) return null;
		const [name, raw] = Object.entries(operand)[0];
		const field = RULE_FIELDS.find((known) => known === name.toLowerCase());
		if (!field) return null;
		const kind = FIELDS[field].kind;
		const read =
			kind === 'boolean'
				? booleanOf(raw)
				: kind === 'text'
					? raw
					: Array.isArray(raw)
						? raw.map(numberOf)
						: numberOf(raw);
		const value = checkValue(field, op, read);
		if (value === null) return null;
		rules.push({ field, op, value });
	}
	return { match, rules, sort, order, limit };
}

function describeValue(rule: SmartRule): string {
	const info = FIELDS[rule.field];
	if (info.kind === 'boolean') return rule.value ? 'yes' : 'no';
	if (info.kind === 'days') return `${rule.value} day${rule.value === 1 ? '' : 's'}`;
	if (info.kind === 'text') return `“${rule.value}”`;
	// "Play count is more than 3" needs no unit; a length does.
	const unit = rule.field === 'duration' ? ' seconds' : '';
	if (Array.isArray(rule.value)) return `${rule.value[0]} and ${rule.value[1]}${unit}`;
	return `${rule.value}${unit}`;
}

/** The rules in a line of words, for the playlist page: "Genre contains “jazz”, and year is less than 1970". */
export function describeRules(rules: SmartRules): string {
	const parts = rules.rules.map((rule, n) => {
		const label = FIELDS[rule.field].label;
		return `${n === 0 ? label : label.toLowerCase()} ${OP_LABELS[rule.op]} ${describeValue(rule)}`;
	});
	const joined = parts.length < 2 ? parts.join('') : `${parts.slice(0, -1).join(', ')}, ${rules.match === 'all' ? 'and' : 'or'} ${parts.at(-1)}`;
	const sort =
		rules.sort === 'random'
			? 'in random order'
			: `by ${SORT_LABELS[rules.sort].toLowerCase()}, ${rules.order === 'asc' ? 'ascending' : 'descending'}`;
	const limit = rules.limit === null ? '' : `, ${rules.limit} song${rules.limit === 1 ? '' : 's'} at most`;
	return `${joined}; ${sort}${limit}`;
}

export const SORT_LABELS: Record<SortField, string> = {
	title: 'Title',
	artist: 'Artist',
	album: 'Album',
	albumartist: 'Album artist',
	year: 'Year',
	rating: 'Rating',
	playcount: 'Play count',
	duration: 'Length',
	lastplayed: 'Last played',
	dateadded: 'Added',
	random: 'Random'
};
