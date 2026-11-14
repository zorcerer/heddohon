/**
 * The account sound analysis reads the library as (issue #317): an ordinary
 * account on the music server, given by an administrator under Settings,
 * that can do nothing else in Heddohon.
 *
 *   node --test tests/e2e/analysis-account.test.mjs
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { Client, startApp } from './harness.mjs';
import { startJellyfin, startSubsonic } from './mocks.mjs';

const ROOT = resolve(import.meta.dirname, '../..');
const ANALYST = { username: 'analyst', password: 'analyst-pass' };
const WRONG = 'That username and password were not accepted by the music server.';

let subsonic;
let jellyfin;
let app;
let admin;

/** Posts a Settings action as the page's enhanced form does, and returns its result. */
async function action(client, name, fields = {}) {
	const response = await client.request(`/settings?/${name}`, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', 'x-sveltekit-action': 'true' },
		body: new URLSearchParams(fields).toString()
	});
	const result = await response.json();
	return { type: result.type, status: result.status, data: result.data ? JSON.parse(result.data) : null };
}

/** The value a SvelteKit action's devalue payload holds under `key`. */
function field(result, key) {
	const [shape, ...values] = result.data;
	return shape[key] === undefined ? undefined : values[shape[key] - 1];
}

async function signedIn(username, password) {
	const client = new Client(app.url);
	const response = await client.signIn({ username, password, backend: 'subsonic' });
	assert.equal(response.status, 303, `${username} did not sign in`);
	return client;
}

async function database() {
	const { default: Database } = await import('better-sqlite3');
	return new Database(join(app.dataDir, 'heddohon.db'), { readonly: true });
}

before(async () => {
	subsonic = await startSubsonic({ artistCount: 4 });
	jellyfin = await startJellyfin();
	app = await startApp({ subsonicUrl: subsonic.url, jellyfinUrl: jellyfin.url, env: { HEDDOHON_ANALYSIS: 'true' } });
	admin = await signedIn('testuser', 'testpass');
});

after(async () => {
	await app?.stop();
	await subsonic?.close();
	await jellyfin?.close();
});

describe('naming the analysis account', () => {
	test('is for an administrator of the music server only', async () => {
		const other = await signedIn('seconduser', 'secondpass');
		const result = await action(other, 'saveAnalysisAccount', ANALYST);
		assert.equal(result.status, 403);
		assert.equal((await other.page('/settings?tab=storage')).html.includes('Sound analysis</h2>'), false, 'the card is shown to an account that is not an administrator');
	});

	test('refuses an administrator of the music server', async () => {
		subsonic.state.roles.set('analyst', { adminRole: true });
		const result = await action(admin, 'saveAnalysisAccount', ANALYST);
		subsonic.state.roles.delete('analyst');
		assert.equal(result.status, 400);
		assert.match(field(result, 'analysisError'), /administers the music server/);
	});

	test('refuses an account the music server will not say about', async () => {
		subsonic.state.roles.set('analyst', null);
		const result = await action(admin, 'saveAnalysisAccount', ANALYST);
		subsonic.state.roles.delete('analyst');
		assert.equal(result.status, 400);
		assert.match(field(result, 'analysisError'), /would not say/);
	});

	test('refuses an account that may not play audio', async () => {
		subsonic.state.roles.set('analyst', { streamRole: false });
		const result = await action(admin, 'saveAnalysisAccount', ANALYST);
		subsonic.state.roles.delete('analyst');
		assert.equal(result.status, 400);
		assert.match(field(result, 'analysisError'), /does not let that account play/);
	});

	test('refuses a name that has a Heddohon account of its own', async () => {
		const result = await action(admin, 'saveAnalysisAccount', { username: 'seconduser', password: 'secondpass' });
		assert.equal(result.status, 400);
		assert.match(field(result, 'analysisError'), /has signed in to Heddohon/);
	});

	test('refuses a wrong password', async () => {
		const result = await action(admin, 'saveAnalysisAccount', { username: 'analyst', password: 'not-it' });
		assert.equal(result.status, 400);
		assert.match(field(result, 'analysisError'), /did not accept/);
	});

	test('takes an ordinary account, and names what it may do beyond playing', async () => {
		subsonic.state.roles.set('analyst', { shareRole: true });
		const result = await action(admin, 'saveAnalysisAccount', ANALYST);
		subsonic.state.roles.delete('analyst');
		assert.equal(result.type, 'success');
		const { html } = await admin.page('/settings?tab=storage');
		assert.match(html, /Reads the library as/);
		assert.match(html, />analyst</);
		assert.match(html, /lets this account share/);
		assert.equal(html.includes(ANALYST.password), false, 'the password is on the page');
	});
});

