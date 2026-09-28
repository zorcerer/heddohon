/**
 * Works out the next release from the commit titles since the last `v*` tag,
 * and writes its notes.
 *
 *   node .github/scripts/release-plan.mjs [--tag vX.Y.Z]
 *
 * Titles follow Conventional Commits (`feat: …`, `fix(player): …`, `feat!: …`).
 * The bump is the largest one any title asks for: `!` or a `BREAKING CHANGE`
 * footer is a major release (a minor one while the version is below 1.0), `feat`
 * a minor one, `fix` and `perf` a patch. Titles of any other type go in the
 * notes but release nothing on their own. A version set higher by hand in
 * `package.json` wins over the computed one. With `--tag`, the version is the
 * tag's, for a release tagged by hand.
 *
 * Writes `release-notes.md`, and `release`, `version` and `previous` to
 * `$GITHUB_OUTPUT` when it is set (otherwise prints them).
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();

const SECTIONS = [
	['breaking', 'Breaking changes'],
	['feat', 'Added'],
	['fix', 'Fixed'],
	['perf', 'Faster'],
	['docs', 'Documentation'],
	['other', 'Also in this release']
];

function parseVersion(text) {
	const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(text ?? '');
	return match ? match.slice(1).map(Number) : null;
}

const compare = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

function bump([major, minor, patch], level) {
	if (level === 'major') return major === 0 ? [0, minor + 1, 0] : [major + 1, 0, 0];
	if (level === 'minor') return [major, minor + 1, 0];
	return [major, minor, patch + 1];
}

const tagArg = process.argv.indexOf('--tag');
const givenTag = tagArg > 0 ? process.argv[tagArg + 1] : null;

let previous = null;
try {
	// The last release tag before this commit, not counting a tag on it.
	previous = git('describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*', givenTag ? `${givenTag}^` : 'HEAD');
} catch {
	previous = null;
}

const range = previous ? `${previous}..HEAD` : 'HEAD';
const SEP = '\x1f';
const END = '\x1e';
const commits = git('log', '--no-merges', `--format=%h${SEP}%s${SEP}%b${END}`, range)
	.split(END)
	.map((entry) => entry.trim())
	.filter(Boolean)
	.map((entry) => {
		const [hash, subject, body = ''] = entry.split(SEP);
		const match = /^(\w+)(?:\(([^)]*)\))?(!)?:\s*(.+)$/.exec(subject);
		const breaking = Boolean(match?.[3]) || /^BREAKING[ -]CHANGE:/m.test(body);
		return { hash, type: match?.[1]?.toLowerCase() ?? 'other', scope: match?.[2] ?? null, title: match?.[4] ?? subject, breaking };
	});

let level = null;
for (const commit of commits) {
	const next = commit.breaking ? 'major' : commit.type === 'feat' ? 'minor' : ['fix', 'perf'].includes(commit.type) ? 'patch' : null;
	const rank = { patch: 1, minor: 2, major: 3 };
	if (next && (!level || rank[next] > rank[level])) level = next;
}

// From the highest tag anywhere, not only the last one this commit reaches: a
// release tagged on `main`'s merge commit is not in `dev`'s history, and a
// version must never be issued twice.
const tagged = git('tag', '--list', 'v[0-9]*').split('\n').map(parseVersion).filter(Boolean).sort(compare);
const base = tagged.at(-1) ?? parseVersion(previous) ?? [0, 0, 0];
const fromPackage = parseVersion(JSON.parse(readFileSync('package.json', 'utf8')).version);
let version = null;
if (givenTag) {
	version = parseVersion(givenTag);
	if (!version) throw new Error(`${givenTag} is not a version tag`);
} else if (level) {
	version = bump(base, level);
	if (fromPackage && compare(fromPackage, version) > 0) version = fromPackage;
}

const release = version !== null && commits.length > 0;
const text = version ? version.join('.') : '';

if (release) {
	const groups = new Map(SECTIONS.map(([key]) => [key, []]));
	for (const commit of commits) {
		const key = commit.breaking ? 'breaking' : groups.has(commit.type) ? commit.type : 'other';
		const scope = commit.scope ? `**${commit.scope}:** ` : '';
		const kind = key === 'other' ? `${commit.type}: ` : '';
		groups.get(key).push(`- ${scope}${kind}${commit.title} (${commit.hash})`);
	}
	const lines = [];
	for (const [key, heading] of SECTIONS) {
		const entries = groups.get(key);
		if (entries.length === 0) continue;
		// The maintenance commits are there to be found, not to be read first.
		if (key === 'other') lines.push(`<details><summary>${heading} (${entries.length})</summary>`, '', ...entries, '', '</details>', '');
		else lines.push(`## ${heading}`, '', ...entries, '');
	}
	const repo = process.env.GITHUB_REPOSITORY ?? 'zorcerer/heddohon';
	lines.push(
		'## Install',
		'',
		`\`ghcr.io/zorcerer/heddohon:${text}\` and \`zorcererd/heddohon:${text}\`, also tagged \`latest\`.`,
		'`docker-compose.yml` (this release as `latest`) and `docker-compose.dev.yml` (the development build) are attached below.',
		''
	);
	if (previous) lines.push(`**Changes:** https://github.com/${repo}/compare/${previous}...v${text}`, '');
	writeFileSync('release-notes.md', lines.join('\n'));
}

const outputs = { release: String(release), version: text, previous: previous ?? '' };
const out = Object.entries(outputs).map(([key, value]) => `${key}=${value}`).join('\n') + '\n';
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, out);
else process.stdout.write(out);
