/**
 * The Unraid template (`templates/heddohon.xml`) and the Community
 * Applications profile (`ca_profile.xml`), read as files: nothing is started.
 *
 * A template that is not well-formed lists no app at all, and one that names
 * a setting the server no longer reads, or leaves out one it gained, is wrong
 * without anything failing. These hold it to the server's own list.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, test } from 'node:test';

const ROOT = resolve(import.meta.dirname, '../..');
const read = (path) => readFileSync(resolve(ROOT, path), 'utf8');

/**
 * A strict reader for the XML these two files use: a declaration, elements,
 * double-quoted attributes, text, comments and CDATA. It refuses what an XML
 * parser refuses in them (a bare `&`, a `<` in a value, an end tag that does
 * not match, an attribute given twice, anything after the root), and returns
 * the root as `{ name, attrs, text, children }`.
 */
function parseXml(source) {
	let at = 0;
	const fail = (what) => {
		throw new Error(`${what} on line ${source.slice(0, at).split('\n').length}`);
	};
	const decode = (raw) => {
		if (/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/.test(raw)) fail('An & that starts no entity');
		return raw
			.replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
			.replace(/&#(\d+);/g, (_, digits) => String.fromCodePoint(Number(digits)))
			.replace(/&lt;/g, '<')
			.replace(/&gt;/g, '>')
			.replace(/&quot;/g, '"')
			.replace(/&apos;/g, "'")
			.replace(/&amp;/g, '&');
	};
	const match = (pattern) => {
		pattern.lastIndex = at;
		return pattern.exec(source);
	};

	const declaration = match(/<\?xml [^?]*\?>\s*/y);
	if (declaration) at += declaration[0].length;

	const top = { name: '', attrs: {}, text: '', children: [] };
	const open = [top];
	while (at < source.length) {
		const parent = open.at(-1);
		if (source.startsWith('<!--', at)) {
			const end = source.indexOf('-->', at + 4);
			if (end < 0 || source.slice(at + 4, end).includes('--')) fail('A comment that does not close');
			at = end + 3;
		} else if (source.startsWith('<![CDATA[', at)) {
			const end = source.indexOf(']]>', at);
			if (end < 0 || open.length === 1) fail('CDATA that does not close, or outside the root');
			parent.text += source.slice(at + 9, end);
			at = end + 3;
		} else if (source.startsWith('</', at)) {
			const end = match(/<\/([A-Za-z_][\w.-]*)\s*>/y);
			if (!end || open.length === 1 || end[1] !== parent.name) fail(`An end tag that does not close <${parent.name}>`);
			open.pop();
			at += end[0].length;
		} else if (source[at] === '<') {
			const start = match(/<([A-Za-z_][\w.-]*)/y);
			if (!start) fail('A < that starts no tag');
			if (open.length === 1 && top.children.length > 0) fail('A second root element');
			at += start[0].length;
			const element = { name: start[1], attrs: {}, text: '', children: [] };
			for (;;) {
				const close = match(/\s*(\/?)>/y);
				if (close) {
					at += close[0].length;
					parent.children.push(element);
					if (!close[1]) open.push(element);
					break;
				}
				const attribute = match(/\s+([A-Za-z_][\w.:-]*)="([^"<]*)"/y);
				if (!attribute) fail(`An attribute of <${element.name}> that is not name="value"`);
				if (attribute[1] in element.attrs) fail(`${attribute[1]} given twice on <${element.name}>`);
				element.attrs[attribute[1]] = decode(attribute[2]);
				at += attribute[0].length;
			}
		} else {
			const next = source.indexOf('<', at);
			const run = source.slice(at, next < 0 ? source.length : next);
			if (open.length === 1 && run.trim() !== '') fail('Text outside the root element');
			parent.text += decode(run);
			at += run.length;
		}
	}
	if (open.length !== 1) fail(`<${open.at(-1).name}> is not closed`);
	if (top.children.length !== 1) fail('No root element');
	return top.children[0];
}

const template = () => parseXml(read('templates/heddohon.xml'));
const all = (element, name) => element.children.filter((child) => child.name === name);
const one = (element, name) => {
	const found = all(element, name);
	assert.equal(found.length, 1, `<${name}> appears ${found.length} times`);
	return found[0];
};

