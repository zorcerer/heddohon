/**
 * Signing in through an OpenID Connect provider (issue #202): linking an
 * identity from Settings, signing in through it, every check on the return
 * and the ID token, the second factor after it, and the link going when the
 * person behind the account may have changed.
 *
 * The provider is the mock in `oidcprovider.mjs`, which signs in whoever
 * `provider.subject` names at once; `provider.tamper` changes the next token
 * it issues.
 *
 * Tests run in order and share one app and the Subsonic mock's `testuser`.
 */
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { Client, startApp } from './harness.mjs';
import { startJellyfin, startSubsonic } from './mocks.mjs';
import { CLIENT_ID, CLIENT_SECRET, startProvider } from './oidcprovider.mjs';

const USER = { username: 'testuser', password: 'testpass', backend: 'subsonic' };

let subsonic;
let jellyfin;
let provider;
let providerServer;
let app;
let base;

before(async () => {
	subsonic = await startSubsonic({ artistCount: 5 });
	jellyfin = await startJellyfin();
	providerServer = await startProvider();
	provider = providerServer.state;
	app = await startApp({
		subsonicUrl: subsonic.url,
		jellyfinUrl: jellyfin.url,
		env: {
			// The trailing slash is Authentik's; the discovery document's issuer
			// has none, and the two are held to be the same.
			HEDDOHON_OIDC_ISSUER: `${provider.url}/`,
			HEDDOHON_OIDC_CLIENT_ID: CLIENT_ID,
			HEDDOHON_OIDC_CLIENT_SECRET: CLIENT_SECRET,
			HEDDOHON_OIDC_LABEL: 'Pocket ID'
		}
	});
	base = app.url;
});

after(async () => {
	await app?.stop();
	await subsonic?.close();
	await jellyfin?.close();
	await providerServer?.close();
});

function explain(message) {
	return `${message}\n--- app output ---\n${app.output()}`;
}

function sessionOf(client) {
	return [...client.cookies.keys()].some((name) => name.includes('heddohon_session'));
}

/**
 * Follows a start (a sign-in, or a link's address) through the provider and
 * back, and answers the callback's response. `back` changes the address the
 * provider sends the browser to before it is followed.
 */
async function roundTrip(client, start, { back = (url) => url } = {}) {
	let authorize;
	if (start.startsWith('http')) {
		authorize = new URL(start);
	} else {
		const started = await client.request(start);
		assert.equal(started.status, 303, explain(`start ${start}`));
		authorize = new URL(started.headers.get('location'));
	}
	assert.equal(authorize.origin, provider.url);
	const answer = await fetch(authorize, { redirect: 'manual' });
	const returned = back(new URL(answer.headers.get('location')));
	assert.equal(returned.origin, base);
	return client.request(returned.pathname + returned.search);
}

async function signedIn(user = USER) {
	const client = new Client(base);
	assert.equal((await client.signIn(user)).status, 303, explain('password sign-in'));
	return client;
}

const oidcApi = (client, body) => client.json('/api/oidc', 'POST', body);

async function link(client, password = USER.password) {
	const asked = await oidcApi(client, { action: 'link', proof: { password } });
	assert.equal(asked.status, 200, explain('link start'));
	return roundTrip(client, (await asked.json()).url);
}

describe('without a provider configured', () => {
	test('no button, and the routes answer 404', async () => {
		const plain = await startApp({ subsonicUrl: subsonic.url, jellyfinUrl: jellyfin.url });
		try {
			const client = new Client(plain.url);
			const { html } = await client.page('/login');
			assert.doesNotMatch(html, /Sign in with Pocket ID|\/login\/oidc/);
			assert.equal((await client.request('/login/oidc')).status, 404);
			assert.equal((await client.request('/login/oidc/callback?code=x&state=y')).status, 404);
			await client.signIn(USER);
			const status = await (await client.request('/api/oidc', { headers: { accept: 'application/json' } })).json();
			assert.deepEqual(status, { provider: null, link: null });
		} finally {
			await plain.stop();
		}
	});
});

