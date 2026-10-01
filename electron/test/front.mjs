/**
 * A proxy in front of a server that asks who is asking first, three ways:
 *
 *  - `sso`: without its cookie, a request is redirected to a sign-in page on
 *    another origin; signing in there comes back through `/_front/callback`,
 *    which sets the cookie. This is the shape of Authelia, Authentik and
 *    Cloudflare Access.
 *  - `header`: a request needs `X-Front-Token: letmein`, or it is a 401.
 *  - `basic`: a request needs basic auth as ada / lovelace, or it is a 401
 *    with a challenge.
 *
 * What passes is sent on to `target` as it came.
 */
import http from 'node:http';

function listen(handler) {
	const server = http.createServer(handler);
	return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` })));
}
const close = (server) => new Promise((done) => (server.close(() => done()), server.closeAllConnections()));

export async function startFront(target, mode) {
	const seen = { passed: 0, refused: 0, headers: [] };
	let signIn = null;

	const front = await listen((req, res) => {
		const pass = () => {
			seen.passed++;
			seen.headers.push(req.headers);
			const upstream = http.request(target + req.url, { method: req.method, headers: { ...req.headers, host: new URL(target).host } }, (answer) => {
				res.writeHead(answer.statusCode, answer.headers);
				answer.pipe(res);
			});
			upstream.on('error', () => res.writeHead(502).end());
			req.pipe(upstream);
		};
		const refuse = (status, headers = {}) => {
			seen.refused++;
			res.writeHead(status, { 'content-type': 'text/plain', ...headers }).end(`${status}`);
		};

		if (mode === 'header') return req.headers['x-front-token'] === 'letmein' ? pass() : refuse(401);
		if (mode === 'basic') {
			const expected = `Basic ${Buffer.from('ada:lovelace').toString('base64')}`;
			return req.headers.authorization === expected ? pass() : refuse(401, { 'www-authenticate': 'Basic realm="front"' });
		}
		// sso
		if (req.url.startsWith('/_front/callback')) {
			// Kept for a day, as a proxy's is: a cookie without an age is gone when the app closes.
			res.writeHead(302, { 'set-cookie': 'front=1; Path=/; HttpOnly; Max-Age=86400', location: '/' }).end();
			return;
		}
		if (/(?:^|;\s*)front=1/.test(req.headers.cookie ?? '')) return pass();
		seen.refused++;
		res.writeHead(302, { location: `${signIn.url}/login` }).end();
	});

	if (mode === 'sso') {
		signIn = await listen((req, res) => {
			if (req.method === 'POST') {
				res.writeHead(302, { location: `${front.url}/_front/callback` }).end();
				return;
			}
			res.writeHead(200, { 'content-type': 'text/html' }).end(
				'<!doctype html><title>Front sign-in</title><h1>Front sign-in</h1><form method="post" action="/login"><button>Sign in to the front</button></form><a href="https://example.com/terms">Terms</a>'
			);
		});
	}

	return {
		url: front.url,
		signInUrl: signIn?.url ?? null,
		seen,
		async close() {
			await close(front.server);
			if (signIn) await close(signIn.server);
		}
	};
}
