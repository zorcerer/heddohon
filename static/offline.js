// The offline page's retry. A file of its own rather than an inline script, so
// the page needs no exception in a Content-Security-Policy.
//
// It asks `/healthz` every 5 seconds, and at once when the browser reports a
// connection, and reloads the page that failed as soon as Heddohon answers.
// `/healthz` replies with JSON in every state the server can be in; a proxy's
// error page for a stopped container is HTML.
(() => {
	const INTERVAL_MS = 5000;
	const status = document.getElementById('status');
	const retry = document.getElementById('retry');
	let checking = false;

	async function answers() {
		try {
			const response = await fetch('/healthz', { cache: 'no-store' });
			return (response.headers.get('content-type') || '').includes('application/json');
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
