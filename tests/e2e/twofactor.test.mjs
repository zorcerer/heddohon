/**
 * The second factor at sign-in (issue #225): TOTP, recovery codes, passkeys,
 * the throttles, the proofs a change needs, and the server-wide requirement.
 *
 * The app here is opened on `localhost`, where a browser allows passkeys over
 * plain http, so `passkeysOffered` holds. The passkey is a software
 * authenticator made in this file: a P-256 key, and the CBOR and signatures
 * a browser would send for it.
 *
 * Tests run in order and share one app and the Subsonic mock's `testuser`.
 */
import assert from 'node:assert/strict';
import { createHash, createHmac, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { Client, startApp } from './harness.mjs';
import { startJellyfin, startSubsonic } from './mocks.mjs';

let subsonic;
let jellyfin;
let app;
let base;

const USER = { username: 'testuser', password: 'testpass', backend: 'subsonic' };

before(async () => {
	subsonic = await startSubsonic({ artistCount: 5 });
	jellyfin = await startJellyfin({ quickConnect: true });
	// The harness opens on 127.0.0.1; passkeys need a name, so this app is
	// told it is at localhost, and the clients reach it there.
	app = await startApp({ subsonicUrl: subsonic.url, jellyfinUrl: jellyfin.url, host: 'localhost' });
	base = app.url;
});

after(async () => {
	await app?.stop();
	await subsonic?.close();
	await jellyfin?.close();
});

function explain(message) {
	return `${message}\n--- app output ---\n${app.output()}`;
}

// ---------------------------------------------------------------------------
// TOTP, as an app computes it (RFC 6238)

function fromBase32(text) {
	const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
	let bits = 0;
	let value = 0;
	const out = [];
	for (const char of text) {
		value = (value << 5) | alphabet.indexOf(char);
		bits += 5;
		if (bits >= 8) {
			out.push((value >>> (bits - 8)) & 0xff);
			bits -= 8;
		}
	}
	return Buffer.from(out);
}

function totp(secret, offsetSteps = 0) {
	const counter = Buffer.alloc(8);
	counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000) + offsetSteps));
	const mac = createHmac('sha1', fromBase32(secret)).update(counter).digest();
	const offset = mac[mac.length - 1] & 0x0f;
	return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1e6).padStart(6, '0');
}

// ---------------------------------------------------------------------------
// A software passkey

function cbor(value) {
	const head = (major, n) => {
		if (n < 24) return Buffer.from([(major << 5) | n]);
		if (n < 256) return Buffer.from([(major << 5) | 24, n]);
		if (n < 65536) return Buffer.from([(major << 5) | 25, n >> 8, n & 0xff]);
		const b = Buffer.alloc(5);
		b[0] = (major << 5) | 26;
		b.writeUInt32BE(n, 1);
		return b;
	};
	if (typeof value === 'number') return value >= 0 ? head(0, value) : head(1, -1 - value);
	if (typeof value === 'string') return Buffer.concat([head(3, Buffer.byteLength(value)), Buffer.from(value)]);
	if (Buffer.isBuffer(value)) return Buffer.concat([head(2, value.length), value]);
	if (value instanceof Map) return Buffer.concat([head(5, value.size), ...[...value].flatMap(([k, v]) => [cbor(k), cbor(v)])]);
	throw new Error('cbor: unsupported');
}

const b64 = (bytes) => Buffer.from(bytes).toString('base64url');
const sha256 = (data) => createHash('sha256').update(data).digest();

class Authenticator {
	constructor() {
		const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
		this.privateKey = privateKey;
		this.jwk = publicKey.export({ format: 'jwk' });
		this.id = randomBytes(16);
		this.count = 0;
		this.userHandle = null;
	}

	authData(rpId, flags, attested) {
		const count = Buffer.alloc(4);
		count.writeUInt32BE(this.count);
		const parts = [sha256(rpId), Buffer.from([flags]), count];
		if (attested) {
			const length = Buffer.alloc(2);
			length.writeUInt16BE(this.id.length);
			const key = new Map([
				[1, 2],
				[3, -7],
				[-1, 1],
				[-2, Buffer.from(this.jwk.x, 'base64url')],
				[-3, Buffer.from(this.jwk.y, 'base64url')]
			]);
			parts.push(Buffer.alloc(16), length, this.id, cbor(key));
		}
		return Buffer.concat(parts);
	}