describe('signing in through the provider', () => {
	test('the sign-in page offers it, and the start goes to the provider with PKCE', async () => {
		const client = new Client(base);
		const { html } = await client.page('/login?next=%2Falbums');
		assert.match(html, /href="\/login\/oidc\?next=%2Falbums"/);
		assert.match(html, /Sign in with Pocket ID/);
		const started = await client.request('/login/oidc?next=/albums');
		const to = new URL(started.headers.get('location'));
		assert.equal(to.origin + to.pathname, `${provider.url}/authorize`);
		assert.equal(to.searchParams.get('redirect_uri'), `${base}/login/oidc/callback`);
		assert.ok(to.searchParams.get('state').length >= 43);
		assert.ok(to.searchParams.get('nonce').length >= 43);
		assert.ok([...client.cookies.keys()].includes('heddohon_oidc'), 'no pending cookie');
	});

	test('an identity linked to no account does not sign in', async () => {
		const client = new Client(base);
		const response = await roundTrip(client, '/login/oidc?next=/albums');
		assert.equal(response.status, 303);
		assert.equal(response.headers.get('location'), '/login?oidc=unlinked&next=%2Falbums');
		assert.ok(!sessionOf(client));
		const { html } = await client.page(response.headers.get('location'));
		assert.match(html, /No account here is linked to that Pocket ID account/);
	});

	test('linking needs a session and a proof', async () => {
		const anonymous = new Client(base);
		assert.equal((await oidcApi(anonymous, { action: 'link' })).status, 401);
		const client = await signedIn();
		assert.equal((await oidcApi(client, { action: 'link' })).status, 403);
		assert.equal((await oidcApi(client, { action: 'link', proof: { password: 'not-it' } })).status, 403);
		const before = await (await client.request('/api/oidc', { headers: { accept: 'application/json' } })).json();
		assert.deepEqual(before, { provider: 'Pocket ID', link: null });
	});

	test('a signed-in account links its identity', async () => {
		const client = await signedIn();
		const response = await link(client);
		assert.equal(response.status, 303, explain('link return'));
		assert.equal(response.headers.get('location'), '/settings?tab=security&oidc=linked');
		const status = await (await client.request('/api/oidc', { headers: { accept: 'application/json' } })).json();
		assert.equal(status.provider, 'Pocket ID');
		assert.ok(status.link.createdAt > 0);
		assert.equal(status.link.lastUsedAt, null);
	});

	test('the linked identity signs in, through the stored credential', async () => {
		const client = new Client(base);
		const response = await roundTrip(client, '/login/oidc?next=/albums');
		assert.equal(response.status, 303, explain('sign-in return'));
		assert.equal(response.headers.get('location'), '/albums');
		assert.ok(sessionOf(client));
		assert.equal((await client.page('/albums')).response.status, 200);
		assert.ok(!client.cookies.has('heddohon_oidc'), 'the pending cookie outlived the return');
	});

	test('a next that leaves the site comes back as /', async () => {
		for (const next of ['//evil.example', '/\\evil.example', 'https://evil.example/', '/.//evil.example']) {
			const client = new Client(base);
			const response = await roundTrip(client, `/login/oidc?next=${encodeURIComponent(next)}`);
			assert.equal(response.headers.get('location'), '/', `next=${next}`);
		}
	});

	test('the RS256 key is taken as well', async () => {
		provider.alg = 'RS256';
		try {
			const client = new Client(base);
			const response = await roundTrip(client, '/login/oidc');
			assert.equal(response.headers.get('location'), '/', explain('RS256'));
		} finally {
			provider.alg = 'ES256';
		}
	});

	test('the identity cannot be linked to a second account', async () => {
		const other = await signedIn({ username: 'seconduser', password: 'secondpass', backend: 'subsonic' });
		const response = await link(other, 'secondpass');
		assert.equal(response.headers.get('location'), '/settings?tab=security&oidc=taken');
		const status = await (await other.request('/api/oidc', { headers: { accept: 'application/json' } })).json();
		assert.equal(status.link, null);
	});

	test('a link finished in a browser signed in to another account is refused', async () => {
		const owner = await signedIn();
		const asked = await (await oidcApi(owner, { action: 'link', proof: { password: USER.password } })).json();
		// Another browser, signed in as someone else, holds the owner's pending
		// cookie: only the account named in it may be linked.
		const other = await signedIn({ username: 'seconduser', password: 'secondpass', backend: 'subsonic' });
		other.cookies.set('heddohon_oidc', owner.cookies.get('heddohon_oidc'));
		provider.subject = 'person-2';
		try {
			const response = await roundTrip(other, asked.url);
			assert.equal(response.headers.get('location'), '/settings?tab=security&oidc=refused');
		} finally {
			provider.subject = 'person-1';
		}
	});
});

