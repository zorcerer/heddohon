# Configuration and deployment

[← back to the README](../README.md)

---

## Running it

### Docker Compose

```bash
cp .env.example .env
# Put a real secret in it:
echo "HEDDOHON_SECRET=$(openssl rand -base64 48)" >> .env
# Point it at your music server(s):
#   HEDDOHON_SUBSONIC_URL=http://10.0.0.10:4533
#   HEDDOHON_JELLYFIN_URL=http://10.0.0.10:8096

docker compose up -d
```

Then open <http://localhost:13000> and sign in with your Navidrome or Jellyfin
account.

### Docker

```bash
docker run -d --name heddohon \
  -p 13000:3000 \
  -v heddohon-data:/data \
  -e HEDDOHON_SECRET="$(openssl rand -base64 48)" \
  -e HEDDOHON_SUBSONIC_URL="http://10.0.0.10:4533" \
  -e ORIGIN="https://music.example.com" \
  heddohon:latest
```

### Unraid

A Community Applications template is in this repository at
`templates/heddohon.xml`, with the repository profile CA reads beside it at
`ca_profile.xml`. Both point at raw URLs on this repository, which have to
resolve without a login for CA to render the icon and the readme.

Three settings are worth getting right before the first start: `HEDDOHON_SECRET`,
at least one music-server URL (resolved by the container, so a LAN address is
the right answer), and `ORIGIN` if you reach it through a reverse proxy.

The image runs as the unprivileged `node` user, UID 1000, while Unraid's appdata
is owned by nobody:users, 99:100. The template runs the container as 99:100 for
that reason. Remove `--user 99:100` from Extra Parameters to keep the image's own
user, and `chown -R 1000:1000 /mnt/user/appdata/heddohon` before starting it.

### Behind a reverse proxy

Set `ORIGIN` to the public URL or form submissions will be rejected by the CSRF
origin check. Caddy, for example:

```caddy
music.example.com {
	reverse_proxy heddohon:3000
}
```

Audio is streamed through the proxy, so allow long-lived responses and do not
buffer whole responses to disk. In nginx that means:

```nginx
proxy_buffering off;
proxy_request_buffering off;
proxy_read_timeout 3600s;
```

### From source

```bash
npm install
npm run dev     # development
npm run build && npm start   # production
```

---

## Environment variables

| Variable | Required | Default | Meaning |
| --- | --- | --- | --- |
| `HEDDOHON_SECRET` | **yes** | none | Encrypts stored credentials and derives session keys. Minimum 32 characters. |
| `HEDDOHON_SUBSONIC_URL` | one of | none | Navidrome / Subsonic base URL. `HEDDOHON_NAVIDROME_URL` is accepted as an alias. |
| `HEDDOHON_JELLYFIN_URL` | one of | none | Jellyfin base URL. |
| `HEDDOHON_SUBSONIC_LABEL` | no | `Navidrome` | Name shown on the sign-in screen. |
| `HEDDOHON_JELLYFIN_LABEL` | no | `Jellyfin` | Name shown on the sign-in screen. |
| `HEDDOHON_SESSION_HOURS` | no | `72` | Session lifetime. Clamped to 72. |
| `HEDDOHON_DATA_DIR` | no | `/data` | Where the SQLite database and the cover cache live. |
| `HEDDOHON_COOKIE_SECURE` | no | `auto` | `auto` sets Secure when the request arrives over https, when `NODE_ENV=production`, or when the host is not loopback. The Docker image sets `NODE_ENV=production`, so there `auto` is always Secure and a deployment reached over plain http needs `false`. The cookie is named `__Host-heddohon_session` wherever it is Secure. |
| `HEDDOHON_UPSTREAM_TIMEOUT_MS` | no | `20000` | Give-up time for music-server calls. |
| `HEDDOHON_COVER_CACHE_MB` | no | `512` | Disk budget for cached cover art, in megabytes. `0` switches the cache off. |
| `HEDDOHON_LOG_LEVEL` | no | `error` | `error`, `warn`, `info` or `debug`. |
| `HEDDOHON_LOG_FORMAT` | no | `text` | `json` emits one object per line instead. |
| `HEDDOHON_LOG_SLOW_MS` | no | `2000` | Requests at or above this are logged as `request-slow`. `0` disables that. |
| `HEDDOHON_APP_NAME` | no | `Heddohon` | Branding on the sign-in screen and sidebar. |
| `HEDDOHON_LOGIN_HINT` | no | none | Optional line of text on the sign-in screen. |
| `ORIGIN` | behind a proxy | none | Public URL, for CSRF origin checking. |
| `PORT` / `HOST` | no | `3000` / `0.0.0.0` | Listen address. |

`GET /healthz` reports configuration validity without revealing the upstream
URLs, and is wired up as the container's `HEALTHCHECK`.

## Cover cache

Cover art is written to `$HEDDOHON_DATA_DIR/covers` the first time it is
fetched, and served from there afterwards. Files are named for the backend, the
music server's own cover id and the size requested,
`subsonic-f4a1b2c3-256.jpg`, so the directory can be read and pruned with
ordinary tools.

Measured against a music server that takes 180ms to render a cover: a cold
request takes 190ms and a cached one 4ms, and a 62-cover page that has never
been opened on this browser goes from 1365ms to 776ms.