	/** What `navigator.credentials.create()` answers for `options`. */
	create(options, origin, { rpId = options.rp.id } = {}) {
		this.userHandle = options.user.id;
		const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: options.challenge, origin }));
		const attestation = cbor(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', this.authData(rpId, 0x45, true)]]));
		return {
			id: b64(this.id),
			rawId: b64(this.id),
			type: 'public-key',
			response: { clientDataJSON: b64(clientData), attestationObject: b64(attestation) }
		};
	}

	/** What `navigator.credentials.get()` answers for `options`. */
	get(options, origin, { flags = 0x05, rpId = options.rpId, bump = 1, challenge = options.challenge, userHandle } = {}) {
		this.count += bump;
		const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin }));
		const authData = this.authData(rpId, flags, false);
		const signature = sign('sha256', Buffer.concat([authData, sha256(clientData)]), this.privateKey);
		return {
			id: b64(this.id),
			rawId: b64(this.id),
			type: 'public-key',
			response: {
				clientDataJSON: b64(clientData),
				authenticatorData: b64(authData),
				signature: b64(signature),
				userHandle: userHandle === undefined ? this.userHandle : userHandle
			}
		};
	}
}

// ---------------------------------------------------------------------------

async function signedIn() {
	const client = new Client(base);
	const response = await client.signIn(USER);
	assert.equal(response.status, 303, explain('sign-in without a factor'));
	return client;
}

const api = (client, body) => client.json('/api/two-factor', 'POST', body);

async function signInStep(client) {
	const response = await client.signIn(USER);
	// The action answers the page with the second step, not a redirect.
	assert.equal(response.status, 200, explain('a password alone signed in'));
	assert.ok(![...client.cookies.keys()].some((name) => name.includes('heddohon_session')), 'a session cookie was set before the factor');
	assert.ok(client.cookies.has('heddohon_sign_in_step'));
}

function postCode(client, code) {
	return client.request('/login', {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'text/html' },
		body: new URLSearchParams({ code, next: '/' }).toString()
	});
}

let secret;
let recoveryCodes;

/**
 * The current code, with the step last taken forgotten first. A code is
 * taken once (`last_step`), so without this each test would wait up to 30
 * seconds for the next one; the replay test does not call it between uses.
 */
async function freshCode(dataDir = app.dataDir) {
	const { default: Database } = await import('better-sqlite3');
	const db = new Database(`${dataDir}/heddohon.db`);
	try {
		db.prepare('UPDATE totp SET last_step = NULL').run();
	} finally {
		db.close();
	}
	return totp(secret);
}

