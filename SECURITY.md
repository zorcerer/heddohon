# Security

Heddohon is positioned between the public internet and a music server that is
usually deployed on a private network.

This document describes the controls the application implements, the limits of
those controls, and the configuration it expects from the operator. Every claim
in it can be checked against the source.

## Reporting a vulnerability

Please report privately, through GitHub's **Report a vulnerability** button on
the repository's Security tab, rather than opening a public issue. Include what
you did, what happened, and what you expected. A reproduction against a local
instance is more useful than a scanner report.

There is no bounty.

## Threat model

**Assumed hostile.** The public internet; anyone who can reach the login page;
any signed-in account acting against another; the contents of the music library,
including file metadata, cover art and lyrics, which no one audits and anyone
with write access to a shared library can control.

**Assumed semi-trusted.** The upstream music server. It is configured by the
operator and holds the credentials, so it is inside the trust boundary for
*content*, but not for *code*. It does not decide what executes in the browser;
see [Proxied media](#proxied-media).

**Assumed trusted.** The operator, the host, the reverse proxy, and the
environment the container is given.

**Out of scope.** Anyone with shell access to the host or read access to the
data volume. Local encryption protects credentials against a stolen database
file, not against an attacker already running code next to the process that must
decrypt them.

## What the browser is never given

This is the design's first premise. Feishin, Aonsoku and similar clients hand
the browser a direct URL to the music server, which means the browser has to be
able to reach it. A Navidrome on `10.0.0.10` is unreachable once you leave the
network, and the upstream credential ends up in the page.

Heddohon fetches every byte server-side. The browser only ever talks to
Heddohon. The upstream hostname is never serialised into a page, a bundle or an
error message; the credential never leaves the process except as a request to
the music server. The login page is sent only the *label* and *kind* of each
configured server, never its address.

The consequence is that one hostname needs to be exposed, and it is this one.

## Credentials at rest

Upstream credentials are sealed with **AES-256-GCM** before they touch the
database. The key is derived with **scrypt** (N = 2¹⁵, r = 8, p = 1) from
`HEDDOHON_SECRET`, and three separate keys are derived for three separate
purposes: encryption, session digests, and pseudonyms. No key does two jobs.

Each seal gets a fresh 12-byte random IV, and the authentication tag is verified
on open; a tampered or truncated blob fails rather than degrading. The stored
format carries a version prefix and is rejected outright if the part count or
the IV and tag lengths are wrong.

Changing `HEDDOHON_SECRET` makes every stored credential undecryptable, which
signs everyone out and requires a fresh sign-in. That is the intended way to
revoke everything at once.

Subsonic is an exception. Its authentication scheme requires the plaintext
password on every request (`md5(password + per-request salt)`), so the password
itself is what gets sealed. This is a property of the Subsonic protocol.
Jellyfin issues a token at sign-in and discards the password, so a Jellyfin
deployment stores no recoverable password.

## Sessions

The session cookie is a **256-bit opaque random token**. It carries no payload
and asserts nothing; it is a lookup key. There is nothing in it to forge or
tamper with.

The database stores only `HMAC-SHA256(token)`, so a read of the database yields
no usable cookie.

| Property | Value |
| --- | --- |
| Cookie | `__Host-heddohon_session` where the cookie is `Secure`, `heddohon_session` otherwise |
| Flags | `HttpOnly`, `SameSite=Lax`, `Path=/`, host-only, `Secure` (see below) |
| Lifetime | `HEDDOHON_SESSION_HOURS`, default and hard ceiling **72 hours** |
| Extension | None. Activity updates `last_seen_at` and never `expires_at` |

The ceiling is absolute and re-checked on **every** request, not only at
creation. An expired session's row is deleted when it is next presented. Signing
out destroys the server-side record rather than only clearing the cookie, and
every session for an account is destroyed the moment the upstream rejects its
stored credential.

`Secure` is set when `HEDDOHON_COOKIE_SECURE` says so. On `auto`, the default,
it is on when the request arrives over `https`, when `NODE_ENV=production`
(which the shipped image sets), or when the host is not loopback.

An earlier version read `ORIGIN` instead of the request scheme, on the reasoning
that CSRF had already forced the operator to set it. adapter-node does not
require it: with `ORIGIN` unset it derives the origin from the `Host` header and
defaults the scheme to `https`, so an https deployment passed its own
cross-origin check while the cookie went out without `Secure`.

Exactly one cookie name is read, the one the deployment issues. Reading the bare
name as a fallback on an https deployment would leave a sibling origin on the
same registrable domain able to set `heddohon_session` with
`Domain=.example.com`: both cookies then arrive in one `Cookie` header, the
first occurrence wins, and signing in overwrites a different cookie, so the
planted value keeps being used and signing out cannot clear it. The `__Host-`
prefix stops that, because a browser refuses such a cookie with a `Domain`.
Changing between the two names signs existing sessions out once.

## Cross-origin writes

SvelteKit's built-in CSRF check only covers the content types an HTML form can
post. The JSON API is not one of those, and the JSON API is where every
state-changing call lives, including deleting a playlist from the music server.

An explicit check covers it. Two properties of that check are deliberate.

**It applies to every mutating request, with no path condition.** It used to be
scoped to paths beginning `/api/`, which was bypassable: SvelteKit matches
routes against the percent-*decoded* path while the request URL keeps the raw
one, so `PATCH /%61pi/settings` reached the `/api/settings` handler without the
prefix ever matching. Any gate written against a normalised path has the same
shape of hole in it, so there is no gate.

**A missing `Origin` is refused.** Browsers send `Origin` on every non-GET/HEAD
request. Allowing its absence would make the control opt-out for any client able
to suppress the header. The cost is that a scripted `POST` against the API must
send `-H "origin: <your site>"`.

`SameSite=Lax` sits underneath both as a second layer.

## Sign-in throttling

Heddohon proxies every login attempt to the music server, which makes it the
front door to those servers rather than a layer in front of them. Without
throttling, a
public deployment is an unmetered credential-stuffing oracle. The attempt
arrives at the upstream from Heddohon's address, so any fail2ban or lockout the
music server has either does nothing or locks out every legitimate user at
once.

| Key | Limit | Window |
| --- | --- | --- |
| Username | 10 attempts | 15 minutes |
| Source address | 60 attempts | 15 minutes |

Throttled attempts never reach the upstream. An attempt is counted before the
music server is called and handed back if the call did not produce a verdict.
Counting failures afterwards left the read and the write on either side of a
network round trip, so concurrent requests all passed a check none of them had
paid for: 50 at once went through a limit of 10.

Only a *rejected credential* counts. An unreachable music server is not a wrong
guess, so an outage cannot lock anyone out. A successful sign-in clears the
username counter immediately, and the counters live in SQLite, so restarting the
container is not a way to reset them.

The address counter is applied only where the address identifies a visitor.
Behind a reverse proxy with no `ADDRESS_HEADER`, every visitor arrives as the
proxy, and one bucket for the whole deployment means 60 deliberate failures
refuse sign-in to everybody, with no way for a correct password to clear it. A
proxy on the same host or Docker network presents a loopback or RFC1918 address,
and that is the case where the counter is skipped and a line is logged saying
so. A deployment exposed directly sees real addresses and keeps the counter.

The username limit is a throttle rather than a lockout, and expires on its own,
so it cannot be used to keep a real user out. The address limit is deliberately
generous: see [Known gaps](#known-gaps-and-accepted-risks).

Sign-in failures do not distinguish an unknown user from a wrong password.

## Proxied media

Cover art and audio are streamed through the server, which means the upstream
decides what content type the browser is told it is receiving, from *this*
origin. Left alone, that is stored XSS: a single file in the library that the
music server is willing to describe as `text/html` executes script with full
same-origin access to the signed-in API. No compromise of the music server is
required.

Three things prevent it:

- **Type is constrained, not relayed.** Covers may only carry `image/*`, streams
  only `audio/*`. Anything else is served as `application/octet-stream`, which
  browsers download rather than render.
- **Every media response is sandboxed** with `Content-Security-Policy:
  default-src 'none'; sandbox`. Neither an `<img>` nor an `<audio>` executes the
  response, so this costs them nothing, and it makes a scripted SVG inert when
  navigated to directly.
- **Response headers are an allowlist**, not a relay. Seven headers are copied
  (content type, length, range, accept-ranges, etag, last-modified, disposition)
  and everything else is dropped, so an upstream cannot set `Set-Cookie`, cannot
  weaken a CSP, and cannot inject a header at all.

`Content-Disposition` is replaced rather than forwarded: nothing upstream has any
business naming the file the browser saves.

### Cached covers

Cover art is kept on disk under `$HEDDOHON_DATA_DIR/covers` (see
[configuration](docs/configuration.md#cover-cache)). Three consequences:

- **A cached cover still requires a session.** The cache is read after the
  session check, not before it. It holds bytes, not permission.
- **A copy is shared only where every account sees the same library.** The key
  is the backend, the viewer, the music server's cover id and the size. On
  Subsonic the viewer field is a constant, so one cached copy serves every
  account: Navidrome presents one library to all of them. On Jellyfin the field
  is the upstream user id, because Jellyfin restricts libraries per user and a
  cache hit is answered before the upstream is consulted, so a shared key handed
  a restricted library's artwork to any account that could name the item id. The
  backend is part of the key so that a Subsonic id and a Jellyfin id, both
  32-character hex, cannot claim the same file. The viewer field is a
  fixed-width hash, so a cover id cannot be spelled to read as another viewer's.
  Set `HEDDOHON_COVER_CACHE_MB=0` where no cache is wanted.
- **Clearing it is open to any account.** Settings reads the music server's
  administrator flag and states who a clear reaches, including that the account
  is not an administrator where the server says so, and nothing is gated on the
  answer. The flag can be absent (a Subsonic server need not implement
  `getUser`), and what a clear costs is that the next request for each cover
  goes upstream again.
- **The bytes outlive the session.** Artwork stays on the volume until it is
  swept out, cleared from Settings, or the volume is deleted. Audio is never
  written to disk.

A cached response carries the same headers the proxy sets: the sandbox CSP,
`nosniff`, `inline` disposition, and a content type taken from the stored
extension rather than from anything a request supplies. Only the five raster
types in the allowlist are stored, so an SVG is proxied through and never
cached.

## Injection and rendering

- **SQL.** Every statement is a parameterised prepared statement. No request
  value is ever concatenated into SQL.
- **Upstream URLs.** Host, port and scheme come only from the operator's
  environment, validated at startup against a scheme allowlist, and are never
  influenced by a request. Subsonic ids go through `URLSearchParams`; Jellyfin
  path ids through `encodeURIComponent` plus a guard, because
  `encodeURIComponent` does not escape `.` and a bare `..` would otherwise be
  resolved upward into a different endpoint.
- **Filesystem.** One request value reaches a path: the cover id, which names
  the file in the cover cache. It is written into the name only when it matches
  `^[A-Za-z0-9._-]{1,128}$` and is neither `.` nor `..`; every other id, and
  every id containing a separator, is replaced by the first 32 hex characters of
  its SHA-256. A directory is never taken from a request, and the extension is
  chosen from an allowlist of five image types rather than from anything the
  upstream sends. Other than that the only paths built are the data directory,
  the database file and the cache directory, all from the environment.
- **XSS.** There is no `{@html}`, `innerHTML`, `eval`, or `new Function`
  anywhere in the source. Every string from the music server (track titles,
  lyrics, playlist names, artist bios) is rendered as text and escaped by
  Svelte. Every `href` and `src` is an application-built relative path.
- **Redirects.** The only request-derived redirect target is `?next=` after
  sign-in, which must be a single-slash relative path; protocol-relative and
  absolute URLs are rejected.
- **Settings.** The settings object is rebuilt field by field from an explicit
  list. Unknown keys are discarded, enums allowlisted, numbers clamped, booleans
  type-checked. There is no assignment or spread of client input.

## Input bounds

| Input | Cap |
| --- | --- |
| Request body | 512 KB (`BODY_SIZE_LIMIT`) |
| Track ids per lookup | 1000, each under 256 characters |
| Songs per playlist write | 1000 |
| Playlist name | 200 characters |
| Saved queue | 1000 ids |
| Page size | 100 |
| Cover size | one of ten, 64 to 1536 |
| Transcode codec | one of `mp3`, `opus`, `aac` |
| Transcode bitrate | one of 96, 128, 192, 256, 320 kbps |
| Upstream request timeout | 20 s (`HEDDOHON_UPSTREAM_TIMEOUT_MS`) |

## Response headers

Applied to every response, including the 401, the 403 and the configuration 500,
which previously shipped without them:

```
x-content-type-options: nosniff
referrer-policy: same-origin
x-frame-options: SAMEORIGIN
strict-transport-security: max-age=31536000; includeSubDomains
permissions-policy: camera=(), microphone=(), geolocation=(), payment=()
cross-origin-opener-policy: same-origin
cross-origin-resource-policy: same-origin
```

Unexpected errors return a fixed message. The detail may name the data path, the
upstream, or the offending environment variable, so it is logged server-side and
never sent to the client in a production build.

## Container

The image runs as the unprivileged `node` user. It is multi-stage, so the native
build toolchain never reaches the runtime layer. No secret is baked into any
layer: everything is supplied at run time. `.dockerignore` excludes `.env`,
`.git` and `node_modules`.

## Transcoding parameters

The stream endpoint takes a `mode` in its query string, and that value does not
decide anything. What is sent is read from the account's stored settings: the
codec against an allowlist of three, the bitrate against a list of five. The
query parameter exists because a browser caches a stream response per URL, so
the original and a transcode have to be different URLs. Treating it as an
instruction would let a request name the format the music server is asked for,
which is a request-controlled value reaching an upstream URL.

## What the log holds

The server logs to stdout and stderr (see
[configuration](docs/configuration.md#logging)). The default level writes only
failures. `HEDDOHON_LOG_LEVEL=info` adds usernames and the client address on
sign-in attempts, which is what a sign-in log is for and what a fail2ban rule
reads; `debug` adds the path, status and duration of every request.

It does not record passwords, session tokens, or upstream query strings. The
last of those is load-bearing: a Subsonic request carries the account's
username, salt and token as query parameters, so the whole URL is a credential.
Upstream lines log `new URL(url).pathname` and nothing else, and the end-to-end
suite greps a live log for the test password, for a session token, and for any
`?u=`/`?t=`/`?s=`/`?p=` parameter.

Request paths carry library ids, so a log kept at `debug` describes what was
listened to. Treat it as you would any access log.

## Known gaps and accepted risks

These are known limits of the current implementation.

- **No Content-Security-Policy on the application's own pages.** Media responses
  are sandboxed, but the HTML pages are not covered. SvelteKit injects inline
  hydration scripts and needs nonces for this to work, so it belongs in the
  framework configuration rather than a hand-written header. This is the largest
  outstanding item.
- **Per-visitor rate limiting is the reverse proxy's job.** Behind a proxy,
  `getClientAddress()` returns the proxy, so every visitor shares one address
  bucket. That limit is therefore loose, and the username limit does the real
  work. If you want per-IP limits, set them at the proxy, or configure
  adapter-node's `ADDRESS_HEADER` and `XFF_DEPTH` and only if the proxy is
  trusted to overwrite the header.
- **Library authorization is delegated to the upstream.** Heddohon keeps no
  ownership records for playlists or favourites; it performs the action with
  *your* upstream credential and lets the music server decide. Two Heddohon
  accounts on the same upstream are isolated exactly as much as that upstream
  isolates them, and no more. Heddohon's own per-account data (settings, saved
  queue) is keyed strictly on the session's account and is not reachable across
  accounts.
- **`/healthz` is unauthenticated** and discloses the configured backend kinds,
  the session lifetime and a build id. It exists for the container health check;
  restrict it at the proxy if that matters to you.
- **Upstream redirects are followed** without an address allowlist. A compromised
  music server could redirect the server into the internal network. This is not
  reachable by a user, since nothing in a request influences the upstream URL,
  but there is no backstop.
- **No cap on concurrent streams per account.** One signed-in user can open many
  simultaneous proxied streams. Cap it at the proxy if you expose this widely.
- **`npm audit --omit=dev` under-reports.** SvelteKit is a devDependency whose
  runtime is bundled into `build/`, so production advisories against it are
  filtered out by that flag. Audit the built artefact, not the dependency
  classification. Currently in that category: `cookie@0.6.0`
  (GHSA-pxg6-pf52-xh8x, low; it requires untrusted cookie *names*, which this
  application never has).
- **No second factor, no sign-in notification, no "sign out everywhere"
  control.** Authentication is exactly as strong as the upstream account.
- **The database file itself is not encrypted.** Credentials inside it are;
  everything else (usernames, settings, saved queues) is not.

## Operator checklist

1. **Generate a real secret.** `openssl rand -base64 48`. It must be at least 32
   characters. Changing it signs everyone out.
2. **Set `ORIGIN`** to your public `https://` URL. Getting this wrong does not
   open a hole, since cross-origin checks fail closed and writes break loudly,
   but it does break the application.
3. **Terminate TLS** at the proxy. HSTS is sent unconditionally.
4. **Do not expose the music server.** Heddohon reaching it is the point;
   the internet reaching it is not.
5. **Keep the data volume private.** It holds sealed credentials and session
   digests.
6. **Consider rate limiting and blocking `/healthz`** at the proxy.
7. **Rebuild to update.** Dependencies are pinned by range, not by lockfile
   alone, and the base image is a floating tag.

## Audit history

**14 September 2026.** Full review of authentication and cryptography, injection
and authorization, and deployment posture, combining source audit with dynamic
testing against a running instance. The review was AI-assisted: three parallel
source audits, plus request-level testing against a running build. Each finding
below was reproduced against that build before it was fixed. The code has also
been reviewed by the author. It has not been audited by a professional third
party. Every finding below was reproduced
before being fixed, and each is now covered by a regression check in the
verification suite.

| Severity | Finding | Status |
| --- | --- | --- |
| Critical | Cross-origin write check bypassable via a percent-encoded path | Fixed. Check no longer keyed on path |
| High | No rate limiting on sign-in | Fixed. Throttling added |
| High | Media proxy relayed upstream content type, allowing HTML from this origin | Fixed. Type constrained, responses sandboxed |
| Medium | Jellyfin playlist delete was a generic any-item delete | Fixed. Item type verified first |
| Medium | `Secure` cookie flag keyed on `NODE_ENV` alone | Fixed. Keys off the request scheme |
| Medium | Error messages and configuration failures echoed internal detail | Fixed. Logged, not returned |
| Low | Missing `Origin` accepted on writes | Fixed. Now refused |
| Low | Security headers absent from early-return responses | Fixed |
| Low | `..` survived into a Jellyfin path segment | Fixed. Id guard |
| Info | Unvalidated sort preference; prototype-chain lookup in theme fallback | Fixed |

Examined with no finding raised: session token generation and storage, key derivation
and separation, GCM usage and tag verification, expiry handling, SQL
parameterisation, template escaping, upstream header relay, mass assignment,
input bounds, secrets in the client bundle and in git history, and SSRF
reachability from user input.

**15 September 2026.** Second review, covering the same ground plus the code
added since: the cover cache, transcoding and the logging rewrite. Four parallel
source audits, each asked to treat the claims in this file as claims rather than
facts. The findings below were reproduced against a running build, and each is
covered by a check in the verification suite.

| Severity | Finding | Status |
| --- | --- | --- |
| High | Sign-in throttle read the counter before the upstream call and wrote it after, so concurrent attempts all passed one check | Fixed. The attempt is counted first and handed back if no verdict follows |
| Medium | `/healthz` returned the configuration error message, which names the upstream address and the secret's length, to unauthenticated callers | Fixed. The detail is logged, the response says only that there is a fault |
| Medium | Session cookie carried no `__Host-` prefix, so a sibling subdomain could shadow it and pin a session | Fixed. Prefixed wherever the cookie is `Secure`, and one name is read |
| Medium | `Secure` derived from `ORIGIN`, which adapter-node does not require | Fixed. Derived from the request scheme |
| Medium | Cover cache keyed without the viewer, so Jellyfin per-user library limits were not applied to a cache hit | Fixed. The viewer is part of the key on Jellyfin |
| Medium | Authenticated pages and private JSON carried no `Cache-Control` or `Vary` | Fixed. `private, no-store` by default and `Vary: Cookie` |
| Medium | Address rate-limit bucket was shared behind a proxy, so 60 deliberate failures refused sign-in to everybody | Fixed. Applied only where the address identifies a visitor |
| Medium | `?next=` accepted `/\evil.example` and `/<TAB>/evil.example`, which resolve to an external host | Fixed. Parsed and required to stay on this origin |
| Low | Account rows were matched case-sensitively while both upstreams accept any case | Fixed. Matched `COLLATE NOCASE` |

Raised and not fixed, listed so the position is on the record rather than
implied: revocation on upstream rejection covers page loads and media but not
five JSON endpoints, upstream redirects are followed without an address
allowlist (which replays a Jellyfin login body to a redirect target on a
plaintext upstream), redirect responses do not carry the hardening headers,
`GET /api/cover/[id]` writes to the cache and sits outside the origin check, no
Content-Security-Policy is sent, the scrypt salt is a constant shared by every
deployment, and the data directory is left at the default umask.

Examined with no finding raised in this round: token entropy and the CSPRNG
source, HMAC digest storage and the non-exploitability of its lookup timing, the
absolute 72 hour ceiling and its immunity to a client-set `Max-Age`, AES-GCM IV
uniqueness and tag verification, fail-closed behaviour on an unset, short or
changed secret, the build-time placeholder secret being eliminated from the
production bundle, credential exposure in load returns and the client bundle,
all 31 logging call sites, the relayed response header allowlist, percent-encoded
and dot-segment path bypasses of the route gate, the exact-match origin check
including a `null` origin, the `size` and `mode` parameters, cover cache path
traversal and key injectivity, and rate-limit key case and whitespace folding.