Once the directory passes `HEDDOHON_COVER_CACHE_MB`, the least recently used
files are deleted until it is back under. The check runs after every
`HEDDOHON_COVER_CACHE_MB / 16` megabytes written, so the directory can sit that
much above the budget between sweeps. Covers over 8MB are served but not
stored.

Settings shows what the cache holds, who it reaches, and has a button that
empties it. Anyone signed in can clear it: the files are the music server's
artwork rather than anything belonging to one account, and one copy is shared by
everyone signed in to that server. Nothing is lost by clearing it, and the next
request for each cover fetches it again.

The music server's own administrator flag is read when the page loads, from
`getUser` on a Subsonic server and from the user record on Jellyfin, and is used
to say so where the account is not an administrator. It does not decide whether
the button is there. A Subsonic server need not implement `getUser`, and a
server that does may refuse it; gating on an answer that can be absent would
lock an operator out of a button on their own instance, to protect against an
action whose whole cost is that some covers are fetched once more.

## Logging

The process writes to stdout and stderr and nothing else: no files, no
rotation. Whatever runs the container decides where that goes, which is what
`docker logs`, journald and every process supervisor already expect. Warnings
and errors go to stderr, the rest to stdout.

The default is the lightest setting there is: a server that is working writes
nothing at all. Raise it for more.

| Set this | And you also get |
| --- | --- |
| `error` (default) | Failures only. A quiet log is a working server. |
| `warn` | Refused cross-origin writes, rejected and throttled sign-ins, upstream timeouts, requests over `HEDDOHON_LOG_SLOW_MS`. |
| `info` | What the server started with, who signed in, cover cache clears and sweeps. |
| `debug` | A line per request, a line per call to the music server with its timing, and cover cache hits and misses. |

Each line is a timestamp, a level, an event name, then `key=value` pairs:

```
2026-09-14T23:39:34.873Z info  started build=1789429163439 node=22.22.2 logLevel=info data=/data covers=512MB sessionHours=72 upstreams="subsonic=10.0.0.10:4533"
2026-09-14T23:39:35.277Z info  signed-in username=alice backend=subsonic address=10.0.0.5
2026-09-14T23:41:02.113Z warn  sign-in-rejected username=bob backend=subsonic address=10.0.0.9 kind=auth
```

The events at each level, by name:

| Level | Events |
| --- | --- |
| `error` | `request` at 5xx or thrown, `unhandled` with a stack, `config-invalid`, `sign-in-failed` |
| `warn` | `request-slow`, `cross-origin-blocked`, `sign-in-rejected`, `sign-in-throttled`, `sessions-destroyed`, `upstream-timeout`, `upstream-unreachable`, `section-failed`, `cover-write-failed` |
| `info` | `started`, `signed-in`, `cover-cache-cleared`, `cover-cache-swept` |
| `debug` | `request` (one per request, with its path, status and duration), `upstream` (one per music-server call, with its time), `cover-hit`, `cover-miss`, `cover-stored`, `unauthenticated` |

### Working out why something is slow

`HEDDOHON_LOG_LEVEL=debug` times every call to the music server separately from
the request around it, and says whether each cover came from the cache or from
upstream. Every line written while handling one request carries the same `req`
id, so they can be read together:

```
debug upstream path=/rest/getAlbum.view status=200 ms=18 user=alice req=99dabdad
debug upstream path=/rest/getSimilarSongs2.view status=200 ms=35 user=alice req=99dabdad
debug request method=GET path=/albums/al1 status=200 ms=301 user=alice req=99dabdad
```

Upstream lines for one request can appear *after* its request line. The album
page streams its shelves, so the response begins before those calls finish.

Turn it off again afterwards. Measured against this build, warmed: 895 requests
per second for a cached cover at the default level and 760 at `debug`, and 189
per second for a library page against 169. A library page opens dozens of covers
at once, so that 15% is paid dozens of times over. Nothing but the id is carried
per request at the default level, and the request context that ties those lines
together is not established at all.

At `info` the log records usernames and the client address on sign-in
attempts, and request paths only for a request that failed or was slow.
It never records a password, a session token, or an upstream query string: a
Subsonic request carries the account's token and salt as query parameters, so
upstream lines log the path alone.

## Recommendations

An album page carries two shelves under its track list. The first, "More from
<artist>", is the rest of that artist's catalogue, read straight out of the
library, and needs nothing configured. The second, "You might like", and the
one under an artist, are whatever the music server answers when asked what is
similar, so what they need is configured there rather than here. The artist's
own records are excluded from the suggestions, since they are in the shelf
above.

**Navidrome and other Subsonic servers.** Heddohon reads `similarArtist` from
`getArtistInfo2` on an artist page, and `getSimilarSongs2` on an album page,
grouping the tracks that come back into the albums they belong to. Navidrome
fills both from Last.fm, and Last.fm needs an API key that Navidrome does not
ship with. Without `ND_LASTFM_APIKEY` and `ND_LASTFM_SECRET` set, both
endpoints return nothing, and Heddohon renders no shelf rather than an empty
one. A key is free from <https://www.last.fm/api/account/create>. Artist
biographies come from the same place, so a Navidrome with no key shows no
biography either.

**Jellyfin.** `/Artists/{id}/Similar` and `/Albums/{id}/Similar` are computed
by Jellyfin from its own metadata (genres, tags, people). No external service
and no extra configuration.

Nothing is computed by Heddohon. An empty shelf means the server returned
nothing, and the server log records the call if it failed outright.