describe('TOTP', () => {
	test('setting up an app needs the password while the account has no factor', async () => {
		const client = await signedIn();
		const without = await api(client, { action: 'totp-start' });
		assert.equal(without.status, 403);
		const wrong = await api(client, { action: 'totp-start', proof: { password: 'not-it' } });
		assert.equal(wrong.status, 403);
		const started = await api(client, { action: 'totp-start', proof: { password: 'testpass' } });
		assert.equal(started.status, 200, explain('totp-start'));
		const body = await started.json();
		assert.match(body.secret, /^[A-Z2-7]{32}$/);
		assert.match(body.uri, /^otpauth:\/\/totp\/Heddohon:testuser\?secret=[A-Z2-7]{32}&issuer=Heddohon/);
		secret = body.secret;

		// Not on until a code from the app confirms it: a sign-in now needs none.
		const other = new Client(base);
		assert.equal((await other.signIn(USER)).status, 303);

		const wrongCode = await api(client, { action: 'totp-confirm', code: '000000' === totp(secret) ? '111111' : '000000' });
		assert.equal(wrongCode.status, 403);
		const confirmed = await api(client, { action: 'totp-confirm', code: await freshCode() });
		assert.equal(confirmed.status, 200, explain('totp-confirm'));
		const done = await confirmed.json();
		assert.equal(done.recoveryCodes.length, 10);
		for (const code of done.recoveryCodes) assert.match(code, /^[a-z2-7]{5}-[a-z2-7]{5}$/);
		recoveryCodes = done.recoveryCodes;
		// The other browser, signed in after this one, is signed out by the change.
		assert.ok(done.sessionsEnded >= 1);
		const gone = await other.request('/api/two-factor', { headers: { accept: 'application/json' } });
		assert.equal(gone.status, 401);
		// This one stays.
		assert.equal((await client.request('/api/two-factor')).status, 200);
	});

	test('a password alone holds the sign-in, and the right code completes it', async () => {
		const client = new Client(base);
		await signInStep(client);
		assert.equal((await client.request('/api/two-factor')).status, 401);
		const page = await client.page('/login');
		assert.equal(page.response.status, 200);
		assert.match(page.html, /authenticator app/);

		const wrong = await postCode(client, totp(secret, 5));
		assert.equal(wrong.status, 401);
		const right = await postCode(client, await freshCode());
		assert.equal(right.status, 303, explain('the right code'));
		assert.equal((await client.request('/api/two-factor')).status, 200);
	});

	test('a code is taken once', async () => {
		const first = new Client(base);
		await signInStep(first);
		const code = await freshCode();
		assert.equal((await postCode(first, code)).status, 303);
		const second = new Client(base);
		await signInStep(second);
		assert.equal((await postCode(second, code)).status, 401, 'the same code signed in twice');
	});

	test('a recovery code signs in once', async () => {
		const client = new Client(base);
		await signInStep(client);
		assert.equal((await postCode(client, recoveryCodes[0].toUpperCase())).status, 303);
		const again = new Client(base);
		await signInStep(again);
		assert.equal((await postCode(again, recoveryCodes[0])).status, 401);
		assert.equal((await postCode(again, recoveryCodes[1].replace('-', ' '))).status, 303);
		recoveryCodes = recoveryCodes.slice(2);
	});

	test('a held sign-in takes five factors, and the account five wrong ones in 15 minutes', async () => {
		const client = new Client(base);
		await signInStep(client);
		for (let i = 0; i < 4; i++) assert.equal((await postCode(client, 'aaaaa-aaaaa')).status, 401);
		// The fifth wrong one for the account: the throttle refuses the next,
		// right or wrong, from any sign-in.
		assert.equal((await postCode(client, 'aaaaa-aaaaa')).status, 401);
		const fresh = new Client(base);
		await signInStep(fresh);
		const refused = await postCode(fresh, recoveryCodes[0]);
		assert.equal(refused.status, 429, explain('the sixth factor in the window was looked at'));
		// And the held sign-in that sent six is gone.
		assert.equal((await postCode(client, recoveryCodes[0])).status, 429);
		assert.match(app.output(), /second-factor-throttled/);

		// Put back for the tests after this one.
		await clearThrottle();
	});
});

/** The throttle's rows are in the database; the suite clears them through the app's own data directory. */
async function clearThrottle() {
	const { default: Database } = await import('better-sqlite3');
	const db = new Database(`${app.dataDir}/heddohon.db`);
	db.prepare("DELETE FROM login_attempts WHERE key LIKE '2fa:%'").run();
	db.close();
}

function dbValue(sql, ...params) {
	return import('better-sqlite3').then(({ default: Database }) => {
		const db = new Database(`${app.dataDir}/heddohon.db`, { readonly: true });
		try {
			return db.prepare(sql).get(...params);
		} finally {
			db.close();
		}
	});
}

describe('what a password alone changes', () => {
	test('a password sign-in held at the second step writes nothing to the account', async () => {
		const before = await dbValue('SELECT credential, last_login_at FROM accounts WHERE username = ?', 'testuser');
		const sessions = await dbValue('SELECT COUNT(*) AS n FROM sessions');
		const client = new Client(base);
		await signInStep(client);
		const afterStep = await dbValue('SELECT credential, last_login_at FROM accounts WHERE username = ?', 'testuser');
		assert.deepEqual(afterStep, before);
		assert.equal((await dbValue('SELECT COUNT(*) AS n FROM sessions')).n, sessions.n);
		// The music server's answer is held sealed, not in the clear.
		const held = await dbValue('SELECT upstream FROM sign_in_steps');
		assert.ok(held && !held.upstream.includes('testpass'));
	});

	test('the TOTP secret and recovery codes are not stored in the clear', async () => {
		const row = await dbValue('SELECT secret FROM totp');
		assert.ok(!row.secret.includes(secret));
		const code = await dbValue('SELECT digest FROM recovery_codes LIMIT 1');
		assert.ok(!recoveryCodes.some((c) => code.digest.includes(c.replace('-', ''))));
	});
});

