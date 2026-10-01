/**
 * A stand-in for a Heddohon server, for a machine the real one cannot be
 * built on: the Windows runner has no compiler `better-sqlite3` accepts. It
 * answers what the shell asks of a server and no more: `/healthz`, the
 * manifest, a sign-in page that sets a cookie, and a home page behind it.
 * It has no service worker, so the offline page is tested on Linux only.
 */
import http from 'node:http';

const page = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;

export async function startStandIn() {
	const server = http.createServer((req, res) => {
		const url = new URL(req.url, 'http://x');
		const signedIn = /(?:^|;\s*)standin=1/.test(req.headers.cookie ?? '');
		if (url.pathname === '/healthz') {
			res.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"ok"}');
		} else if (url.pathname === '/manifest.webmanifest') {
			res.writeHead(200, { 'content-type': 'application/manifest+json' }).end('{"name":"Heddohon"}');
		} else if (url.pathname === '/login' && req.method === 'POST') {
			res.writeHead(303, { 'set-cookie': 'standin=1; Path=/; HttpOnly; Max-Age=86400', location: '/' }).end();
		} else if (url.pathname === '/login') {
			res.writeHead(200, { 'content-type': 'text/html' }).end(
				page(
					'Sign in · Heddohon',
					'<h2>Sign in</h2><form method="post" action="/login"><label>Username <input name="username"></label><label>Password <input name="password" type="password"></label><button>Sign in</button></form>'
				)
			);
		} else if (!signedIn) {
			res.writeHead(303, { location: `/login?next=${encodeURIComponent(url.pathname)}` }).end();
		} else {
			res.writeHead(200, { 'content-type': 'text/html' }).end(page('Home · Heddohon', '<h1>Your library</h1>'));
		}
	});
	await new Promise((done) => server.listen(0, '127.0.0.1', done));
	return {
		url: `http://127.0.0.1:${server.address().port}`,
		stop: () => new Promise((done) => (server.close(() => done()), server.closeAllConnections()))
	};
}