describe('what a return is checked for', () => {
	test('a return to a browser without the pending sign-in never reaches the token endpoint', async () => {
		const starter = new Client(base);
		const started = await starter.request('/login/oidc');
		const answer = await fetch(started.headers.get('location'), { redirect: 'manual' });
		const returned = new URL(answer.headers.get('location'));
		const calls = provider.calls.token;
		const victim = new Client(base);
		const response = await victim.request(returned.pathname + returned.search);
		assert.equal(response.headers.get('location'), '/login?oidc=expired&next=%2F');
		assert.equal(provider.calls.token, calls);
		assert.ok(!sessionOf(victim));
	});

	test('a state that does not match is refused before the token endpoint', async () => {
		const client = new Client(base);
		const calls = provider.calls.token;
		const response = await roundTrip(client, '/login/oidc', {
			back: (url) => {
				url.searchParams.set('state', 'x'.repeat(43));
				return url;
			}
		});
		assert.equal(response.headers.get('location'), '/login?oidc=refused&next=%2F');
		assert.equal(provider.calls.token, calls);
		assert.ok(!sessionOf(client));
	});

	test('a sign-in turned down at the provider says so', async () => {
		provider.subject = null;
		try {
			const response = await roundTrip(new Client(base), '/login/oidc');
			assert.equal(response.headers.get('location'), '/login?oidc=cancelled&next=%2F');
		} finally {
			provider.subject = 'person-1';
		}
	});

	const tokens = [
		['another audience', (header, claims) => (claims.aud = 'someone-else')],
		['several audiences without azp', (header, claims) => (claims.aud = [CLIENT_ID, 'someone-else'])],
		['another issuer', (header, claims) => (claims.iss = 'http://127.0.0.1:1')],
		['another nonce', (header, claims) => (claims.nonce = 'n'.repeat(43))],
		['no nonce', (header, claims) => delete claims.nonce],
		['an expired token', (header, claims) => (claims.exp = Math.floor(Date.now() / 1000) - 120)],
		['a token issued in the future', (header, claims) => (claims.iat = Math.floor(Date.now() / 1000) + 600)],
		['an empty subject', (header, claims) => (claims.sub = '')],
		['a subject of 256 characters', (header, claims) => (claims.sub = 's'.repeat(256))],
		['a critical header', (header) => (header.crit = ['exp'])],
		['a key that is not the provider\'s', (header) => (header.kid = 'nobody')],
		['the RSA key named for an ES256 token', (header) => (header.kid = 'rsa-1')],
		['alg none', (header) => (header.alg = 'none')],
		['HS256 with the client secret', (header) => (header.alg = 'HS256')],
		['a broken signature', 'badsig'],
		['no signature', 'unsigned']
	];
	for (const [name, tamper] of tokens) {
		test(`an ID token with ${name} is refused`, async () => {
			provider.tamper = tamper;
			const client = new Client(base);
			const response = await roundTrip(client, '/login/oidc');
			assert.equal(response.headers.get('location'), '/login?oidc=refused&next=%2F', explain(name));
			assert.ok(!sessionOf(client), name);
		});
	}

	test('several audiences with this client as azp are taken', async () => {
		provider.tamper = (header, claims) => {
			claims.aud = [CLIENT_ID, 'someone-else'];
			claims.azp = CLIENT_ID;
		};
		const response = await roundTrip(new Client(base), '/login/oidc');
		assert.equal(response.headers.get('location'), '/', explain('azp'));
	});

	test('the keys are read again at most once a minute for a kid not held', async () => {
		const calls = provider.calls.keys;
		for (let i = 0; i < 3; i++) {
			provider.tamper = (header) => (header.kid = `unknown-${i}`);
			await roundTrip(new Client(base), '/login/oidc');
		}
		assert.ok(provider.calls.keys - calls <= 1, `the keys were fetched ${provider.calls.keys - calls} times`);
	});

});