describe('passkeys', () => {
	const key = new Authenticator();
	let client;

	test('adding a passkey needs a factor of the account, and is checked against the origin and the relying party', async () => {
		client = new Client(base);
		await signInStep(client);
		assert.equal((await postCode(client, await freshCode())).status, 303);

		assert.equal((await api(client, { action: 'passkey-options', proof: { password: 'testpass' } })).status, 403);
		const asked = await api(client, { action: 'passkey-options', proof: { code: recoveryCodes[0] } });
		recoveryCodes = recoveryCodes.slice(1);
		assert.equal(asked.status, 200, explain('passkey-options'));
		const options = await asked.json();
		assert.equal(options.rp.id, 'localhost');
		assert.equal(options.attestation, 'none');

		const foreign = await api(client, { action: 'passkey-add', name: 'x', credential: key.create(options, 'https://evil.example') });
		assert.equal(foreign.status, 400, 'a passkey made for another origin was stored');

		// Refused before its challenge is looked at; a new one is asked for all the same.
		const again = await (await api(client, { action: 'passkey-options', proof: { code: await freshCode() } })).json();
		const wrongRp = await api(client, { action: 'passkey-add', name: 'x', credential: key.create(again, base, { rpId: 'evil.example' }) });
		assert.equal(wrongRp.status, 400);

		const third = await (await api(client, { action: 'passkey-options', proof: { code: recoveryCodes[0] } })).json();
		recoveryCodes = recoveryCodes.slice(1);
		const added = await api(client, { action: 'passkey-add', name: 'Test key', credential: key.create(third, base) });
		assert.equal(added.status, 200, explain('passkey-add'));
		assert.equal((await added.json()).passkey.name, 'Test key');
		// The same answer again: its challenge is spent.
		assert.equal((await api(client, { action: 'passkey-add', name: 'x', credential: key.create(third, base) })).status, 400);
	});

	test('a passkey completes a held sign-in', async () => {
		const browser = new Client(base);
		await signInStep(browser);
		const options = await (await browser.json('/login/passkey', 'POST', { action: 'options', for: 'step' })).json();
		assert.deepEqual(options.allowCredentials.map((c) => c.id), [b64(key.id)]);
		const answered = await browser.json('/login/passkey', 'POST', {
			action: 'verify',
			for: 'step',
			credential: key.get(options, base),
			next: '/settings'
		});
		assert.equal(answered.status, 200, explain('step with a passkey'));
		assert.deepEqual(await answered.json(), { state: 'signed-in', next: '/settings' });
		assert.equal((await browser.request('/api/two-factor')).status, 200);
	});

	test('a passkey signs in on its own, only with the user verified', async () => {
		const ask = async (browser) => (await browser.json('/login/passkey', 'POST', { action: 'options', for: 'sign-in' })).json();
		const browser = new Client(base);
		const options = await ask(browser);
		assert.equal(options.userVerification, 'required');
		assert.deepEqual(options.allowCredentials, []);

		const unverified = await browser.json('/login/passkey', 'POST', {
			action: 'verify',
			for: 'sign-in',
			credential: key.get(options, base, { flags: 0x01 })
		});
		assert.equal(unverified.status, 401, 'a passkey without user verification signed in alone');

		const second = await ask(browser);
		const verified = await browser.json('/login/passkey', 'POST', { action: 'verify', for: 'sign-in', credential: key.get(second, base) });
		assert.equal(verified.status, 200, explain('passkey sign-in'));
		assert.equal((await browser.request('/api/two-factor')).status, 200);
	});

	test('a passkey answer is refused for a spent challenge, a counter that went back, a forged signature or another handle', async () => {
		const browser = new Client(base);
		const options = await (await browser.json('/login/passkey', 'POST', { action: 'options', for: 'sign-in' })).json();
		const answer = key.get(options, base);
		assert.equal((await browser.json('/login/passkey', 'POST', { action: 'verify', for: 'sign-in', credential: answer })).status, 200);
		const replay = new Client(base);
		assert.equal((await replay.json('/login/passkey', 'POST', { action: 'verify', for: 'sign-in', credential: answer })).status, 401);

		const ask = async () => (await replay.json('/login/passkey', 'POST', { action: 'options', for: 'sign-in' })).json();
		const back = key.get(await ask(), base, { bump: -key.count });
		assert.equal((await replay.json('/login/passkey', 'POST', { action: 'verify', for: 'sign-in', credential: back })).status, 401);
		key.count = 100;

		const forged = key.get(await ask(), base);
		const signature = Buffer.from(forged.response.signature, 'base64url');
		signature[signature.length - 1] ^= 1;
		forged.response.signature = b64(signature);
		assert.equal((await replay.json('/login/passkey', 'POST', { action: 'verify', for: 'sign-in', credential: forged })).status, 401);

		const handle = key.get(await ask(), base, { userHandle: b64(Buffer.from('someone-else')) });
		assert.equal((await replay.json('/login/passkey', 'POST', { action: 'verify', for: 'sign-in', credential: handle })).status, 401);

		const step = key.get(await ask(), base);
		// A sign-in challenge answered as a second step, with no held sign-in.
		assert.equal((await replay.json('/login/passkey', 'POST', { action: 'verify', for: 'step', credential: step })).status, 400);
		assert.equal((await replay.request('/api/two-factor')).status, 401);
	});

	test('a passkey alone stops working once the music server password changes', async () => {
		subsonic.state.password = 'changed';
		try {
			const browser = new Client(base);
			const options = await (await browser.json('/login/passkey', 'POST', { action: 'options', for: 'sign-in' })).json();
			const answered = await browser.json('/login/passkey', 'POST', { action: 'verify', for: 'sign-in', credential: key.get(options, base) });
			assert.equal(answered.status, 401);
			assert.match((await answered.json()).error, /password has changed/);
		} finally {
			subsonic.state.password = 'testpass';
		}
	});

	test('removing a factor needs a proof, and the last one ends the other sessions', async () => {
		const other = new Client(base);
		await signInStep(other);
		assert.equal((await postCode(other, await freshCode())).status, 303);

		const list = await (await client.request('/api/two-factor')).json();
		assert.equal(list.passkeys, 1);
		const id = list.passkeyList[0].id;
		assert.equal((await api(client, { action: 'passkey-remove', id })).status, 403);
		const proofOptions = await (await api(client, { action: 'proof-options' })).json();
		const removed = await api(client, { action: 'passkey-remove', id, proof: { passkey: key.get(proofOptions, base) } });
		assert.equal(removed.status, 200, explain('passkey-remove'));
		// TOTP is still on: nobody is signed out.
		assert.equal((await removed.json()).sessionsEnded, 0);

		const off = await api(client, { action: 'totp-remove', proof: { code: await freshCode() } });
		assert.equal(off.status, 200, explain('totp-remove'));
		assert.ok((await off.json()).sessionsEnded >= 1);
		assert.equal((await other.request('/api/two-factor')).status, 401);
		const left = await (await client.request('/api/two-factor')).json();
		assert.deepEqual([left.totp, left.passkeys, left.recoveryCodes], [false, 0, 0]);
		// A password alone signs in again.
		assert.equal((await new Client(base).signIn(USER)).status, 303);
	});
});