/** Every `HEDDOHON_` variable the server reads, and `ORIGIN`, which the adapter reads for it. */
function variablesRead() {
	const sources = ['src/lib/server/config.ts', 'src/lib/server/log.ts', 'src/lib/server/logfile.ts', 'src/hooks.server.ts'];
	return new Set([...sources.flatMap((path) => read(path).match(/HEDDOHON_[A-Z_]+/g) ?? []), 'ORIGIN']);
}

/**
 * Read by the server and left out of the template on purpose. A variable
 * added to `config.ts` goes into the template or into this list.
 */
const LEFT_OUT = new Map([
	['HEDDOHON_DATA_DIR', 'the image sets it to /data, which is the Appdata path'],
	['HEDDOHON_NAVIDROME_URL', 'an older name for HEDDOHON_SUBSONIC_URL'],
	['HEDDOHON_DISCORD_URL', 'Discord has one address; the variable is for the tests']
]);

describe('the reader these checks use', () => {
	test('takes what XML allows and refuses what it does not', () => {
		const root = parseXml('<?xml version="1.0"?>\n<a v="1 &amp; 2"><!-- note --><b x="y"/><c>t &lt; u<![CDATA[ & <raw> ]]></c></a>\n');
		assert.equal(root.attrs.v, '1 & 2');
		assert.deepEqual(root.children.map((child) => child.name), ['b', 'c']);
		assert.equal(root.children[1].text, 't < u & <raw> ');
		for (const [bad, why] of [
			['<a>R&B</a>', 'a bare &'],
			['<a b="1 & 2"/>', 'a bare & in a value'],
			['<a b="x<y"/>', 'a < in a value'],
			['<a><b></a></b>', 'tags that cross'],
			['<a><b></a>', 'a tag left open'],
			['<a b="1" b="2"/>', 'an attribute twice'],
			['<a b=1/>', 'a value without quotes'],
			["<a b='1'/>", 'a value in single quotes'],
			['<a/><b/>', 'two roots'],
			['<a/>text', 'text after the root'],
			['<a><!-- a -- b --></a>', 'a comment with -- in it'],
			['', 'nothing']
		]) {
			assert.throws(() => parseXml(bad), Error, `took ${why}: ${bad}`);
		}
	});
});