describe('the second factor, and the link going', () => {
	let secret;

	function totp(offset = 0) {
		const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
		let bits = 0;
		let value = 0;
		const bytes = [];
		for (const char of secret) {
			value = (value << 5) | alphabet.indexOf(char);
			bits += 5;
			if (bits >= 8) {
				bytes.push((value >>> (bits - 8)) & 0xff);
				bits -= 8;
			}
		}
		const counter = Buffer.alloc(8);
		counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000) + offset));
		const mac = createHmac('sha1', Buffer.from(bytes)).update(counter).digest();
		const at = mac[mac.length - 1] & 0x0f;
		return String((mac.readUInt32BE(at) & 0x7fffffff) % 1e6).padStart(6, '0');
	}

	test('an account with a second factor is asked for it after the provider', async () => {
		const owner = await signedIn();
		const started = await (await owner.json('/api/two-factor', 'POST', { action: 'totp-start', proof: { password: USER.password } })).json();
		secret = started.secret;
		const confirmed = await owner.json('/api/two-factor', 'POST', { action: 'totp-confirm', code: totp() });
		assert.equal(confirmed.status, 200, explain('totp-confirm'));
		const [recovery] = (await confirmed.json()).recoveryCodes;

		const client = new Client(base);
		const response = await roundTrip(client, '/login/oidc?next=/albums');
		// A page that moves on by itself, not a redirect; see `onwards`.
		assert.equal(response.status, 200, explain('step page'));
		const html = await response.text();
		assert.match(html, /http-equiv="refresh" content="0;url=\/login\?next=%2Falbums"/);
		assert.ok(!sessionOf(client), 'signed in before the factor');
		assert.ok(client.cookies.has('heddohon_sign_in_step'));

		const { html: page } = await client.page('/login?next=%2Falbums');
		assert.match(page, /Signing in as <strong>testuser<\/strong>/);
		const done = await client.request('/login', {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'text/html' },
			body: new URLSearchParams({ code: totp(1), next: '/albums' }).toString()
		});
		assert.equal(done.status, 303, explain('code after the provider'));
		assert.equal(done.headers.get('location'), '/albums');
		assert.ok(sessionOf(client));

		const off = await owner.json('/api/two-factor', 'POST', { action: 'totp-remove', proof: { code: recovery } });
		assert.equal(off.status, 200, explain('totp-remove'));
	});

	test('a password changed upstream stops it until the password is used here', async () => {
		subsonic.state.password = 'newpass';
		try {
			const stale = await roundTrip(new Client(base), '/login/oidc');
			assert.equal(stale.headers.get('location'), '/login?oidc=stale&next=%2F');

			// The password sign-in that follows is what a reused name looks like
			// on Subsonic too, so the link goes with it.
			const client = await signedIn({ ...USER, password: 'newpass' });
			const status = await (await client.request('/api/oidc', { headers: { accept: 'application/json' } })).json();
			assert.equal(status.link, null);
			const after = await roundTrip(new Client(base), '/login/oidc');
			assert.equal(after.headers.get('location'), '/login?oidc=unlinked&next=%2F');

			assert.equal((await link(client, 'newpass')).headers.get('location'), '/settings?tab=security&oidc=linked');
			assert.equal((await roundTrip(new Client(base), '/login/oidc')).headers.get('location'), '/');
		} finally {
			subsonic.state.password = USER.password;
		}
	});

	test('unlinking ends it', async () => {
		// The password sign-in above, with the password put back, took the link
		// away again; it is made once more to be taken away here.
		const client = await signedIn();
		assert.equal((await link(client)).headers.get('location'), '/settings?tab=security&oidc=linked');
		const removed = await (await oidcApi(client, { action: 'unlink' })).json();
		assert.deepEqual(removed, { removed: true });
		const response = await roundTrip(new Client(base), '/login/oidc');
		assert.equal(response.headers.get('location'), '/login?oidc=unlinked&next=%2F');
	});
});