describe('Quick Connect', () => {
	test('an approved request for an account with a factor waits for it, as a password does', async () => {
		const JF = { username: 'jfuser', password: 'jfpass', backend: 'jellyfin' };
		const owner = new Client(base);
		assert.equal((await owner.signIn(JF)).status, 303);
		const started = await (await api(owner, { action: 'totp-start', proof: { password: 'jfpass' } })).json();
		const saved = secret;
		secret = started.secret;
		try {
			assert.equal((await api(owner, { action: 'totp-confirm', code: await freshCode() })).status, 200);

			const browser = new Client(base);
			const asked = await browser.json('/login/quick-connect', 'POST', { backend: 'jellyfin' });
			assert.equal(asked.status, 200, explain('quick connect start'));
			jellyfin.state.quickConnectApproved = true;
			const polled = await browser.json('/login/quick-connect/poll', 'POST', { code: (await asked.json()).code, next: '/' });
			assert.deepEqual(await polled.json(), { state: 'second-step' });
			assert.equal((await browser.request('/api/two-factor')).status, 401);
			assert.equal((await postCode(browser, await freshCode())).status, 303, explain('code after quick connect'));
			assert.equal((await browser.request('/api/two-factor')).status, 200);
		} finally {
			secret = saved;
			jellyfin.state.quickConnectApproved = false;
		}
	});
});

