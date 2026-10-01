/** The parts of the shell that need nothing of Electron, so the tests can run them under Node. */

/** The origin of an address someone typed, or null. `music.example` is read as https. */
function originOf(raw) {
	const text = String(raw ?? '').trim();
	if (!text) return null;
	try {
		const url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(text) && !/^[^/:]+:\d+(\/|$)/.test(text) ? text : `https://${text}`);
		return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : null;
	} catch {
		return null;
	}
}

/** 1 if `a` is the later version, -1 if `b` is, 0 if they are the same; by their numbers. */
function compareVersions(a, b) {
	const parts = (version) => String(version).replace(/^v/, '').split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
	const [x, y] = [parts(a), parts(b)];
	for (let i = 0; i < 3; i++) {
		if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0) ? 1 : -1;
	}
	return 0;
}

module.exports = { originOf, compareVersions };
