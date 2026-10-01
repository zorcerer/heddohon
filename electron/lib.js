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


/** Headers a proxy in front of the server may ask for. Ten is more than any does. */
const MAX_HEADERS = 10;
const MAX_HEADER_VALUE = 4096;
/** A header name, as HTTP spells a token. */
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
/** Headers the browser sets itself, or that would change what the request is. */
const RESERVED = new Set(['host', 'content-length', 'content-type', 'cookie', 'connection', 'transfer-encoding', 'upgrade', 'origin', 'referer', 'user-agent', 'te', 'trailer', 'via', 'expect', 'keep-alive']);

/**
 * The headers typed at the address screen, one `Name: value` to a line, as an
 * object. `{ error }` for a line that is not one, a name the browser owns
 * (`Host`, `Cookie`, anything `Sec-` or `Proxy-`), or more than ten.
 */
function parseHeaders(text) {
	const headers = {};
	for (const raw of String(text ?? '').split(/\r?\n/)) {
		const line = raw.trim();
		if (!line) continue;
		const at = line.indexOf(':');
		const name = at > 0 ? line.slice(0, at).trim() : '';
		const value = at > 0 ? line.slice(at + 1).trim() : '';
		if (!HEADER_NAME.test(name) || !value) return { error: `"${line.slice(0, 40)}" is not a header. A header is a name, a colon and a value: X-Token: abc123.` };
		const lower = name.toLowerCase();
		if (RESERVED.has(lower) || lower.startsWith('sec-') || lower.startsWith('proxy-')) return { error: `${name} is set by the app itself and cannot be changed here.` };
		if (value.length > MAX_HEADER_VALUE || /[\u0000-\u001f\u007f]/.test(value)) return { error: `The value of ${name} cannot be sent as a header.` };
		headers[name] = value;
	}
	if (Object.keys(headers).length > MAX_HEADERS) return { error: `At most ${MAX_HEADERS} headers.` };
	return { headers };
}

/** The same headers as the text they were typed as. */
function formatHeaders(headers) {
	return Object.entries(headers ?? {})
		.map(([name, value]) => `${name}: ${value}`)
		.join('\n');
}

/**
 * What an answer to `/healthz` says about the address: a Heddohon, a sign-in
 * in front of one (a redirect, or a 401 or 403, which is how a proxy that
 * authenticates answers someone it does not know), or something else.
 */
function classify(status, body) {
	if ((status >= 300 && status < 400) || status === 401 || status === 403) return 'sign-in';
	if (status !== 200) return 'other';
	try {
		return JSON.parse(body)?.status === 'ok' ? 'heddohon' : 'other';
	} catch {
		return 'other';
	}
}

module.exports = { originOf, compareVersions, parseHeaders, formatHeaders, classify };