describe('the analysis account, once named', () => {
	test('cannot sign in to Heddohon, and is told what a wrong password is told', async () => {
		const seen = subsonic.state.seen.length;
		const client = new Client(app.url);
		const response = await client.request('/login', {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', 'x-sveltekit-action': 'true' },
			body: new URLSearchParams({ ...ANALYST, backend: 'subsonic', next: '/' }).toString()
		});
		const result = await response.json();
		assert.equal(result.type, 'failure');
		assert.equal(result.status, 401);
		assert.ok(result.data.includes(WRONG), 'the answer differs from a wrong password\'s');
		assert.equal(client.cookies.size, 0, 'a session was made');
		assert.deepEqual(subsonic.state.seen.slice(seen), [], 'the music server was asked to sign it in');
	});

	test('in any case of its name, still without asking the music server', async () => {
		const seen = subsonic.state.seen.length;
		const response = await new Client(app.url).signIn({ username: 'ANALYST', password: ANALYST.password, backend: 'subsonic' });
		assert.equal(response.status, 401);
		assert.deepEqual(subsonic.state.seen.slice(seen), [], 'the music server was asked to sign it in');
	});

	test('has no Heddohon account, and its password is nowhere in the database', async () => {
		const db = await database();
		const rows = db.prepare('SELECT username FROM accounts').all().map((row) => row.username.toLowerCase());
		const kept = db.prepare("SELECT value FROM meta WHERE key = 'analysis-account:subsonic'").get();
		const everything = db.prepare("SELECT group_concat(value, ' ') AS text FROM meta").get().text;
		db.close();
		assert.equal(rows.includes('analyst'), false);
		assert.ok(kept, 'the account was not kept');
		assert.equal(JSON.parse(kept.value).username, 'analyst');
		assert.equal(everything.includes(ANALYST.password), false, 'the password is in the clear');
	});

	test('can be removed, and the sign-in form treats the name as any other again', async () => {
		const result = await action(admin, 'removeAnalysisAccount');
		assert.equal(result.type, 'success');
		assert.doesNotMatch((await admin.page('/settings?tab=storage')).html, /Reads the library as/);
		const response = await new Client(app.url).signIn({ ...ANALYST, backend: 'subsonic' });
		assert.equal(response.status, 303);
	});
});

describe('the analysis account\'s login', () => {
	/** Every source file under `src`, as its path from the repository root and its text. */
	function sources(dir = join(ROOT, 'src')) {
		return readdirSync(dir).flatMap((name) => {
			const path = join(dir, name);
			if (statSync(path).isDirectory()) return sources(path);
			return /\.(ts|svelte|js)$/.test(name) ? [[relative(ROOT, path), readFileSync(path, 'utf8')]] : [];
		});
	}

	test('is sealed and opened by one module, which hands out a source and not the credential', () => {
		const named = sources().filter(([, text]) => text.includes("'analysis-account'")).map(([path]) => path);
		assert.deepEqual(named, ['src/lib/server/analysis/account.ts'], 'another module names the purpose its login is sealed under');
		const builders = sources()
			.filter(([path, text]) => path !== 'src/lib/server/analysis/source.ts' && /\bsourceFor\(/.test(text))
			.map(([path]) => path);
		assert.deepEqual(builders, ['src/lib/server/analysis/account.ts'], 'another module builds an analysis source');
		const account = readFileSync(join(ROOT, 'src/lib/server/analysis/account.ts'), 'utf8');
		assert.doesNotMatch(account, /export (async )?function \w+\([^)]*\): Promise<StoredCredential/, 'account.ts hands out the credential');
	});
});

describe('with sound analysis off', () => {
	let off;
	before(async () => {
		off = await startApp({ subsonicUrl: subsonic.url, jellyfinUrl: jellyfin.url });
	});
	after(async () => off?.stop());

	test('there is no card, and naming an account is refused', async () => {
		const client = new Client(off.url);
		assert.equal((await client.signIn({ username: 'testuser', password: 'testpass', backend: 'subsonic' })).status, 303);
		assert.equal((await client.page('/settings?tab=storage')).html.includes('Sound analysis</h2>'), false);
		const response = await client.request('/settings?/saveAnalysisAccount', {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', 'x-sveltekit-action': 'true' },
			body: new URLSearchParams(ANALYST).toString()
		});
		const result = await response.json();
		assert.equal(result.status, 400);
		assert.ok(result.data.includes('Sound analysis is off'), 'an account was named with the feature off');
	});
});
