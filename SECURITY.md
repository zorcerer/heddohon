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

Heddohon also contacts a PostgreSQL server when `HEDDOHON_DATABASE_URL` names
one (see [PostgreSQL](#postgresql)). The other hosts it contacts are LRCLIB, only with
`HEDDOHON_LYRICS_LRCLIB=true`, and the AutoEq results on GitHub, only with
`HEDDOHON_AUTOEQ=true`; both are off by default. And the hosts of the internet
radio stations the music server lists, when a listener plays one; that is on
unless `HEDDOHON_RADIO=false`. See [Lyrics from
LRCLIB](#lyrics-from-lrclib), [Headphone corrections from
AutoEq](#headphone-corrections-from-autoeq) and [Internet
radio](#internet-radio).

## PostgreSQL

With `HEDDOHON_DATABASE_URL` set, the database is on a PostgreSQL server
instead of in the data directory. What is stored does not change: credentials
sealed with AES-256-GCM, session and share tokens as HMAC digests, so a dump of
the database or its backups yields neither a working session nor a working link
nor a music-server password.

- **The database password** comes from `HEDDOHON_DATABASE_PASSWORD`, a file
  (`HEDDOHON_DATABASE_PASSWORD_FILE`) or the URL. It is not logged: the startup
  line names `host:port/database`, and configuration errors name the variable
  without its value.
- **Transport.** TLS follows the URL's `sslmode` or `HEDDOHON_DATABASE_SSL`.
  Without it, sealed credentials and token digests cross the network in the
  clear, which still does not expose a usable secret, and settings and queues
  do.
- **Queries** are parameterised as with SQLite. The one place a list is
  interpolated is the import's column list, which is a constant.
- **Own schema.** Tables live in a `heddohon` schema, set as the search path at
  connection start-up. In the default `public` schema of a shared database,
  `CREATE TABLE IF NOT EXISTS` would have adopted another application's
  `accounts` or `settings` table.
- **Unencrypted connections** are reported once at start-up as
  `database-unencrypted`, from `pg_stat_ssl`.
- **Concurrency.** The sign-in throttle is one upsert that locks its row, as on
  SQLite. The share-link ceiling holds an advisory lock on the account while it
  counts and inserts: measured before that, 160 simultaneous creations made
  103 links against a ceiling of 100.
- **Caching.** Sessions and settings are held in memory for 5 seconds, and
  dropped on sign-out, credential change and settings save within the process.
  A counter moved after each of those writes keeps a read that was already in
  flight from caching what it saw, which would otherwise have honoured a
  signed-out session for another 5 seconds.
  Expiry is checked on every request against the held row. A second process
  sharing the database is not supported, and would honour a session ended
  through the first for up to 5 seconds.

## Lyrics from LRCLIB

With `HEDDOHON_LYRICS_LRCLIB=true`, opening the lyrics of a track the music
server has no synced lyrics for makes the server request
`<HEDDOHON_LYRICS_LRCLIB_URL>/api/get` with the track's artist, title, album and
length. That is what LRCLIB learns: which tracks are listened to on this
deployment, from its address. No account name, credential or upstream detail is
sent.

- **Server-side only.** The browser's policy is unchanged; it talks to Heddohon.
- **Bounded.** 5 seconds, 256 KB, redirects refused. A failure reads as "no
  lyrics" and is logged as `lrclib-failed`.
- **Cached in memory**: 500 entries, 24 hours for a hit and 1 hour for a miss,
  so reopening lyrics does not ask again.
- **Treated as text.** The lines are rendered escaped like every other string,
  and the view labels them "LRCLIB".

## Headphone corrections from AutoEq

With `HEDDOHON_AUTOEQ=true`, the server requests two things from
`HEDDOHON_AUTOEQ_URL` (by default the `results` directory of
`jaakkopasanen/AutoEq` on `raw.githubusercontent.com`): `INDEX.md`, once a day,
and the ParametricEQ.txt of each headphone someone chooses in Settings. That is
what the host learns: this server's address, and which headphones were chosen.
No account name, credential or upstream detail is sent.

- **Server-side only.** The browser's policy is unchanged; it talks to Heddohon.
- **Only paths the index lists.** `/api/autoeq/profile?id=` answers 404 for an
  id that is not in the index, without a request upstream. An index entry
  whose path has an empty, `.` or `..` segment is dropped when the index is
  read, from the network or from the data directory.
- **Bounded.** 10 seconds, 4 MB for the index and 16 KB for a profile, 20,000
  entries, redirects refused. A failed index fetch leaves the held copy in
  use and is tried again after 5 minutes; both are logged as `autoeq-failed`.
- **Parsed to numbers.** A profile is returned as a preamp and up to 20
  filters, each a type from three, a frequency from 10 Hz to 24 kHz, a gain
  within 30 dB and a Q from 0.1 to 30. None of the fetched text is passed on.
  The browser checks the same ranges again before building the filters, for a
  profile from the server, from an imported file and from its own storage.
- **Cached.** The index in memory and in `HEDDOHON_DATA_DIR/autoeq-index.json`
  for 24 hours, refreshed with `If-None-Match`; 500 profiles in memory for 24
  hours, a failure for 5 minutes.
- Both routes need a session. Search matches in memory and makes no request
  upstream once the index is held.

## Internet radio

Navidrome keeps a list of internet radio stations, set by its administrators:
a name and the address of a stream on another host. Jellyfin has no such list.
The browser's policy allows media from this origin only, so a station is
played through Heddohon: `GET /api/radio/<id>/stream` fetches the stream and
passes the bytes on. This is the one place the server fetches an address it
was not configured with. `HEDDOHON_RADIO=false` removes the page and the
route.

- **Only a listed station.** The id is looked up in the music server's list
  for the signed-in account. Nothing a request carries is fetched, and the
  stream address is not sent to the browser.
- **http or https only**, without a user name or password in the address.
- **Public addresses only.** A station on a loopback, private, link-local,
  carrier-grade NAT or multicast address is refused, by address and by name:
  every address the host resolves to is checked inside the connection's own
  lookup, and each request dials a connection of its own, so the address
  checked is the address dialled. The IPv6 ranges that carry an IPv4 address
  inside them (IPv4-mapped and IPv4-compatible, NAT64, 6to4, Teredo) are
  refused with them. This is what keeps a station from being used to read a
  service on the server's own network. `HEDDOHON_RADIO_PRIVATE=true` allows
  them, for a stream served on the local network.
- **Redirects** are followed up to three times, each hop held to the same
  rules. An `.m3u` or `.pls` playlist counts as one: up to 64 KB of it is
  read for its first address.
- **Where a hop leads is written by whoever answered it**, not by the music
  server's administrator. With `HEDDOHON_RADIO_PRIVATE=true`, a hop served
  from a public address still leads only to public ones, so a station on the
  internet cannot redirect this server to the network it sits on. Only a hop
  that was itself on a private address may lead to another. Until 0.5.0 the
  setting applied to every hop. CodeQL reports this fetch as server-side
  request forgery (`js/request-forgery`): following a station's redirect is
  a request whose address a remote host chose, which is what the feature
  does, within these rules.
- **Audio only.** A response whose type is not `audio/*` or `application/ogg`
  is dropped unread and answered 502. An HLS playlist is not played.
- **Bounded.** 10 seconds to the first byte, cut after 30 seconds without
  data, 4 streams per account at once. The stream ends with the listener's
  request and with their session.
- **What the station's host learns** is this server's address, not the
  listener's. The request carries no cookie and no account detail.
- **What reaches the browser** is the station's bytes under the type it sent,
  with `X-Content-Type-Options: nosniff` as on every response. A station's own
  page is linked only if it is an http or https address, in a new tab with
  `rel="noopener noreferrer"`.
- Failures are logged as `radio-failed` with the station's id and the reason;
  the browser is told only that the station could not be played.
- Nothing is reported to the music server for a station, it is not added to
  the listening history, and a queue holding one is not saved.

## Linking Last.fm and ListenBrainz

On Navidrome, Settings can link the account to Last.fm and ListenBrainz, which
Navidrome then scrobbles to. The Subsonic API has no call for it, so Heddohon
signs in to Navidrome's own API (`POST /auth/login`, with the stored
password) and calls the endpoints Navidrome's web interface uses
(`/api/lastfm/link`, `/api/listenbrainz/link`). The code is
`src/lib/server/backends/navidrome.ts`. Jellyfin accounts, and Subsonic
servers that are not Navidrome, are shown neither. Last.fm needs Navidrome 0.62.0 or
later, the first to sign the link token it sends through last.fm.

- **Nothing new is stored here.** A ListenBrainz token is sent to Navidrome in
  one request, which checks it with ListenBrainz and stores it. The Last.fm API
  key and secret are Navidrome's configuration; the user grants access on
  last.fm to Navidrome's key.
- **Navidrome session tokens are held in memory** for 30 minutes, keyed by an
  HMAC of the username and password, at most 1000. Navidrome allows 5 sign-ins
  per 20 seconds per client address by default, and every account reaches it
  from Heddohon's address, so a token per request would lock the endpoint.
  A password change misses the cache and signs in afresh. A token Navidrome
  refuses is replaced once.
- **The Last.fm return is a GET that changes state upstream.** last.fm sends
  the browser to `/settings/lastfm` with its token, beside Navidrome's signed
  link token (`uid`, valid 5 minutes, naming the Navidrome user) and a `state`
  that is an HMAC, under its own key, of the Heddohon account and the link
  token. The route is behind the session gate and refuses a `state` that does
  not match the session's account before anything reaches Navidrome, so a
  callback URL sent to another person, or a link token taken from elsewhere,
  links nothing. The session cookie is `SameSite=Lax`, which a top-level
  navigation from last.fm carries.
- **Kept out of the log.** `token`, `uid` and `state` are removed from logged
  paths and queries by `redact`, including inside `next` when the callback is
  sent to sign in first. The upstream call is logged by path only, as every
  upstream call is.
- **The browser is sent to last.fm by the page, not by a redirect.**
  `form-action 'self'` refuses a cross-origin redirect after a form post, and
  the policy is unchanged.
- **These endpoints are Navidrome's interface API**, not a documented one,
  checked against its source on 2026-09-25. A change there shows as the section
  not appearing (`scrobbler-failed` in the log), not as an error elsewhere.

## Credentials at rest

- Upstream credentials are sealed with **AES-256-GCM** before they reach the database.
- Keys are derived with **scrypt** (N = 2¹⁵, r = 8, p = 1) from `HEDDOHON_SECRET`.
  Separate keys cover encryption, session digests, share-link digests,
  known-device cookies and pseudonyms.
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
| Lifetime | `HEDDOHON_SESSION_HOURS`, **30 days** (720 hours) unless set |
| Extension | Activity updates `last_seen_at` only; `expires_at` is fixed at creation |

Expiry is checked on every request, and an expired row is deleted when
presented. A session token copied from a browser works until that expiry, so
the lifetime is also how long a copied token is good for; Settings lists the
account's sessions and ends any of them, and a deployment that wants a shorter
window sets `HEDDOHON_SESSION_HOURS`. Signing out deletes the server-side record. When the upstream rejects
a stored credential, every session for that account is destroyed.

**A reused Jellyfin user name starts a new account.** Accounts are matched by
name. When a Jellyfin sign-in returns a user id other than the one stored for
that name, the earlier user's sessions, links, settings and queue are removed
before the new credential is stored, and `account-user-replaced` is logged.

**A changed Subsonic password ends the other sessions.** Subsonic reports no
user id, so a name given to someone else and a password change look the same.
When a sign-in stores a password other than the one held, the account's
existing sessions are destroyed first and `account-password-changed` is
logged. Links, settings and the queue are kept; see [Known gaps](#known-gaps).

**`Secure` flag.** `HEDDOHON_COOKIE_SECURE=auto` (the default) turns it on for
`https` requests, when `NODE_ENV=production`, or when the host is not loopback.
The shipped image sets `NODE_ENV=production`, so a deployment reached over plain
http needs `HEDDOHON_COOKIE_SECURE=false`.

**Settings lists the account's sessions** that have not expired, most recently
used first: when each signed in and was last used (to the minute), and a label
for the browser, such as "Firefox on Android". The label is the browser's
family and the platform, taken from the `User-Agent` header at sign-in; the
header itself is not stored, and versions and device models are not kept. A
header it does not recognise stores nothing, and the list says "Unknown
browser". A session signed in before the current one can be signed out from
the list, or all of those at once; a browser that signed in later is signed
out from that browser. That keeps a stolen session from signing its owner out
again each time they sign back in, and lets the owner's fresh sign-in end it.
The page names each session by a handle, 16 hex characters of a SHA-256 of the
stored digest, so it holds neither the token nor the digest, and a handle is
matched against the signed-in account's own sessions only: one from another
account, or none at all, ends nothing. Ending a session deletes its row and
cuts any audio or download it is receiving, and the next request from that
browser goes to the sign-in page.

**At most 50 sessions per account.** A sign-in past that ends the account's
oldest session. A correct password is not throttled, so without it any
account holder could add rows without limit.

**Usernames are matched on ASCII case only**, as Navidrome compares them, on
SQLite and PostgreSQL alike. PostgreSQL's `lower()` follows the database
locale, where a name written with the Kelvin sign (U+212A) matched `kate`, so
it is compared under the `"C"` collation.

**Controlling another browser reaches the same account only.** With
`HEDDOHON_REMOTE_CONTROL` on (the default), each signed-in browser with the
player open holds `/api/remote/events` open, and is told the other browsers of
its account: a random id per stream, a browser name ("Firefox on Linux"), and
what each is playing. `POST /api/remote` sends a command (play, pause, skip,
seek, volume, or a queue of up to 1000 track ids) to one of them; the target
is looked up among the signing-in account's own streams, so an id from another
account reaches nothing. `POST /api/remote/state` is taken only from the
session that opened the stream it names. A stream is tied to its session like
audio: signing out, being signed out from Settings and the session expiring end
it. An account holds at most 20 streams. Anyone signed in to the account can
already play and change its queue, so this gives a browser no access it lacked;
it lets one browser of the account start sound on another. The registry is in
the process's memory.

**One cookie name is read.** Accepting both names would let a sibling subdomain
plant `heddohon_session` with `Domain=.example.com` and pin a session that
signing out cannot clear. Browsers refuse a `__Host-` cookie with a `Domain`,
which closes that. Switching between the two names signs sessions out once.

## Shared links

A signed-in account can make a link to one song, one album or one playlist.
Anyone who has the link can listen to it without an account. The link is
`/share/<token>`.
`HEDDOHON_SHARING=false` turns the feature off: new links are refused with a
403, and every route under `/share` answers without resolving the token, so
existing links stop opening. It is read at startup; the restart that applies it
ends any stream in progress. Rows are kept, and open again once it is `true`.

| Property | Value |
| --- | --- |
| Token | 256 random bits, base64url, 43 characters |
| Stored | `HMAC-SHA256(token)` under its own key, the kind (song, album or playlist), its id, the owner and the expiry |
| Lifetime | 1, 7 or 30 days, chosen when the link is made; anything else is refused |
| Live links per account | 100 |
| Withdrawal | The owner, from Settings, one link or all of them; streams in progress through the link are aborted, including one still looking its track up |
| Routes | `/share/<token>` (page), `/share/<token>/stream[/<n>]`, `/share/<token>/cover[/<n>]` |
| Tracks served | An album's or playlist's first 500, by position `<n>` from 0 |

**What a link grants.** The token is a bearer credential for one item: a song,
an album or a playlist. Its holder gets the item's name and artist, and for
each of its tracks the title, artist, album, year, duration and audio format,
the cover and the audio as stored. The routes read the kind and the id from
the row and fetch with the owner's stored credential, inside the process. The
one thing a request names is a track's position, `<n>`: digits only, below
500, looked up in the album or playlist as the owner's account returns it on
that request, so it cannot reach a track outside the item. Anything else in
that place is a 404. No route under `/share` takes an id, a path or a write
from the request, and every mutating method there is refused by the origin
check or answers 405. The owner's credential, the upstream address and the
upstream ids of the item, its tracks, their albums, artists and covers are not
sent to the browser.

**A playlist link is the playlist as its owner has it.** A track the owner adds
or removes, or a new order, is what the link serves from then on: at once for
an edit made in Heddohon, and within five minutes for one made elsewhere (see
below). The share dialog says so. A link without a kind, made before albums
and playlists could be shared, is a song link.

**What a link is to is held for five minutes.** The album, playlist or song is
read with the owner's credential when a link is first used and held in memory
for five minutes per link, so a range request or a track change through the
link does not read a whole playlist from the music server again. Measured
before this: 50 parallel requests for one position in a 5000-entry playlist
made 100 upstream calls and fetched 59.7MB. The token, expiry and withdrawal
are still checked on every request. A change made outside Heddohon, including
a library the owner can no longer see, reaches the link within those five
minutes.

**Only the owner's own playlists.** Navidrome lists another user's public
playlist to every account; a link made to one would publish that user's
playlist, as they edit it, where they cannot see or withdraw it. A link to a
playlist whose owner is someone else is refused with a 403, and one that
changes hands later stops opening. Jellyfin reports no owner and lists only
playlists the account may open.

**Of the kind it names.** On Jellyfin, an album link must name an album, a
playlist link a playlist and a song link a track. An album link made with a
library's id listed every track in the library.

- **`/share` is a public route.** The session gate does not apply under it. A
  path that leaves `/share` after decoding, such as `/share/%2e%2e/api/...`, is
  routed and gated as the path it resolves to.
- **Made only for what its owner can see.** Creating a link looks the song,
  album or playlist up with the owner's credential first, so an arbitrary id
  does not become a row.
- **The owner's account is used for playback.** Upstream, a play through a link
  is a request by the owner's account. Heddohon does not report these plays to
  the music server. The audio is sent as the original file; transcoding
  settings belong to an account and are not applied.
- **Shared media is stricter than an account's.** A body whose type is not
  `audio/*` for the stream or `image/*` for the cover is refused with a 404
  instead of being relayed as a download. A Subsonic server answers
  `stream.view` with a rejected credential by sending its error envelope as a
  200, and that envelope does not reach the visitor. Responses carry the same
  sandbox CSP as other media, with `private, no-store` on audio and
  `private, max-age=300` on covers, so a withdrawn link stops working in the
  browser that played it. Shared covers bypass the cover cache.
- **Every stream request is checked three ways.** The token is resolved, and
  the track is looked up in the owner's song, album or playlist as the owner's
  credential returned it at most five minutes before, so a track the owner can
  no longer see stops playing within that time even where the upstream's audio
  endpoint does not apply library permissions. A stream is registered against
  its link before its track is looked up and aborted when the link is
  withdrawn, and the expiry is checked on each chunk. A browser plays a track as one open-ended
  range, so a check at the start of the request alone let a withdrawn link
  deliver the whole file.
- **Signing out does not withdraw links.** A link plays through the stored
  credential, not a session. Settings has "Withdraw all".
- **Library text is capped at 300 characters** on the page, since it is
  written by whoever can edit the library and served to anyone with a link. It
  is turned into text first, whatever type the music server sent, and the
  audio format is capped at 16.
- **A rejected owner credential reads as unavailable.** The link answers 404 on
  its media and a fixed message on its page. Requests through a link do not
  destroy the owner's sessions; the owner's own next request does that, as
  usual. The link works again once the owner signs in and the stored
  credential is replaced.
- **The owner's username is shown only to signed-in visitors.** Shown to anyone
  with a link, it would publish a username the sign-in page accepts.
- **The token is shown once.** Only the digest is stored, so a copy of the
  database yields no working link. Settings lists links by the song they point
  at and cannot show them again. Titles are not stored with the link; Settings
  looks them up with the owner's credential.
- **One answer for every dead link.** Unknown, malformed, expired and withdrawn
  tokens get the same page and 404 on both media routes. An expired row is
  deleted when presented. A token that is not 43 base64url characters is
  refused before it is digested.
- **Separate from sessions.** The share digest and the session digest use
  different keys, so a session token presented as a share token, or a share
  token presented as a session cookie, matches nothing.
- **Withdrawal is scoped to the owner.** The delete matches on the row id and
  the owner's account together, and another account's id answers 404, the same
  as an unknown one. Creating and withdrawing sit behind the origin check below.
- **Kept out of logs.** Every string field of every log line passes through a
  filter that replaces the segment after `/share/` with `-`, after any extra
  slashes, spaces, quotes or percent signs. It removes
  percent-encoding layer by layer until the text stops changing, and a
  malformed escape does not stop it, so double encoding and a stray `%E0` in
  the same query do not carry a token past it. Error stacks are filtered the
  same way. Share log lines carry the row id and whether the visitor was
  anonymous, signed in or the owner, never the token.
- **Client errors are not written at error level.** A 400 or 405, which an
  anonymous visitor can cause at will under `/share`, is a debug line without
  a stack. Only 5xx responses write an error line and a stack.
- **Kept out of other places.** Pages are sent with `private, no-store` and
  `x-robots-tag: noindex, nofollow`. `referrer-policy: same-origin` keeps the
  path out of the `Referer` header for any other origin, and the page's one
  external link carries `rel="noreferrer"`.

**Not limited.** Opening a link and streaming through it are not rate limited.
Guessing a token means guessing 256 random bits. What a link's holder can do is
fetch that one file as often as they like, which costs the deployment and the
music server bandwidth. Cap it at the proxy for wide exposure, as with
account streams.

A link works for whoever it is forwarded to, for as long as it is live. The
share dialog asks the owner to share only music they have the right to share.

## Cast addresses

A Chromecast or an AirPlay receiver fetches the audio itself and carries no
session cookie. While a browser casts, each track is played from a cast
address, `/cast/<token>`, a public route. What it is limited to:

- **A token names one track, one account and one session.** It is the
  account id, the session's handle, the track id and an expiry, signed with
  HMAC-SHA256 under a key derived for this purpose alone. Changing any part
  fails the signature. Nothing is stored.
- **It lasts 6 hours**, and never past the session's own expiry. The browser
  asks for new ones after 5.
- **It ends with the session.** Each request looks the session up by its
  handle; signing out, being signed out from Settings and the session expiring
  make every address the session was given answer 404, and a stream in
  progress is cut as the browser's own are.
- **Every refusal is the same 404**: malformed, forged, expired, a session
  that has ended, or a track the account cannot play.
- **It is kept out of the log**, as share tokens are (`redact` in `log.ts`).
- **It may be read cross-origin.** The receiver plays it from a page of its
  own on another origin, so a successful answer on this route alone carries
  `Cross-Origin-Resource-Policy: cross-origin` and
  `Access-Control-Allow-Origin: *`. It is sent without credentials, and the
  token in the path is the whole of the authority. Every other response keeps
  `same-origin`.
- **Anyone who holds the address can play that track until it expires or the
  session ends**, the receiver and anything on the network path included. Over
  plain http the address is visible on the network, as the session cookie is.

`POST /api/cast` issues addresses for up to 1000 track ids to a signed-in
browser. It makes no upstream call; an id the account cannot play gets an
address that answers 404.

## Listening together

A signed-in browser can start a live session and hand out its link,
`/together/<token>`, a public route. Anyone with the link hears what the host
plays, as it plays, without an account. What it is limited to:

- **It needs `HEDDOHON_SHARING` and `HEDDOHON_REMOTE_CONTROL` on.** With either
  off, every `/together` route answers 404.
- **The token is 24 random bytes.** Sessions are looked up by an HMAC digest
  of it. The token is held in the process's memory with the session, so the
  host can show the link again, and nothing is written to disk.
- **A listener plays only the track the session is on.** The audio and cover
  routes take `?song=`, and answer 404 for any id but the one the host last
  reported, through the host's account. The file is sent as it is stored.
- **It ends** when the host ends it, after 12 hours, or when the host's session
  ends (signing out, being signed out from Settings, the session expiring). A
  stream in progress is cut with the host's session.
- **Listeners send reactions only.** One of five emoji, from a listener whose
  event stream is open, at most one a second. There are no names or messages.
- **Bounds:** 50 listeners a session, 200 sessions in the process, one per
  host session. The host's reports carry text for the listeners' page
  (title, artist, album, 300 characters each), shown as text.
- **The token is kept out of the log,** as share tokens are.

What a listener learns is what plays and when: title, artist, album, cover
and position, for as long as they hold the link.

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
| Username on one music server, from a browser not known for it | 10 attempts | 15 minutes |
| Source address (an IPv6 address by its /64), from a browser not known for it | 60 attempts | 15 minutes |
| Known device, at the account it is known for | 10 attempts | 15 minutes |

- An attempt is counted before the upstream call and refunded if the call gives
  no verdict, so concurrent requests each pay for their check.
- Only a rejected credential counts. An unreachable server locks nobody out.
- A successful sign-in clears the username or device counter. Counters live in
  SQLite and survive restarts.
- **Per music server.** With both servers configured, `alice` on Navidrome and
  `alice` on Jellyfin have separate counters and separate device cookies, so a
  sign-in to one clears nothing for the other.
- **Known devices.** A successful sign-in leaves a `heddohon_device` cookie
  (`__Host-` where Secure, `HttpOnly`, 180 days): a random id and an HMAC over
  the id, the music server kind, the username and a generation that moves when
  a sign-in stores a new password or a new Jellyfin user under the name, so a
  cookie earned by a previous holder stops counting as known. A browser carrying a valid
  one for the server and username it is signing in as is counted against that
  device alone. Guesses from
  elsewhere run up the username and address counters, which that browser does
  not read, so they cannot lock its owner out. A tampered cookie counts as
  none. A browser that has never signed in as the account is still refused
  while the username is throttled; that is the cost of throttling before the
  upstream is asked.
- Usernames over 256 characters and passwords over 1024 are refused before
  anything is counted, so the throttle table holds no key longer than that.
- The address counter is skipped when the client address is loopback or RFC1918,
  which is what a proxy on the same host or Docker network looks like. Counting
  there would put every visitor in one bucket. A line is logged when this happens.
- Failures give the same response for an unknown user and a wrong password.
- **Username keys are folded as Jellyfin folds them**, upper case then lower,
  so letters it treats as one (σ, ς and Σ) share one counter.

## Proxied media

The upstream reports a content type for covers and audio, and the browser
applies it to a response from Heddohon's origin. A library file described as
`text/html` would run script with full access to the signed-in API. Three
controls prevent that:

- **Constrained type.** The upstream type is reduced to one bare
  `type/subtype`, with no parameters and no second type, and that is what is
  sent. Covers must be `image/*` and streams `audio/*`. Anything else is sent as
  `application/octet-stream`, which browsers download; on a shared link it is
  refused with a 404.
- **Sandboxed responses.** Every media response carries
  `Content-Security-Policy: default-src 'none'; sandbox`, which leaves `<img>`
  and `<audio>` working and makes a scripted SVG inert if opened directly.
- **Header allowlist.** Only content type, length, range, accept-ranges, etag
  and last-modified are copied. `Content-Disposition` is set by Heddohon. The
  upstream can set no other header.
- **Range support is never claimed on the upstream's behalf.** An upstream
  that answers a range with the whole file from byte 0 (Navidrome, while a
  transcode is running) is relayed as a 200 without `Accept-Ranges`, or, for a
  range from further in, as the bytes asked for (`rangeIgnored` in `proxy.ts`).

### Transcodes held in memory

A transcode is read whole from the music server once and answered in ranges
from memory (`transcodes.ts`), so that a dropped stream can be resumed. The
read continues after the request that started it, which makes it a way to
spend the music server's CPU and this process's memory, and it is bounded:

| Bound | Value |
| --- | --- |
| Reads in progress, per account / in all | 2 / 4 |
| Memory held, reads in progress included | 192MB |
| One transcode | 64MB |
| Held after the last request | 15 minutes |

A request past a bound is relayed as it comes, tied to its own connection.
Entries are keyed by account, song, codec and bitrate and dropped with the
account's sessions, so one account is never answered from another's read.

### Downloads

`/api/download/<id>` sends the same bytes as `/api/stream`, untranscoded, with
`Content-Disposition: attachment`. The filename is built from the artist and
title tags, which anyone who can edit the library writes: path separators, the
characters Windows refuses, quotes and every control character (CR and LF
included) are removed, it is cut to 150 characters, and the extension must be 1
to 5 lowercase letters or digits. It is sent twice, as ASCII and as RFC 6266's
UTF-8 form. `HEDDOHON_DOWNLOADS=false` removes the route and the link; it is
not copy protection, since a signed-in browser is sent the file to play it.

### Cover cache

Covers are cached under `$HEDDOHON_DATA_DIR/covers` (see
[Configuration](https://github.com/zorcerer/heddohon/wiki/Configuration#cover-cache)). Audio is never written to disk.

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
- **Only an administrator can fill it.** "Cache every cover" in Settings
  (`POST /api/cover-fill`) reads every album, artist and playlist and has the
  music server render each cover at up to four sizes. It is refused unless the
  music server answers that the account is an administrator, asked on each
  start; a server that does not answer is refused too. One fill runs at a time
  per process, 4 covers at once, and it stops at `HEDDOHON_COVER_CACHE_MB`.
  It runs after its request has been answered, so it holds the account's
  decrypted credential in memory until it ends: the one place a credential
  outlives its request. Stopping it, or `destroyAllSessions` for the account
  (a rejected or changed credential), ends it. On Jellyfin it fills only the
  administrator's own entries, since the key carries the viewer.
- **Kept filled, the server starts a fill itself.** An administrator can switch
  on "Keep it filled" (`PUT /api/cover-fill`, the same gate). The server then
  starts a fill once a day and after a restart, with no request behind it, by
  opening that account's stored credential, as a shared link reads through its
  owner's. It goes on after the account signs out. Each start asks the music
  server again whether the account is an administrator, and switches itself
  off when the answer is no or the account is gone. One account per music
  server holds it, recorded in the `meta` table by account id.
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
| Live share links per account | 100 |
| Share link lifetime | 1, 7 or 30 days |
| Page size | 100 |
| Sign-in username / password | 256 / 1024 characters |
| Any id in a JSON body or a path | under 256 characters |
| Albums read for one play of an artist | 200 |
| Sessions per account | 50; the oldest ends |
| Playlist positions per removal | 1000, deduplicated |
| Star rating | a whole number from 0 to 5 |
| Remote control streams per account | 20 |
| Remote command | one of nine types; a seek from 0 to 86400 s, a volume from 0 to 1, a queue of 1 to 1000 ids |
| Remote state text (title, artist) | 300 characters, cut |
| Cast addresses per request | 1 to 1000 track ids |
| Cast address lifetime | 6 hours, never past the session |
| Listen-together session | 12 hours, never past the host's session; 50 listeners; 200 sessions a process |
| Listen-together reaction | one of five emoji, one a second per listener |
| Genre id in a path | 200 characters; on Jellyfin a GUID, since `GenreIds` takes a list |
| Cover size | one of ten, 64 to 1536 |
| "On this day" date and time zone | a real `YYYY-MM-DD` within a year of the server's; an offset of -720 to 840 minutes |
| Transcode codec | `mp3`, `opus`, `aac` |
| Transcode bitrate | 96, 128, 192, 256, 320 kbps |
| ListenBrainz token | 1 to 128 of `A-Z a-z 0-9 -` (ListenBrainz issues 36) |
| Last.fm callback `uid` / `token` / `state` | 2048 / 256 / 64 characters |
| Upstream timeout | 20 s to headers, and 20 s more for a JSON body (`HEDDOHON_UPSTREAM_TIMEOUT_MS`) |
| Upstream JSON answer | 64 MB, refused while it arrives |

## Response headers

Sent on every response, including early 401, 403 and 500 responses, the files
served from disk (`/_app/*`, `/service-worker.js`, `static/`) and SvelteKit's
own trailing-slash redirects:

```
x-content-type-options: nosniff
referrer-policy: same-origin
x-frame-options: SAMEORIGIN
strict-transport-security: max-age=31536000; includeSubDomains
permissions-policy: camera=(), microphone=(self), geolocation=(), payment=()
cross-origin-opener-policy: same-origin
cross-origin-resource-policy: same-origin
```

adapter-node answers files from disk before any SvelteKit hook runs, so the
build puts a middleware ahead of it that sets the same list
(`hardenedAdapter` in `vite.config.ts`; the values are in
`lib/headers.ts`). `offline.html`, the one HTML file in `static/`,
also gets `default-src 'none'` with its script and its inline stylesheet
allowed from this origin.

`microphone=(self)` lets this origin ask for the microphone, and no frame
from another origin; the app's pages admit no frames at all (`frame-src 'none'`).
Chrome and Edge list audio outputs by name only once a page holds that
permission, and the output control asks for it only when "List outputs" is
pressed. The stream it opens is stopped as soon as it is granted and read by
nothing (`lib/client/output.svelte.ts`).

Authenticated pages and private JSON get `Cache-Control: private, no-store` and
`Vary: Cookie`. Unexpected errors return a fixed message and the detail is
logged server-side. The music server's own error text and the network error
behind an unreachable server (which names its host and port) are logged and
replaced with a fixed message.

App pages carry a Content-Security-Policy, configured in `vite.config.ts` so
that SvelteKit can nonce or hash its own inline bootstrap script:

```
default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline';
style-src-attr 'unsafe-inline'; img-src 'self'; font-src 'self';
media-src 'self'; connect-src 'self'; manifest-src 'self'; worker-src 'self';
object-src 'none'; frame-src 'none'; base-uri 'self'; form-action 'self';
frame-ancestors 'self'
```

Everything the app loads is served from its own origin: the bundles, the two
bundled font families, covers from `/api/cover`, audio from `/api/stream`, and
fetches to `/api/*`. The source carries no external origin, no `data:` or
`blob:` URL.

The one worker is the service worker in `src/service-worker.ts`. It answers a
page load that fails, or a 502 to 504 without the `x-heddohon` header every
Heddohon response carries (a reverse proxy's page for a stopped Heddohon),
with a static offline page, sent with the same headers as any other page. It
passes every other request to the network without reading it, and caches only
the offline page and its script, so no account's data is stored by it. The
audio output saved in the browser is forgotten on the sign-in page.

`style-src-attr` is listed separately because a directive carrying a nonce or a
hash ignores `unsafe-inline`, and SvelteKit adds one to `style-src`. Attributes
are governed by `style-src-attr` when it is present, and nothing adds a nonce
there. Custom properties written onto the document root by
`lib/client/artwork.ts` are unaffected either way, since CSP does not govern
changes made through the CSSOM.

`upgrade-insecure-requests` is absent, because a plain-http deployment is
supported (see `HEDDOHON_COOKIE_SECURE`).

Media responses carry their own stricter policy; see
[Proxied media](#proxied-media).

## Container

The image runs as the unprivileged `node` user and is multi-stage, keeping the
build toolchain out of the runtime layer. Secrets are supplied at run time, and
`.dockerignore` excludes `.env`, `.git` and `node_modules`.

## Logging

Logs go to stdout and stderr, and the same lines to a file a day in
`HEDDOHON_DATA_DIR/logs`, kept for `HEDDOHON_LOG_KEEP_DAYS` days (7 unless set;
`0` writes none). See [Configuration](https://github.com/zorcerer/heddohon/wiki/Configuration#logging).
The files are created with mode 0640 and hold what the level set below puts
in the log, so whoever can read the data directory can read them.

- **Default:** failures only.
- **`info`:** adds username and client address on sign-in attempts, for fail2ban.
- **`debug`:** adds path, status and duration for every request. Paths contain
  library ids, so treat a debug log as a listening history.

Values reach the log from anonymous requests (a username, an `Origin` header).
In either format, control characters, Unicode format characters (bidi
overrides, zero-width characters) and line separators are written as `\uXXXX`
escapes, so a value cannot recolour a terminal, forge a line or display as
something else.

Passwords, session tokens and upstream query strings are never logged. A
Subsonic URL carries the username, salt and token, so upstream lines log only
the pathname. The end-to-end suite greps a live log for the test password, a
session token and any `u`, `t`, `s` or `p` query parameter.

## Known gaps

**Open issues**

- **`style-src-attr` allows `unsafe-inline`.** The page shell and the components
  that size themselves in markup emit `style` attributes, so style attributes
  are admitted unconditionally. Script execution is not affected. Removing it
  means moving those values out of markup and into the stylesheet.

- **Revocation on upstream rejection** covers page loads and media. Twelve JSON
  handlers are still missing it: songs, lyrics, playback, tracks, star, the
  playlist routes and the song lookup before a download. They answer 401 or 502
  and the next page load or media request ends the sessions.
- **A reused Navidrome user name** keeps the earlier user's links, settings
  and queue. If a Subsonic user is deleted and the name given to someone else,
  the earlier user's sessions end when the new user signs in (see
  [Sessions](#sessions)), and the earlier user's links go on playing through
  the new user's credential for any song the new user can see. The Subsonic API
  reports no user id to tell this apart from a password change, where the links
  belong to the same person. Withdraw them from Settings, or with "Withdraw
  all", when a name is reused.
- **Upstream redirects from http to https** are followed to any port on the
  same host, so that Jellyfin's 8096 to 8920 upgrade works.
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
- **A shared link reads through its owner's account.** Its holder needs no
  account and gets one song with the owner's library permissions. That is the
  purpose of a link; see [Shared links](#shared-links) for what it is limited to.
- **Shared Subsonic cover cache** assumes one library per Navidrome server.
- **Suggestion shelves are held for 30 days.** "You might like" on album and
  artist pages is kept per account for 30 days (an hour when empty), so an
  item in a library the account has since lost can stay on a shelf, as a name
  and a cover, until then. Opening it asks the music server, which refuses.
- **A Subsonic playlist is moved by rewriting it.** Subsonic has no move, so
  the playlist is written back whole. A move is refused when the server counts
  more entries than it lists (a missing file, or a library the account cannot
  see, which the rewrite would drop), and one that lost an entry added
  elsewhere in the meantime is reported as a conflict rather than hidden.
- **Per-IP rate limiting belongs at the proxy.** Behind one, set limits there or
  configure adapter-node's `ADDRESS_HEADER` and `XFF_DEPTH`, and only if the
  proxy overwrites that header.
- **`/healthz` is unauthenticated** and shows backend kinds, session lifetime and
  a build id. Restrict it at the proxy if needed.
- **The version is shown to anonymous visitors** on the sign-in page, and in
  `/healthz` as a build id. It tells a visitor which release is running.
- **`/manifest.webmanifest` is unauthenticated**, since browsers fetch it
  without cookies. It returns `HEDDOHON_APP_NAME`, fixed colours, icon paths and
  three shortcut paths.
- **`/.well-known/assetlinks.json` is unauthenticated**, since Android's
  browsers fetch it without cookies. It names the Android app's package and the
  SHA-256 of the certificate the released app is signed with, plus any in
  `HEDDOHON_ANDROID_FINGERPRINTS`. What it grants: an app signed with one of
  those keys may show this origin in the browser without the address bar (a
  Trusted Web Activity). The page still runs in the browser, under its
  policy, with the browser's cookies; the app is given no session and reads
  nothing of the page. Someone holding the release key could publish an app
  that shows a Heddohon server without an address bar, which is what the
  released app does; they could not show another site as this one, since the
  file vouches only for the origin that serves it.
- **Concurrent streams per account are uncapped.** Cap them at the proxy for wide exposure.
- **Authentication is as strong as the upstream account.** There is no second
  factor or sign-in notification. Settings lists the account's sessions and
  signs out any of them, or all but the current one; see [Sessions](#sessions).
- **The database is unencrypted at rest**, whether a SQLite file or PostgreSQL. Credentials inside it are sealed;
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
   With PostgreSQL the same applies to the database and its backups, and the
   connection should use `HEDDOHON_DATABASE_SSL=verify-full` (or `require` on a
   trusted network) when the server is not on the same host.
6. **Rate limit and restrict `/healthz`** at the proxy. The offline page does
   not depend on it.
7. **Rebuild to update.** Dependencies are pinned by range and the base image is
   a floating tag.
8. **Publish the port on loopback behind a proxy** (`127.0.0.1:3000:3000`).
   Docker's port rules pass host firewalls such as ufw.

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

Also examined: token entropy, HMAC lookup timing, the session lifetime against a
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

### 22 September 2026

Content-Security-Policy added to app pages, which was the largest item left open
by the three reviews above. Not yet in the verification suite.

| Severity | Finding | Fix |
| --- | --- | --- |
| Medium | App pages carried no Content-Security-Policy | `default-src 'none'` with same-origin sources, configured in `vite.config.ts` so SvelteKit nonces its own inline bootstrap script |

Checked against a running build: pages, covers and playback load with the policy
enforced. The residual `style-src-attr 'unsafe-inline'` is listed under
[Known gaps](#known-gaps).

### 23 September 2026

Review and request-level testing of shared links, which open without an
account, against a mock upstream with hostile metadata, content types and
headers. Fixed before release; 82 functional and 47 attack checks pass.

| Severity | Finding | Fix |
| --- | --- | --- |
| Medium | A malformed escape after a share token put the raw token in the error log at the default level, through SvelteKit's "Failed to decode URI" message | Every log field and stack filtered; 4xx no longer logged as errors |
| Low | The log filter decoded once, so double encoding or one malformed escape let a token through at debug | Decoded layer by layer, tolerant of bad escapes |
| Low | Anonymous 400 and 405 responses under `/share` each wrote an error line and a stack | Logged at debug |
| Low | Withdrawing or expiring a link did not stop a stream already in progress | Streams registered per link and aborted; expiry checked per chunk |
| Low | The stream route did not check that the owner could still see the song | Song looked up on every stream request |
| Low | `image/png, text/html` passed the media type prefix check | Type reduced to one essence and sent as that |

Follow-up the same day, closing an item left open since 15 September:

| Severity | Finding | Fix |
| --- | --- | --- |
| Medium | Upstream redirects were followed to any address, replaying a Jellyfin login body there and, through shared links, serving the target's body to anonymous visitors | Followed only within the configured origin, or from http to https on the same host, for at most 5 hops; anything else fails and is logged as `upstream-redirect-refused` |
| Low | The two font subsets under 4 KB were inlined as `data:` URLs, which `font-src 'self'` refused | Assets are never inlined |
| Low | Svelte rendered `onload` and `onerror` as inline handler attributes, which `script-src` refused, so a cover that failed before hydration kept its broken image | Listeners attached from script |

Whole-application review the same day, request-level, with a battery kept
beside the functional suites:

| Severity | Finding | Fix |
| --- | --- | --- |
| Medium | Ten wrong guesses from anywhere locked the account's owner out for 15 minutes, repeatably, since the username throttle is checked before the upstream | Known-device cookie: a browser that has signed in as the account is counted on its own |
| Medium | Anonymous sign-in attempts stored their username as a throttle key at any length; a 400 KB username wrote a 400 KB row, without limit behind a proxy | Username 256 and password 1024 characters, checked before counting |
| Low | Terminal escapes and bidi overrides in a username or `Origin` header were written raw to the text log | Control and format characters escaped in both log formats |
| Low | `/api/star`, `/api/playback`, `/api/tracks` and playlist writes forwarded ids of any length upstream; playlist removal took any number of positions | Ids under 256 characters; 1000 positions, deduplicated |
| Low | The session gate's redirects lacked the hardening headers | Answered with them, except client-side data requests, which keep SvelteKit's JSON redirect |
| Low | The player's silent priming sample was a `data:` URL, which `media-src 'self'` refused, so the second audio element was never unlocked for autoplay | Served as `/silence.wav` |
| Low | The LRCLIB client read the whole response before applying its 256 KB cap | Cap applied while the body streams; tested with a 2 MB answer sent without a length |

Held: ten open-redirect spellings of `next`, login CSRF, `null` and look-alike
origins, GET and cross-origin logout, markup in `next`, error pages and search,
a session token with a trailing NUL, forged Quick Connect state, CORS on
OPTIONS, and the hardening headers on 404, 401 and public pages.

Also examined: escaping the gate from `/share` by path normalisation (`..`,
encoded dots and slashes, backslashes, `;`, NUL, double encoding, absolute-form
targets, `__data.json`), methods other than GET and HEAD, ids or paths in the
query, upstream ids and usernames in anonymous HTML and data, HTML, SVG and
error-envelope bodies, relayed `Set-Cookie`, `Location` and CORS headers,
expiry during range requests, cross-account listing and withdrawal, origin
checks on the JSON API and the settings action, the 100-link cap under 160
parallel creates, share and session token interchange, and script in library
text on the share page, its title and Settings.

### 24 September 2026

Source review of the server code and request-level testing of a production
build against mock Subsonic and Jellyfin servers, with both configured. The
suite and the mocks are now kept in the repository under `tests/`; 142 checks
pass, and each fix below has a check that failed before it.

| Severity | Finding | Fix |
| --- | --- | --- |
| Medium | With both servers configured, the username throttle and the known-device cookie were shared by the two accounts of one name, and a sign-in to one reset the counter for guesses at the other | Counters and device signatures carry the server kind |
| Medium | When a music server name passed to a new user, the new credential was stored on the earlier user's row, and the earlier user's sessions and links used it | A changed Jellyfin user id ends the row's sessions and links and clears its settings and queue first. A changed Subsonic password ends the row's sessions; links are listed under [Known gaps](#known-gaps) |
| Low | `/healthz` on an invalid configuration answered without the hardening headers | Hardened |

Re-verified: every fix in the tables above, by request where the suite covers
it and by source otherwise. The revocation gap was found to cover twelve
handlers rather than five, and its entry is corrected.

### 25 September 2026

Source review of every server-side change since the review of 24 September,
before v0.2.0: Last.fm and ListenBrainz linking (the Navidrome session cache,
the settings actions and the `/settings/lastfm` return), range handling and
the transcode buffer in the media proxy, the cover cache's file index and
streamed writes, the favourites sort, the artist, favourites and genre
listings, and `part` on `/api/tracks`. The client changes were checked for
HTML sinks (there are none), the Content-Security-Policy and `hooks.server.ts`
are unchanged, `npm audit --omit=dev` reports nothing, and the whole git
history was searched for committed secrets (none).

| Severity | Finding | Fix |
| --- | --- | --- |
| Medium | A transcode read went on after its request with no limit on reads in progress, so a loop of HEAD requests from a signed-in account started a transcode on the music server and a copy in memory for every song | Reads limited to 2 per account and 4 in all, memory capped with reads in progress counted, 64MB per transcode; past a bound the transcode is relayed |
| Low | A transcode held for an account was not dropped when a music server name passed to a new user, who could be answered from the earlier user's read for 15 minutes | Dropped with the account's sessions |
| Info | `npm audit` lists `cookie` before 0.7.0 inside SvelteKit (GHSA-pxg6-pf52-xh8x): names, paths and domains are not checked for out-of-range characters | Not reachable: every cookie name and path here is fixed. Left for SvelteKit to update |

The Last.fm return was checked against a session from another account, a
changed `state` and no session (refused, redirected to sign-in), and its
query against the log at `debug` (redacted); the suites cover each.

### 28 September 2026

Source review and request-level testing of everything added since the review
of 25 September: links to albums and playlists, the signed-in browsers list,
the album, artist and suggestion caches, instant mix, playlist reordering,
the favourites orders, the offline page, the audio output and its microphone
permission, the settings tabs, and the `:dev` and prune workflows. Five
reviews ran in parallel against a production build with mock Subsonic and
Jellyfin servers, one of them black-box. The PostgreSQL finding was
reproduced on `postgres:16-alpine`. Each fix has a check that failed before it.

| Severity | Finding | Fix |
| --- | --- | --- |
| Medium | Every request through a link read the whole album or playlist from the music server: 50 anonymous requests for one position in a 5000-entry playlist made 100 upstream calls and fetched 59.7MB | What a link is to is held for 5 minutes per link |
| Medium | On PostgreSQL, `lower()` follows the locale, so a user named with a Kelvin sign signed in to `kate`'s account row and took over its settings, queue and links | Names are compared under the `"C"` collation, and the index rebuilt |
| Medium | A Jellyfin artist id the server could not parse left `AlbumArtistIds` empty, so one play of "artist x" read every album and made 4001 upstream calls | Albums, artists and playlists are looked up by id and checked for their type before anything is listed by them |
| Low | On Jellyfin, a link's kind was not checked against the item, so an "album" link to a library published the whole library | The same type checks; `Ids` lookups limited to the ids asked for and to tracks |
| Low | A link withdrawn while its track was being looked up still delivered the file | The stream is registered before the lookup |
| Low | A link could be made to another user's public Navidrome playlist, which then followed that user's edits | Refused unless the account owns the playlist |
| Low | Playing an artist read every album, with no cap, and went on after the browser left; one request could empty every account's details cache | 200 albums, stopped on abort, read past the cache; each cache holds at most a quarter of its bound for one account and sweeps expired entries |
| Low | A request that resolved its session just before a new Jellyfin user took over the name could store the old user's answers for the new one | Cache keys carry the upstream user |
| Low | A Subsonic reorder rewrote the playlist from a list that leaves out missing and hidden entries, deleting them, and lost an entry added in between | Refused when the counts differ; a lost entry is reported |
| Low | The music server's error text, and the network error naming its host and port, reached the browser | Logged, replaced by a fixed message |
| Low | Any account holder could open sessions without limit (300 in 1.5s) | 50 per account, the oldest ending |
| Low | Signing out on a plain-http deployment sent a `Secure` deletion, which the browser ignores | Deleted as it was set |
| Low | A known-device cookie outlived a password change and a reused Jellyfin name | Signed over a generation that moves with them |
| Low | Letters Jellyfin folds together (σ, ς, Σ) split the username throttle | Keys folded as Jellyfin folds them |
| Low | A stolen session could sign its owner out again each time they signed back in | A session ends only sessions that began before it |
| Low | Files served from disk, SvelteKit's trailing-slash redirects and the offline page carried none of the hardening headers | Set ahead of the static file server at build time, and on the offline page by the worker |
| Low | A skipped `:dev` run joined the workflow's concurrency group and cancelled the build in progress; a fork can name its branch `dev` | Concurrency on the job; the head repository is checked |
| Low | The Docker Hub token with delete rights went to every image workflow, whose actions were pinned by tag | Actions pinned by commit; the prune workflow reads its own `DOCKERHUB_PRUNE_TOKEN` |
| Low | The prune workflow went on when a kept image could not be read | The run stops |
| Info | Remote sign-out did not stop a stream in progress; a Quick Connect sign-in left the old session listed; a share token after a stray character reached a debug log; the stored `client_pseudonym` was a User-Agent fingerprint; ids in paths had no length cap; the release workflow did not wait for the suites; `?lastfm=` read the prototype chain; the offline page read `/healthz`, which the checklist advises restricting; the saved audio output outlived signing out; yarn was left in the image | Each fixed as described in the sections above |

### 29 September 2026

Independent source review at `5d92332`: 54 route handlers, five parallel
sweeps, each finding re-verified. Nothing above Low. The PostgreSQL finding was
shown from the source and pg-pool's documented behaviour; no server was run.
The other three have a check that failed before the fix.

| Severity | Finding | Fix |
| --- | --- | --- |
| Low | The PostgreSQL pool had no `'error'` listener (the line had been damaged into a comment), so an idle connection the server dropped ended the process | The listener logs `database-connection-lost` and the pool reconnects on the next query |
| Low | The upstream timeout stopped when headers arrived, so a JSON answer that stalled or never ended was read with no deadline and no size limit | JSON bodies are read under a second `HEDDOHON_UPSTREAM_TIMEOUT_MS` and refused past 64 MB; streams keep no limit after their headers |
| Low | The sign-in address counter was keyed on the full IPv6 address: 300 attempts from one /64 with a new address each were all allowed | IPv6 addresses are counted by their /64, for sign-in and Quick Connect |
| Info | The error page SvelteKit builds when an endpoint fails went out without a Content-Security-Policy; its text is fixed and it has no script | HTML without a policy is given `default-src 'none'` with inline styles only |
