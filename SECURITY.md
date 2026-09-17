# Security

Heddohon sits between the public internet and a music server that usually lives
on a private network. This document covers the controls it implements, where
they stop, and what it expects from the operator. Every claim here can be
checked against the source.

## Reporting a vulnerability

Report privately through GitHub's **Report a vulnerability** button on the
Security tab. Include what you did, what happened and what you expected. A
reproduction against a local instance is the most useful thing you can send.
There is no bounty.

## Threat model

- **Hostile:** the public internet, anyone who can reach the login page, any
  signed-in account acting against another, and the library itself (metadata,
  cover art, lyrics), since anyone with write access to a shared library
  controls it.
- **Semi-trusted:** the upstream music server. Heddohon trusts it for content
  and keeps control of what executes in the browser (see [Proxied media](#proxied-media)).
- **Trusted:** the operator, the host, the reverse proxy and the container environment.
- **Out of scope:** anyone with shell access to the host or read access to the
  data volume. Credential encryption protects a stolen database file; an
  attacker running code beside the process can decrypt what it decrypts.

## Design

The browser only talks to Heddohon, and Heddohon fetches every byte from the
music server itself. The upstream address stays inside the server process: it
appears in no page, bundle or error message, and the login page receives only
each server's label and kind. The upstream credential leaves the process only as
a request to the music server. The one host you expose is Heddohon.

## Credentials at rest

- Upstream credentials are sealed with **AES-256-GCM** before they reach the database.
- Keys are derived with **scrypt** (N = 2¹⁵, r = 8, p = 1) from `HEDDOHON_SECRET`.
  Three separate keys cover encryption, session digests and pseudonyms.
- Each seal uses a fresh 12-byte random IV. The tag is verified on open, and a
  blob with a wrong version, part count, IV length or tag length is rejected.
- Changing `HEDDOHON_SECRET` makes every stored credential unreadable and signs
  everyone out. Use it to revoke everything at once.

**Subsonic stores the password.** The protocol needs it on every request
(`md5(password + salt)`), so the sealed value is the password itself.
Jellyfin issues a token at sign-in and Heddohon discards the password.

## Sessions

The cookie is a **256-bit random token** with no payload. The database stores
only `HMAC-SHA256(token)`, so reading the database yields no usable cookie.

| Property | Value |
| --- | --- |
| Name | `__Host-heddohon_session` when `Secure`, `heddohon_session` otherwise |
| Flags | `HttpOnly`, `SameSite=Lax`, `Path=/`, host-only, `Secure` (see below) |
| Lifetime | `HEDDOHON_SESSION_HOURS`, default and hard ceiling **72 hours** |
| Extension | Activity updates `last_seen_at` only; `expires_at` is fixed at creation |

Expiry is checked on every request, and an expired row is deleted when
presented. Signing out deletes the server-side record. When the upstream rejects
a stored credential, every session for that account is destroyed.

**`Secure` flag.** `HEDDOHON_COOKIE_SECURE=auto` (the default) turns it on for
`https` requests, when `NODE_ENV=production`, or when the host is not loopback.
The shipped image sets `NODE_ENV=production`, so a deployment reached over plain
http needs `HEDDOHON_COOKIE_SECURE=false`.

**One cookie name is read.** Accepting both names would let a sibling subdomain
plant `heddohon_session` with `Domain=.example.com` and pin a session that
signing out cannot clear. Browsers refuse a `__Host-` cookie with a `Domain`,
which closes that. Switching between the two names signs sessions out once.

## Cross-origin writes

SvelteKit's CSRF check covers form content types only, and every state-changing
call in Heddohon is JSON. An explicit origin check covers them:

- **It applies to every mutating request, on every path.** A check scoped to
  `/api/` was bypassable, because SvelteKit routes on the decoded path:
  `PATCH /%61pi/settings` reached `/api/settings` without matching the prefix.
- **A missing `Origin` is refused.** Browsers always send it on non-GET/HEAD
  requests. Scripted calls need `-H "origin: <your site>"`.

`SameSite=Lax` is a second layer underneath.

## Sign-in throttling

Every sign-in is proxied to the music server from Heddohon's address, so the
upstream's own lockout or fail2ban sees a single client. Heddohon throttles
before the upstream is called.

| Key | Limit | Window |
| --- | --- | --- |
| Username | 10 attempts | 15 minutes |
| Source address | 60 attempts | 15 minutes |

- An attempt is counted before the upstream call and refunded if the call gives
  no verdict, so concurrent requests each pay for their check.
- Only a rejected credential counts. An unreachable server locks nobody out.
- A successful sign-in clears the username counter. Counters live in SQLite and
  survive restarts.
- The username limit expires on its own, so it can slow a guesser without
  keeping a real user out.
- The address counter is skipped when the client address is loopback or RFC1918,
  which is what a proxy on the same host or Docker network looks like. Counting
  there would put every visitor in one bucket. A line is logged when this happens.
- Failures give the same response for an unknown user and a wrong password.

## Proxied media

The upstream reports a content type for covers and audio, and the browser
applies it to a response from Heddohon's origin. A library file described as
`text/html` would run script with full access to the signed-in API. Three
controls prevent that:

- **Constrained type.** Covers must be `image/*` and streams `audio/*`. Anything
  else is sent as `application/octet-stream`, which browsers download.
- **Sandboxed responses.** Every media response carries
  `Content-Security-Policy: default-src 'none'; sandbox`, which leaves `<img>`
  and `<audio>` working and makes a scripted SVG inert if opened directly.
- **Header allowlist.** Only content type, length, range, accept-ranges, etag
  and last-modified are copied. `Content-Disposition` is set by Heddohon. The
  upstream can set no other header.

### Cover cache

Covers are cached under `$HEDDOHON_DATA_DIR/covers` (see
[Configuration](docs/configuration.md#cover-cache)). Audio is never written to disk.

- **Session required.** The cache is read after the session check.
- **Cache key:** backend, viewer, cover id and size. On Subsonic the viewer is a
  constant and one copy serves every account, since Navidrome shows all accounts
  one library. On Jellyfin the viewer is the upstream user id, because Jellyfin
  restricts libraries per user. The viewer is a fixed-width hash, so a crafted
  cover id cannot impersonate another viewer.
- **Stored headers** match the proxy: sandbox CSP, `nosniff`, `inline`
  disposition, and a content type taken from the stored extension. Only five
  raster types are cached; SVGs are proxied each time.
- **Any account can clear it.** Settings shows whether the account is an
  administrator and who a clear affects. The only cost of clearing is that covers
  are fetched upstream again.
- **Cached bytes persist** until swept, cleared or the volume is deleted. Set
  `HEDDOHON_COVER_CACHE_MB=0` to disable it.

## Injection and rendering

- **SQL:** every statement is parameterised.
- **Upstream URLs:** host, port and scheme come from the environment, validated
  at startup against a scheme allowlist. Subsonic ids go through
  `URLSearchParams`. Jellyfin path ids go through `encodeURIComponent` plus a
  guard against `..`, which `encodeURIComponent` leaves intact.
- **Filesystem:** the cover id is the only request value in a path. It is used
  as the filename only if it matches `^[A-Za-z0-9._-]{1,128}$` and is neither
  `.` nor `..`; otherwise the first 32 hex characters of its SHA-256 are used.
  The extension comes from a five-type allowlist.
- **XSS:** the source has no `{@html}`, `innerHTML`, `eval` or `new Function`.
  All music server strings render as escaped text, and every `href` and `src` is
  an app-built relative path.
- **Redirects:** `?next=` is parsed against a placeholder origin and kept only if
  it stays on that origin and its pathname does not start with `//`. The second
  test catches `/.//example.tld`, which normalises to a protocol-relative path.
- **Settings:** rebuilt field by field. Unknown keys are dropped, enums
  allowlisted, numbers clamped and booleans type-checked.
- **Transcoding:** codec and bitrate are read from stored settings. The `mode`
  query parameter only makes the original and transcoded streams distinct URLs
  for the browser cache.

## Input bounds

| Input | Cap |
| --- | --- |
| Request body | 512 KB (`BODY_SIZE_LIMIT`) |
| Track ids per lookup | 1000, each under 256 characters |
| Concurrent upstream calls per fan-out | 8 |
| Songs per playlist write | 1000 |
| Playlist name | 200 characters |
| Saved queue | 1000 ids |
| Page size | 100 |
| Cover size | one of ten, 64 to 1536 |
| Transcode codec | `mp3`, `opus`, `aac` |
| Transcode bitrate | 96, 128, 192, 256, 320 kbps |
| Upstream timeout | 20 s (`HEDDOHON_UPSTREAM_TIMEOUT_MS`) |

## Response headers

Sent on every response, including early 401, 403 and 500 responses:

```
x-content-type-options: nosniff
referrer-policy: same-origin
x-frame-options: SAMEORIGIN
strict-transport-security: max-age=31536000; includeSubDomains
permissions-policy: camera=(), microphone=(), geolocation=(), payment=()
cross-origin-opener-policy: same-origin
cross-origin-resource-policy: same-origin
```

Authenticated pages and private JSON get `Cache-Control: private, no-store` and
`Vary: Cookie`. Unexpected errors return a fixed message and the detail is
logged server-side.

## Container

The image runs as the unprivileged `node` user and is multi-stage, keeping the
build toolchain out of the runtime layer. Secrets are supplied at run time, and
`.dockerignore` excludes `.env`, `.git` and `node_modules`.

## Logging

Logs go to stdout and stderr (see [Configuration](docs/configuration.md#logging)).

- **Default:** failures only.
- **`info`:** adds username and client address on sign-in attempts, for fail2ban.
- **`debug`:** adds path, status and duration for every request. Paths contain
  library ids, so treat a debug log as a listening history.

Passwords, session tokens and upstream query strings are never logged. A
Subsonic URL carries the username, salt and token, so upstream lines log only
the pathname. The end-to-end suite greps a live log for the test password, a
session token and any `u`, `t`, `s` or `p` query parameter.

## Known gaps

**Open issues**

- **No Content-Security-Policy on app pages.** SvelteKit's inline hydration
  scripts need nonces, which belong in framework config. This is the largest
  outstanding item.
- **Upstream redirects are followed** without an address allowlist. A
  compromised music server could point Heddohon at the internal network, and a
  Jellyfin login body would be replayed to the redirect target over a plaintext
  upstream. Requests cannot influence the upstream URL.
- **Redirect responses** lack the hardening headers.
- **Revocation on upstream rejection** covers page loads and media, and five
  JSON endpoints are still missing it.
- **`GET /api/cover/[id]`** writes to the cache and sits outside the origin check.
- **The scrypt salt** is a constant shared by every deployment.
- **A cover that misses the cache** is read into memory before its size is checked.
- **File permissions:** the data directory uses the default umask, and `/app` is
  writable by the `node` user.

**Accepted by design**

- **Library authorization is the upstream's job.** Playlist and favourite actions
  use your upstream credential, so accounts are isolated as far as the music
  server isolates them. Heddohon's own data (settings, queue) is keyed strictly
  on the session's account.
- **Shared Subsonic cover cache** assumes one library per Navidrome server.
- **Per-IP rate limiting belongs at the proxy.** Behind one, set limits there or
  configure adapter-node's `ADDRESS_HEADER` and `XFF_DEPTH`, and only if the
  proxy overwrites that header.
- **`/healthz` is unauthenticated** and shows backend kinds, session lifetime and
  a build id. Restrict it at the proxy if needed.
- **Concurrent streams per account are uncapped.** Cap them at the proxy for wide exposure.
- **Authentication is as strong as the upstream account.** There is no second
  factor, sign-in notification or "sign out everywhere".
- **The database file is unencrypted.** Credentials inside it are sealed;
  usernames, settings and queues are plaintext.
- **`npm audit --omit=dev` under-reports.** SvelteKit is a devDependency bundled
  into `build/`, so audit the built output. Currently affected: `cookie@0.6.0`
  (GHSA-pxg6-pf52-xh8x, low), which needs untrusted cookie names that Heddohon
  never handles.

## Operator checklist

1. **Generate a secret** with `openssl rand -base64 48` (32 characters minimum).
   Changing it signs everyone out.
2. **Set `ORIGIN`** to your public `https://` URL. A wrong value fails closed and
   breaks writes.
3. **Terminate TLS** at the proxy. HSTS is always sent.
4. **Keep the music server private.** Only Heddohon needs to reach it.
5. **Keep the data volume private.** It holds sealed credentials and session digests.
6. **Rate limit and restrict `/healthz`** at the proxy.
7. **Rebuild to update.** Dependencies are pinned by range and the base image is
   a floating tag.

## Audit history

Most reviews were AI-assisted and all were checked by the author. A professional
third-party audit has yet to be done. Findings were reproduced against a running
build before being fixed.

### 14 September 2026

Three parallel source audits plus request-level testing against a running build.
Every fix is covered by the verification suite.

| Severity | Finding | Fix |
| --- | --- | --- |
| Critical | Origin check bypassable with a percent-encoded path | Check applies to every path |
| High | No sign-in rate limiting | Throttling added |
| High | Media proxy relayed upstream content type, allowing HTML from this origin | Type constrained, responses sandboxed |
| Medium | Jellyfin playlist delete could delete any item | Item type verified first |
| Medium | `Secure` flag keyed on `NODE_ENV` alone | Request scheme and host also read |
| Medium | Errors echoed internal detail | Logged server-side |
| Low | Missing `Origin` accepted on writes | Refused |
| Low | Security headers missing from early returns | Added |
| Low | `..` reached a Jellyfin path segment | Id guard |
| Info | Unvalidated sort preference; prototype-chain lookup in theme fallback | Fixed |

Also examined: token generation and storage, key derivation, GCM usage, expiry,
SQL parameterisation, template escaping, header relay, mass assignment, input
bounds, secrets in the bundle and git history, and SSRF from user input.

### 15 September 2026

Four parallel source audits covering the cover cache, transcoding and logging,
each told to verify this file's claims. Every fix is covered by the verification
suite.

| Severity | Finding | Fix |
| --- | --- | --- |
| High | Throttle read before and wrote after the upstream call, so concurrent attempts shared one check | Attempt counted first, refunded without a verdict |
| Medium | `/healthz` returned config errors naming the upstream address and secret length | Detail logged, response generic |
| Medium | Cookie lacked `__Host-`, allowing a sibling subdomain to pin a session | Prefixed when `Secure`, one name read |
| Medium | `Secure` derived from `ORIGIN`, which adapter-node does not require | Derived from scheme, `NODE_ENV` and host |
| Medium | Cover cache ignored Jellyfin per-user library limits | Viewer added to the key |
| Medium | Authenticated responses had no `Cache-Control` or `Vary` | `private, no-store` and `Vary: Cookie` |
| Medium | Shared address bucket behind a proxy let 60 failures block all sign-ins | Applied only to real client addresses |
| Medium | `?next=` accepted `/\example.tld` and `/<TAB>/example.tld` | Parsed and held to this origin |
| Low | Account rows matched case-sensitively | `COLLATE NOCASE` |

Also examined: token entropy, HMAC lookup timing, the 72 hour ceiling against a
client-set `Max-Age`, IV uniqueness, behaviour on an unset, short or changed
secret, the build-time placeholder secret, credential exposure in load returns
and the bundle, all 31 logging call sites, the header allowlist, route gate
bypasses, `null` origin handling, the `size` and `mode` parameters, and cover
cache traversal and key injectivity.

### 17 September 2026

Follow-up review of the 15 September tree. These fixes are not yet in the
verification suite.

| Severity | Finding | Fix |
| --- | --- | --- |
| Medium | `?next=/.//example.tld` (also `/..//`, `/%2e//`) redirected off-site | Pathnames starting with `//` refused, server and client |
| Low | Subsonic `/api/songs` and artist play opened one upstream call per id or album | At most 8 in flight |
| Low | Failed sign-in returned upstream error text to anonymous visitors | Fixed message, detail logged |

Open findings from all three reviews are listed under [Known gaps](#known-gaps).
