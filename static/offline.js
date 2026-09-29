// The offline page's retry. A file of its own rather than an inline script, so
// the page needs no exception in a Content-Security-Policy.
//
// It asks for the page that failed every 5 seconds, and at once when the
// browser reports a connection, and reloads as soon as Heddohon answers.
// Heddohon marks every response it sends with `x-heddohon` (see
// src/lib/headers.ts); a proxy's error page for a stopped container carries
// no such header. `/healthz` was asked before, which a proxy may restrict.
(() => {
	const INTERVAL_MS = 5000;
	const status = document.getElementById('status');
	const retry = document.getElementById('retry');
	let checking = false;

	async function answers() {
		try {
			const response = await fetch(location.href, { method: 'HEAD', cache: 'no-store' });
			return response.headers.has('x-heddohon');
		} catch {
			return false;
		}
	}

	async function check(fromButton) {
		if (checking) return;
		checking = true;
		if (fromButton) {
			retry.disabled = true;
			status.textContent = 'Trying the server…';
		}
		if (await answers()) {
			location.reload();
			return;
		}
		if (fromButton) {
			status.textContent = 'Still no answer. This page reloads by itself when the server answers.';
			retry.disabled = false;
		}
		checking = false;
	}

	retry.addEventListener('click', () => check(true));
	addEventListener('online', () => check(false));
	setInterval(() => check(false), INTERVAL_MS);
})();