describe('the Unraid template', () => {
	test('and the Community Applications profile are well-formed XML', () => {
		const root = template();
		assert.equal(root.name, 'Container');
		assert.equal(root.attrs.version, '2');
		const profile = parseXml(read('ca_profile.xml'));
		assert.equal(profile.name, 'CommunityApplications');
		for (const name of ['Profile', 'Icon', 'WebPage']) assert.ok(one(profile, name).text.trim(), `<${name}> is empty`);
	});

	test('says what the app is, and what it needs, where Community Applications reads them', () => {
		const root = template();
		for (const name of ['Name', 'Repository', 'Support', 'Project', 'TemplateURL', 'Icon', 'Category', 'WebUI', 'Overview', 'Requires']) {
			assert.ok(one(root, name).text.trim(), `<${name}> is empty`);
		}
		// Community Applications drops <Description> where there is an <Overview>:
		// the notes on what to set before the first start were in one, unseen.
		assert.deepEqual(all(root, 'Description'), []);
		const needs = one(root, 'Requires').text;
		for (const named of ['Secret', 'Public URL', 'Secure cookie', 'chown -R 99:100 /mnt/user/appdata/heddohon']) {
			assert.ok(needs.includes(named), `<Requires> does not mention ${named}`);
		}
		// The container is run as the owner of appdata, which the notes count on.
		assert.equal(one(root, 'ExtraParams').text.trim(), '--user 99:100');
		assert.match(one(root, 'Repository').text, /^ghcr\.io\/zorcerer\/heddohon:latest$/);
	});

	test('names files that are in this repository, by their address on main', () => {
		const root = template();
		const raw = 'https://raw.githubusercontent.com/zorcerer/heddohon/main/';
		const links = ['ReadMe', 'TemplateURL', 'Icon', 'Screenshot'].flatMap((name) => all(root, name).map((element) => element.text.trim()));
		assert.ok(links.length >= 5, `only ${links.length} addresses`);
		for (const link of links) {
			assert.ok(link.startsWith(raw), `${link} is not a raw address on main`);
			assert.ok(existsSync(resolve(ROOT, link.slice(raw.length))), `${link} names a file that is not in the tree`);
		}
		assert.equal(one(root, 'TemplateURL').text.trim(), `${raw}templates/heddohon.xml`);
		assert.equal(new Set(links).size, links.length, 'an address is listed twice');
	});

	test('has each setting once, complete, with its default filled in', () => {
		const settings = all(template(), 'Config');
		assert.ok(settings.length >= 30, `only ${settings.length} settings`);
		for (const { attrs, text } of settings) {
			const label = attrs.Name ?? attrs.Target;
			for (const name of ['Name', 'Target', 'Default', 'Description', 'Type', 'Display', 'Required', 'Mask']) {
				assert.ok(name in attrs, `${label} has no ${name}`);
			}
			assert.ok(['Port', 'Path', 'Variable'].includes(attrs.Type), `${label}: Type ${attrs.Type}`);
			assert.ok(['always', 'advanced'].includes(attrs.Display), `${label}: Display ${attrs.Display}`);
			assert.ok(['true', 'false'].includes(attrs.Required), `${label}: Required ${attrs.Required}`);
			assert.ok(['true', 'false'].includes(attrs.Mask), `${label}: Mask ${attrs.Mask}`);
			if (attrs.Type === 'Port') assert.equal(attrs.Mode, 'tcp', label);
			if (attrs.Type === 'Path') assert.equal(attrs.Mode, 'rw', label);
			// The form opens with the element's text, and "Default" is what its
			// reset link puts back: the two differing shows one and restores another.
			assert.equal(text, attrs.Default, `${label}: opens with ${JSON.stringify(text)}, and its default is ${JSON.stringify(attrs.Default)}`);
			assert.ok(attrs.Description.length >= 20, `${label} is not described`);
			// A setting somebody has to fill in is on the first screen.
			if (attrs.Required === 'true') assert.equal(attrs.Display, 'always', label);
			// What is typed into a secret is not shown again.
			if (/SECRET|PASSWORD$|TOKEN/.test(attrs.Target)) assert.equal(attrs.Mask, 'true', `${label} is not masked`);
		}
		for (const key of ['Name', 'Target']) {
			const values = settings.map((setting) => setting.attrs[key]);
			assert.deepEqual(values.filter((value, i) => values.indexOf(value) !== i), [], `a ${key} is used twice`);
		}
		const port = settings.find((setting) => setting.attrs.Type === 'Port');
		const path = settings.find((setting) => setting.attrs.Type === 'Path');
		assert.deepEqual([port.attrs.Target, path.attrs.Target], ['3000', '/data'], 'the port and the data directory the image uses');
	});

	test('offers the settings the server reads, and no other', () => {
		const readByServer = variablesRead();
		const offered = all(template(), 'Config')
			.filter((setting) => setting.attrs.Type === 'Variable')
			.map((setting) => setting.attrs.Target);
		for (const target of offered) assert.ok(readByServer.has(target), `${target} is in the template and the server reads no such variable`);
		for (const [name, why] of LEFT_OUT) {
			assert.ok(readByServer.has(name), `${name} is listed as left out (${why}) and the server no longer reads it`);
			assert.ok(!offered.includes(name), `${name} is both in the template and listed as left out`);
		}
		const missing = [...readByServer].filter((name) => !offered.includes(name) && !LEFT_OUT.has(name));
		assert.deepEqual(missing, [], 'read by the server, and neither in the template nor left out on purpose');
	});

	test('fills in the defaults the server has', () => {
		const config = read('src/lib/server/config.ts');
		const defaults = new Map();
		for (const [, name, value] of config.matchAll(/flagEnv\('([A-Z_]+)', (true|false)\)/g)) defaults.set(name, value);
		for (const [, name, value] of config.matchAll(/intEnv\('([A-Z_]+)', ([\d_]+),/g)) defaults.set(name, value.replaceAll('_', ''));
		for (const [, name, value] of config.matchAll(/normaliseUrl\('([A-Z_]+)', env\('\1'\) \?\? '([^']+)'/g)) defaults.set(name, value);
		for (const [, name, value] of config.matchAll(/env\('(HEDDOHON_[A-Z_]+)'\) \?\? '([^']+)'/g)) defaults.set(name, value);
		assert.ok(defaults.size >= 15, `only ${defaults.size} defaults found in config.ts`);
		const settings = new Map(all(template(), 'Config').map((setting) => [setting.attrs.Target, setting.attrs.Default]));
		let compared = 0;
		for (const [name, value] of defaults) {
			if (!settings.has(name)) continue;
			assert.equal(settings.get(name), value, `${name}: the template fills in ${settings.get(name)}, and the server's default is ${value}`);
			compared++;
		}
		assert.ok(compared >= 15, `only ${compared} defaults compared`);
	});
});