describe('a second factor required by the server', () => {
	let strict;

	before(async () => {
		await app.stop({ keepData: true });
		strict = await startApp({
			subsonicUrl: subsonic.url,
			jellyfinUrl: jellyfin.url,
			dataDir: app.dataDir,
			env: { HEDDOHON_REQUIRE_TWO_FACTOR: 'true', HEDDOHON_MCP: 'true' }
		});
	});

	after(async () => {
		await strict?.stop();
	});

	test('an account without one reaches only Settings and what sets one up', async () => {
		const client = new Client(strict.url);
		assert.equal((await client.signIn(USER)).status, 303);
		const home = await client.page('/');
		assert.equal(home.response.status, 303);
		assert.equal(home.response.headers.get('location'), '/settings?tab=security');
		assert.equal((await client.request('/api/search?q=a')).status, 403);
		assert.equal((await client.page('/settings')).response.status, 200);
		assert.equal((await client.request('/api/two-factor')).status, 200);
		// A settings action that would make a token past the gate is refused.
		const token = await client.request('/settings?/makeMcpToken', {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
			body: 'name=x'
		});
		assert.equal(token.status, 403);
		// Its own factor cannot be taken away while required: it has none to take.
		const started = await (await api(client, { action: 'totp-start', proof: { password: 'testpass' } })).json();
		secret = started.secret;
		assert.equal((await api(client, { action: 'totp-confirm', code: await freshCode(strict.dataDir) })).status, 200);
		assert.equal((await client.request('/api/search?q=a')).status, 200);
		const removing = await api(client, { action: 'totp-remove', proof: { code: await freshCode(strict.dataDir) } });
		assert.equal(removing.status, 409);
	});

	test('an administrator clears another account’s factors with a proof of their own', async () => {
		// seconduser has a factor too, then loses it.
		const second = new Client(strict.url);
		assert.equal((await second.signIn({ username: 'seconduser', password: 'secondpass', backend: 'subsonic' })).status, 303);
		const started = await (await api(second, { action: 'totp-start', proof: { password: 'secondpass' } })).json();
		const theirs = { secret: started.secret };
		const code = (() => {
			const saved = secret;
			secret = theirs.secret;
			const value = totp(secret);
			secret = saved;
			return value;
		})();
		assert.equal((await api(second, { action: 'totp-confirm', code })).status, 200);

		const admin = new Client(strict.url);
		await signInStep(admin);
		assert.equal((await postCode(admin, await freshCode(strict.dataDir))).status, 303);
		assert.equal((await api(admin, { action: 'admin-clear', username: 'seconduser' })).status, 403);
		const cleared = await api(admin, { action: 'admin-clear', username: 'SecondUser', proof: { code: await freshCode(strict.dataDir) } });
		assert.equal(cleared.status, 200, `admin-clear\n${strict.output()}`);
		assert.equal((await second.request('/api/two-factor')).status, 401);
		const fresh = new Client(strict.url);
		assert.equal((await fresh.signIn({ username: 'seconduser', password: 'secondpass', backend: 'subsonic' })).status, 303);
		assert.equal((await fresh.request('/api/search?q=a')).status, 403, 'required again: back to setting one up');
	});
});
