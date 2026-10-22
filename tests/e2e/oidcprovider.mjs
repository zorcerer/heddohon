/**
 * A mock OpenID Connect provider, for `tests/e2e/oidc.test.mjs` and
 * `tests/browser/oidc.test.mjs`: discovery, an authorize endpoint that signs
 * in whoever `state.subject` names, a token endpoint that holds the client to
 * its secret and its PKCE verifier, and the keys. It signs with ES256 unless
 * `state.alg` says RS256, and `state.tamper` changes the next token it issues.
 *
 * With `page: true` the authorize endpoint answers with a page holding a
 * link back instead of a redirect, so that a browser comes back by a
 * navigation the provider's site started, as it does from a real one.
 */
import assert from 'node:assert/strict';
import { createHash, createHmac, generateKeyPairSync, sign } from 'node:crypto';
import { createServer } from 'node:http';

export const CLIENT_ID = 'heddohon';
export const CLIENT_SECRET = 'the client secret, with a space';

export function startProvider({ page = false } = {}) {
	const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
	const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
	const keys = {
		ES256: { private: ec.privateKey, jwk: { ...ec.publicKey.export({ format: 'jwk' }), kid: 'ec-1', use: 'sig', alg: 'ES256' } },
		RS256: { private: rsa.privateKey, jwk: { ...rsa.publicKey.export({ format: 'jwk' }), kid: 'rsa-1', use: 'sig', alg: 'RS256' } }
	};
	const codes = new Map();
	const state = {
		url: '',
		subject: 'person-1',
		/** `(header, claims) => void` for the next token, or 'badsig' / 'unsigned'. */
		tamper: null,
		alg: 'ES256',
		calls: { token: 0, keys: 0 },
		lastTokenError: null
	};

	const server = createServer(async (req, res) => {
		const url = new URL(req.url, state.url);
		const json = (status, body) => {
			res.writeHead(status, { 'content-type': 'application/json' });
			res.end(JSON.stringify(body));
		};
		if (url.pathname === '/.well-known/openid-configuration') {
			return json(200, {
				issuer: state.url,
				authorization_endpoint: `${state.url}/authorize`,
				token_endpoint: `${state.url}/token`,
				jwks_uri: `${state.url}/jwks`,
				token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post']
			});
		}
		if (url.pathname === '/jwks') {
			state.calls.keys++;
			return json(200, { keys: Object.values(keys).map((key) => key.jwk) });
		}
		if (url.pathname === '/authorize') {
			const p = url.searchParams;
			assert.equal(p.get('client_id'), CLIENT_ID);
			assert.equal(p.get('response_type'), 'code');
			assert.equal(p.get('scope'), 'openid');
			assert.equal(p.get('code_challenge_method'), 'S256');
			const back = new URL(p.get('redirect_uri'));
			back.searchParams.set('state', p.get('state'));
			if (state.subject === null) {
				back.searchParams.set('error', 'access_denied');
			} else {
				const code = `code-${Math.random().toString(36).slice(2)}`;
				codes.set(code, { subject: state.subject, nonce: p.get('nonce'), challenge: p.get('code_challenge'), redirectUri: p.get('redirect_uri') });
				back.searchParams.set('code', code);
			}
			if (page) {
				res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
				return res.end(`<!doctype html><title>Provider</title><a href="${back.toString().replace(/&/g, '&amp;')}">Continue</a>`);
			}
			res.writeHead(302, { location: back.toString() });
			return res.end();
		}
		if (url.pathname === '/token' && req.method === 'POST') {
			state.calls.token++;
			let body = '';
			for await (const chunk of req) body += chunk;
			const form = new URLSearchParams(body);
			const refuse = (why) => {
				state.lastTokenError = why;
				return json(400, { error: 'invalid_grant' });
			};
			const basic = Buffer.from((req.headers.authorization ?? '').replace(/^Basic /, ''), 'base64').toString();
			const [id, secret] = basic.split(':').map((part) => decodeURIComponent(part.replace(/\+/g, ' ')));
			if (id !== CLIENT_ID || secret !== CLIENT_SECRET) return refuse('client');
			const grant = codes.get(form.get('code'));
			codes.delete(form.get('code'));
			if (!grant || form.get('grant_type') !== 'authorization_code') return refuse('code');
			if (form.get('redirect_uri') !== grant.redirectUri) return refuse('redirect_uri');
			if (createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url') !== grant.challenge) return refuse('pkce');

			const now = Math.floor(Date.now() / 1000);
			const header = { alg: state.alg, typ: 'JWT', kid: keys[state.alg].jwk.kid };
			const claims = { iss: state.url, sub: grant.subject, aud: CLIENT_ID, exp: now + 300, iat: now, nonce: grant.nonce };
			const tamper = state.tamper;
			state.tamper = null;
			if (typeof tamper === 'function') tamper(header, claims);
			const segment = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
			const signed = `${segment(header)}.${segment(claims)}`;
			let signature;
			if (tamper === 'unsigned') signature = '';
			else if (header.alg === 'HS256') signature = createHmac('sha256', CLIENT_SECRET).update(signed).digest('base64url');
			else {
				const key = keys[state.alg].private;
				signature = sign('sha256', Buffer.from(signed), state.alg === 'ES256' ? { key, dsaEncoding: 'ieee-p1363' } : key).toString('base64url');
			}
			if (tamper === 'badsig') signature = `${signature.slice(0, -4)}AAAA`;
			return json(200, { access_token: 'unused', token_type: 'Bearer', id_token: `${signed}.${signature}` });
		}
		res.writeHead(404);
		res.end();
	});
	return new Promise((done) => {
		server.listen(0, '127.0.0.1', () => {
			state.url = `http://127.0.0.1:${server.address().port}`;
			done({
				state,
				close: () =>
					new Promise((closed) => {
						server.close(closed);
						server.closeAllConnections();
					})
			});
		});
	});
}
