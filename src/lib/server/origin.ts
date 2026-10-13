/**
 * The addresses saved for a deployment, and what follows from one.
 *
 * SvelteKit's adapter works out the address a request is served on, once per
 * request: from `ORIGIN` where the environment sets it, and otherwise from
 * the `Host` header with `https` assumed. That guess is wrong for a
 * deployment opened over plain http on a local network, which is where a
 * first run happens: the browser sends `Origin: http://…`, the server
 * believes `https://…`, and every write is refused as cross-origin, sign-in
 * first.
 *
 * So an address can be saved (`origins` in the configuration; by the setup
 * page, or by an administrator under Settings). The built server reads the
 * list from here (`savedOrigin` in `vite.config.ts`) and, for a request whose
 * `Host` is the host of a saved address, tells the adapter that address the
 * way a reverse proxy would: in the two headers the adapter is told to trust.
 * Nothing about the cross-origin checks changes. SvelteKit's and the one in
 * `hooks.server.ts` both run as before, against the right address.
 *
 * A saved address cannot make the server accept a write from another site.
 * It is matched against `Host`, which names the server the request was sent
 * to, and the checks still compare the browser's `Origin` with the result. A
 * page on `evil.example` sends `Host: music.example.com` and
 * `Origin: https://evil.example`, and is refused, whatever is saved.
 */
import { BlockList, isIP } from 'node:net';

/** Where the built server's middleware finds the list; see `savedOrigin` in `vite.config.ts`. */
const PUBLISHED = '__heddohonSavedOrigins';

/** Hands the saved addresses to the middleware. Called whenever the configuration is read. */
export function publishOrigins(origins: readonly string[]): void {
	(globalThis as Record<string, unknown>)[PUBLISHED] = [...origins];
}

const LOCAL = new BlockList();
LOCAL.addSubnet('10.0.0.0', 8);
LOCAL.addSubnet('172.16.0.0', 12);
LOCAL.addSubnet('192.168.0.0', 16);
LOCAL.addSubnet('127.0.0.0', 8);
LOCAL.addSubnet('169.254.0.0', 16);
LOCAL.addSubnet('100.64.0.0', 10);
LOCAL.addAddress('::1', 'ipv6');
LOCAL.addSubnet('fc00::', 7, 'ipv6');
LOCAL.addSubnet('fe80::', 10, 'ipv6');

/**
 * The saved addresses a sign-in cookie is sent on without `Secure`: those on
 * plain http on the local network, while `HEDDOHON_COOKIE_SECURE` is left at
 * `auto` (`cookieSecure` in `auth.ts`). The setup and the administrator's
 * form name them, so that it is the operator's choice and not a surprise.
 */
export function addressesWithoutSecure(origins: readonly string[], setting: boolean | 'auto'): string[] {
	if (setting !== 'auto') return [];
	return origins.filter((origin) => {
		const url = new URL(origin);
		return url.protocol === 'http:' && isLocalHost(url.hostname);
	});
}

/**
 * Whether a host is one on the local network: a private, loopback or
 * link-local address, `localhost`, a `.local` or `.lan` name, or a name with
 * no dot in it. A name on the public internet is none of these.
 */
export function isLocalHost(hostname: string): boolean {
	const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
	const family = isIP(host);
	if (family === 4) return LOCAL.check(host, 'ipv4');
	if (family === 6) return LOCAL.check(host, 'ipv6');
	return host === 'localhost' || !host.includes('.') || /\.(local|lan|home\.arpa|internal)$/.test(host);
}
