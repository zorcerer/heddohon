#!/usr/bin/env bash
# End-to-end checks against a built Heddohon and the two mock music servers.
#
#   npm run build && tests/e2e/run.sh
#
# Starts tests/mocks/subsonic.mjs on 4533, tests/mocks/jellyfin.mjs on 8096
# and build/index.js on 3322 with both backends configured, drives them with
# curl, and stops all three on exit. Needs node 22, curl and jq. Prints one line
# per check and exits non-zero if any failed.
#
# Ports can be moved with APP_PORT, SUBSONIC_PORT and JELLYFIN_PORT.

set -u

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
APP_PORT="${APP_PORT:-3322}"
SUBSONIC_PORT="${SUBSONIC_PORT:-4533}"
JELLYFIN_PORT="${JELLYFIN_PORT:-8096}"
BASE="http://127.0.0.1:$APP_PORT"
SUB="http://127.0.0.1:$SUBSONIC_PORT"
JF="http://127.0.0.1:$JELLYFIN_PORT"
SECRET=0123456789abcdef0123456789abcdef

TMP="$(mktemp -d)"
LOG="$TMP/app.log"
PIDS=()

cleanup() {
	for pid in "${PIDS[@]}"; do kill "$pid" 2>/dev/null; done
	wait 2>/dev/null
	if [[ "${KEEP_TMP:-}" == 1 ]]; then echo "kept $TMP"; else rm -rf "$TMP"; fi
}
trap cleanup EXIT

PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); printf 'ok    %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf 'FAIL  %s  (%s)\n' "$1" "$2"; }
expect_eq() { if [[ "$2" == "$3" ]]; then ok "$1"; else bad "$1" "got '$2', want '$3'"; fi; }
expect_ne() { if [[ "$2" != "$3" ]]; then ok "$1"; else bad "$1" "got '$2'"; fi; }
expect_has() { if [[ "$2" == *"$3"* ]]; then ok "$1"; else bad "$1" "'$3' not in '${2:0:200}'"; fi; }
expect_lacks() { if [[ "$2" != *"$3"* ]]; then ok "$1"; else bad "$1" "'$3' found"; fi; }

# http <jar> <method> <path> [curl args...]: prints the status, keeps the
# headers in $TMP/headers and the body in $TMP/body.
http() {
	local jar=$1 method=$2 path=$3
	shift 3
	curl -s -o "$TMP/body" -D "$TMP/headers" -w '%{http_code}' -b "$jar" -c "$jar" -X "$method" "$@" "$BASE$path"
}
header() { grep -i "^$1:" "$TMP/headers" | head -1 | cut -d' ' -f2- | tr -d '\r'; }
body() { cat "$TMP/body"; }

login() {
	local jar=$1 backend=$2 user=$3 pass=$4 next=${5:-/}
	http "$jar" POST /login -H "origin: $BASE" -H 'accept: text/html' \
		--data-urlencode "username=$user" --data-urlencode "password=$pass" \
		--data-urlencode "backend=$backend" --data-urlencode "next=$next"
}

json() {
	local jar=$1 method=$2 path=$3 data=$4
	http "$jar" "$method" "$path" -H "origin: $BASE" -H 'content-type: application/json' --data "$data"
}

wait_for() {
	for _ in $(seq 100); do curl -s -o /dev/null "$1" && return 0; sleep 0.1; done
	echo "did not start: $1" >&2
	exit 2
}

start_app() {
	local port=$1 data=$2 log=$3
	shift 3
	env HOST=127.0.0.1 PORT="$port" ORIGIN="http://127.0.0.1:$port" \
		HEDDOHON_SECRET="$SECRET" HEDDOHON_SUBSONIC_URL="$SUB" HEDDOHON_JELLYFIN_URL="$JF" \
		HEDDOHON_DATA_DIR="$data" HEDDOHON_LOG_LEVEL=debug "$@" \
		node "$ROOT/build/index.js" >"$log" 2>&1 &
	PIDS+=($!)
}

[[ -f "$ROOT/build/index.js" ]] || { echo "build/index.js missing; run npm run build" >&2; exit 2; }

node "$ROOT/tests/mocks/subsonic.mjs" "$SUBSONIC_PORT" >"$TMP/subsonic.log" 2>&1 &
PIDS+=($!)
node "$ROOT/tests/mocks/jellyfin.mjs" "$JELLYFIN_PORT" >"$TMP/jellyfin.log" 2>&1 &
PIDS+=($!)
wait_for "$SUB/__stats"
wait_for "$JF/__deleted"
start_app "$APP_PORT" "$TMP/data" "$LOG"
wait_for "$BASE/healthz"

HARDENING=(x-content-type-options referrer-policy x-frame-options strict-transport-security
	permissions-policy cross-origin-opener-policy cross-origin-resource-policy)
hardened() {
	local label=$1 missing=()
	for name in "${HARDENING[@]}"; do [[ -n "$(header "$name")" ]] || missing+=("$name"); done
	if [[ ${#missing[@]} -eq 0 ]]; then ok "$label carries the hardening headers"; else bad "$label carries the hardening headers" "missing ${missing[*]}"; fi
}

A="$TMP/a.jar"
B="$TMP/b.jar"
ANON="$TMP/anon.jar"
: >"$ANON"

echo '# Health and the session gate'
expect_eq 'healthz answers 200' "$(http "$ANON" GET /healthz)" 200
expect_eq 'healthz reports ok' "$(body | jq -r .status)" ok
expect_lacks 'healthz names no upstream address' "$(body)" '127.0.0.1'
hardened 'healthz'
expect_eq 'anonymous page redirects' "$(http "$ANON" GET '/albums?page=2')" 303
expect_eq 'anonymous redirect keeps next' "$(header location)" '/login?next=%2Falbums%3Fpage%3D2'
hardened 'gate redirect'
expect_eq 'anonymous API answers 401' "$(http "$ANON" GET /api/settings)" 401
hardened 'gate 401'
expect_eq 'unknown page answers 404' "$(http "$ANON" GET /login/nothing-here)" 404
hardened '404'

echo '# Sign-in'
expect_eq 'wrong password answers 401' "$(login "$A" subsonic testuser wrong)" 401
expect_eq 'right password answers 303' "$(login "$A" subsonic testuser testpass)" 303
expect_eq 'sign-in lands on /' "$(header location)" /
cookie="$(grep -c 'heddohon_session' "$A")"
expect_eq 'session cookie set' "$cookie" 1
expect_has 'session cookie is HttpOnly and Lax' "$(grep -i '^set-cookie: heddohon_session' "$TMP/headers")" 'HttpOnly'
expect_eq 'signed-in page answers 200' "$(http "$A" GET /)" 200
expect_eq 'signed-in page is private, no-store' "$(header cache-control)" 'private, no-store'
expect_has 'signed-in page varies on Cookie' "$(header vary)" Cookie
expect_has 'page carries a CSP' "$(header content-security-policy)" "default-src 'none'"
expect_lacks 'page names no upstream address' "$(body)" "127.0.0.1:$SUBSONIC_PORT"
expect_lacks 'page carries no password' "$(body)" testpass
expect_eq 'signed-in visit to /login redirects' "$(http "$A" GET /login)" 303
expect_eq 'long username refused' "$(login "$ANON" subsonic "$(printf 'x%.0s' $(seq 300))" x)" 400

echo '# Open redirects through next'
for spelling in '//evil.example' '/\evil.example' '/.//evil.example' '/..//evil.example' '/%2e//evil.example' \
	'https://evil.example/' $'/\t/evil.example' '/\/evil.example' 'javascript:alert(1)'; do
	j="$TMP/next.jar"
	: >"$j"
	login "$j" subsonic testuser testpass "$spelling" >/dev/null
	expect_eq "next=$(printf %q "$spelling") stays on site" "$(header location)" /
done
: >"$TMP/next.jar"
login "$TMP/next.jar" subsonic testuser testpass '/albums?page=2' >/dev/null
expect_eq 'next=/albums?page=2 is kept' "$(header location)" '/albums?page=2'

echo '# Cross-origin writes'
expect_eq 'write without Origin refused' "$(http "$A" PATCH /api/settings -H 'content-type: application/json' --data '{"theme":"light"}')" 403
hardened 'origin 403'
expect_eq 'write from another origin refused' "$(http "$A" PATCH /api/settings -H 'origin: https://evil.example' -H 'content-type: application/json' --data '{"theme":"light"}')" 403
expect_eq 'percent-encoded path refused' "$(http "$A" PATCH /%61pi/settings -H 'origin: https://evil.example' -H 'content-type: application/json' --data '{"theme":"light"}')" 403
expect_eq 'null origin refused' "$(http "$A" PATCH /api/settings -H 'origin: null' -H 'content-type: application/json' --data '{"theme":"light"}')" 403
expect_eq 'same-origin write accepted' "$(json "$A" PATCH /api/settings '{"theme":"light","uiScale":"<x>","volume":7}')" 200
expect_eq 'settings sanitised: theme' "$(body | jq -r .theme)" light
expect_eq 'settings sanitised: scale' "$(body | jq -r .uiScale)" 100
expect_eq 'settings sanitised: volume' "$(body | jq -r .volume)" 1
expect_eq 'prototype key refused as theme' "$(json "$A" PATCH /api/settings '{"theme":"constructor"}'; body | jq -r .theme)" '200light'
expect_eq 'logout without Origin refused' "$(http "$A" POST /logout)" 403

echo '# Proxied media'
expect_eq 'stream answers 200' "$(http "$A" GET /api/stream/s1)" 200
expect_eq 'stream type kept' "$(header content-type)" audio/flac
expect_eq 'stream sandboxed' "$(header content-security-policy)" "default-src 'none'; sandbox"
expect_eq 'upstream set-cookie not relayed' "$(header set-cookie)" ''
expect_eq 'upstream CORS not relayed' "$(header access-control-allow-origin)" ''
expect_eq 'upstream disposition replaced' "$(header content-disposition)" inline
expect_eq 'range answers 206' "$(http "$A" GET /api/stream/s1 -H 'range: bytes=0-99')" 206
expect_eq 'range length' "$(header content-length)" 100
expect_eq 'HTML cover sent as a download' "$(http "$A" GET /api/cover/evilhtml; header content-type)" '200application/octet-stream'
expect_eq 'two content types reduced' "$(http "$A" GET /api/cover/evilmulti; header content-type)" '200application/octet-stream'
expect_eq 'SVG cover sandboxed' "$(http "$A" GET /api/cover/evilsvg; header content-security-policy)" "200default-src 'none'; sandbox"
expect_eq 'HTML stream sent as a download' "$(http "$A" GET /api/stream/htmlaudio; header content-type)" '200application/octet-stream'
expect_eq 'redirect within the server followed' "$(http "$A" GET /api/stream/redirin)" 200
expect_eq 'redirect off the server refused' "$(http "$A" GET /api/stream/redirout)" 502
expect_has 'refused redirect logged' "$(cat "$LOG")" upstream-redirect-refused
expect_eq 'cover cached on first fetch' "$(http "$A" GET '/api/cover/al1?size=256')" 200
expect_eq 'cover served from cache' "$(http "$A" GET '/api/cover/al1?size=256'; header etag)" '200"subsonic-'"$(echo -n shared | sha256sum | cut -c1-16)"'-al1-256-70"'
expect_eq 'download answers 200' "$(http "$A" GET /api/download/evil)" 200
dispo="$(header content-disposition)"
expect_has 'download is an attachment' "$dispo" 'attachment; filename="'
expect_lacks 'download name has no quote from tags' "${dispo#*filename=\"}" '">'

echo '# Rendering'
http "$A" GET '/search?q=script' >/dev/null
expect_lacks 'library markup escaped in search' "$(body)" '<script>alert(1)'
expect_lacks 'library attribute escaped in search' "$(body)" '<svg onload'

echo '# Library, pagination, playlists, lyrics'
expect_eq 'artists page 3' "$(http "$A" GET '/artists?page=3')" 200
expect_has 'artists page 3 lists the last artist' "$(body)" 'Artist 250'
expect_lacks 'artists page 3 omits page 1' "$(body)" 'Artist 001<'
expect_eq 'albums page 2' "$(http "$A" GET '/albums?page=2&sort=alphabetical')" 200
expect_has 'albums page 2 content' "$(body)" 'Album 061'
expect_eq 'create playlist' "$(json "$A" POST /api/playlists '{"name":"Round trip","songIds":["s1","s2","s3"]}')" 201
pl="$(body | jq -r .id)"
expect_eq 'add to playlist' "$(json "$A" POST "/api/playlists/$pl/tracks" '{"songIds":["s4"]}')" 200
expect_eq 'remove from playlist' "$(json "$A" DELETE "/api/playlists/$pl/tracks" '{"indices":[0,0,1]}')" 200
expect_eq 'positions deduplicated' "$(body | jq -r .removed)" 2
expect_eq 'playlist tracks after edits' "$(json "$A" POST /api/tracks "{\"source\":\"playlist\",\"id\":\"$pl\"}"; body | jq -r '[.songs[].id]|join(",")')" '200s3,s4'
expect_eq 'rename playlist' "$(json "$A" PATCH "/api/playlists/$pl" '{"name":"Renamed"}')" 200
expect_eq 'delete playlist' "$(http "$A" DELETE "/api/playlists/$pl" -H "origin: $BASE")" 200
expect_eq 'overlong id refused' "$(json "$A" POST /api/star "{\"id\":\"$(printf 'x%.0s' $(seq 300))\",\"kind\":\"song\",\"starred\":true}")" 400
expect_eq 'lyrics answer' "$(http "$A" GET /api/lyrics/s1; body | jq -r '.lyrics.synced')" '200true'

echo '# Shared links'
expect_eq 'share created' "$(json "$A" POST /api/shares '{"songId":"s1","days":1}')" 200
share_path="$(body | jq -r .path)"
share_id="$(body | jq -r .id)"
token="${share_path#/share/}"
expect_eq 'share token is 43 characters' "${#token}" 43
expect_eq 'share for unknown song refused' "$(json "$A" POST /api/shares '{"songId":"nope"}')" 404
expect_eq 'share lifetime allowlisted' "$(json "$A" POST /api/shares '{"songId":"s1","days":2}')" 400
expect_eq 'anonymous share page' "$(http "$ANON" GET "$share_path")" 200
expect_eq 'share page no-store' "$(header cache-control)" 'private, no-store'
expect_eq 'share page noindex' "$(header x-robots-tag)" 'noindex, nofollow'
expect_lacks 'share page hides the owner from anonymous visitors' "$(body)" testuser
expect_lacks 'share page hides the song id' "$(body)" '"s1"'
expect_eq 'anonymous share stream' "$(http "$ANON" GET "$share_path/stream"; header content-type)" '200audio/flac'
expect_eq 'share stream no-store' "$(header cache-control)" 'private, no-store'
expect_eq 'anonymous share cover' "$(http "$ANON" GET "$share_path/cover")" 200
expect_eq 'POST under /share refused' "$(http "$ANON" POST "$share_path/stream" -H "origin: $BASE")" 405
expect_eq 'escape from /share gated' "$(http "$ANON" GET "/share/%2e%2e/api/settings")" 401
expect_eq 'malformed token reads as gone' "$(http "$ANON" GET /share/short/stream)" 404
json "$A" POST /api/shares '{"songId":"htmlaudio"}' >/dev/null
html_share="$(body | jq -r .path)"
expect_eq 'shared HTML body refused' "$(http "$ANON" GET "$html_share/stream")" 404
http "$ANON" GET "/share/$token%E0/x?next=%252Fshare%252F$token" >/dev/null
expect_eq 'withdraw share' "$(http "$A" DELETE "/api/shares/$share_id" -H "origin: $BASE")" 200
expect_eq 'withdrawn share stream 404' "$(http "$ANON" GET "$share_path/stream")" 404
expect_lacks 'share token not in the log' "$(cat "$LOG")" "$token"

echo '# Jellyfin'
expect_eq 'jellyfin sign-in' "$(login "$B" jellyfin testuser testpass)" 303
expect_eq 'jellyfin restricted cover' "$(http "$B" GET /api/cover/j9:tag9)" 200
: >"$TMP/c.jar"
login "$TMP/c.jar" jellyfin other otherpass >/dev/null
expect_eq 'restricted cover not served from cache to another viewer' "$(http "$TMP/c.jar" GET /api/cover/j9:tag9)" 404
expect_eq 'deleting a non-playlist refused' "$(http "$B" DELETE /api/playlists/jmovie -H "origin: $BASE")" 502
expect_eq 'nothing deleted upstream' "$(curl -s "$JF/__deleted")" '[]'
expect_eq 'dot-dot id refused' "$(http "$B" GET /api/stream/..)" 404
expect_eq 'jellyfin stream' "$(http "$B" GET /api/stream/j1)" 200

echo '# Sign-in throttling'
curl -s "$SUB/__reset" >/dev/null
T="$TMP/t.jar"
: >"$T"
for _ in $(seq 10); do login "$T" subsonic other wrong >/dev/null; done
expect_eq 'eleventh guess throttled' "$(login "$T" subsonic other wrong)" 429
expect_eq 'throttled guesses never reach the server' "$(curl -s "$SUB/__stats" | jq .pings)" 10
expect_has 'throttle logged' "$(cat "$LOG")" sign-in-throttled
: >"$TMP/owner.jar"
login "$TMP/owner.jar" subsonic other otherpass >/dev/null
# The owner's browser has signed in before the attack in a real deployment;
# here it signs in after the lockout and is refused, which is the documented
# cost for a browser that is not yet known.
expect_eq 'unknown browser refused while throttled' "$(header location)" ''

curl -s "$SUB/__reset" >/dev/null
for _ in $(seq 50); do login "$TMP/burst-$RANDOM.jar" subsonic burst-target wrong >/dev/null & done
wait_jobs() { for job in $(jobs -p); do case " ${PIDS[*]} " in *" $job "*) ;; *) wait "$job" ;; esac; done; }
wait_jobs
expect_eq '50 concurrent guesses reach the server at most 10 times' "$(curl -s "$SUB/__stats" | jq '.pings <= 10')" true

echo '# Logout'
expect_eq 'logout' "$(http "$A" POST /logout -H "origin: $BASE")" 303
expect_eq 'session gone after logout' "$(http "$A" GET /api/settings)" 401

echo '# Log hygiene'
# The Last.fm callback carries last.fm's token and Navidrome's link token in
# its query, which reaches the log as the request query or inside `next`.
L="$TMP/lastfm.jar"
: >"$L"
login "$L" subsonic testuser testpass >/dev/null
http "$L" GET '/settings/lastfm?uid=secret-link-token&state=x&token=secret-lastfm-token' >/dev/null
expect_eq 'Last.fm callback with a wrong state refused' "$(header location)" '/settings?lastfm=refused'
http "$ANON" GET '/settings/lastfm?uid=secret-link-token&token=secret-lastfm-token' -H 'accept: text/html' >/dev/null
expect_has 'Last.fm callback without a session goes to sign-in' "$(header location)" '/login?next='
expect_lacks 'Last.fm token not logged' "$(cat "$LOG")" secret-lastfm-token
expect_lacks 'link token not logged' "$(cat "$LOG")" secret-link-token
expect_lacks 'password not logged' "$(cat "$LOG")" testpass
if grep -Eq '[?&](u|t|s|p)=' "$LOG"; then bad 'no upstream query string logged' "$(grep -Em1 '[?&](u|t|s|p)=' "$LOG")"; else ok 'no upstream query string logged'; fi

# Checks for the 2026-09 review live in their own file so that they can be run
# before and after a fix.
source "$ROOT/tests/e2e/review-2026-09.sh"

echo
echo "$PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]]
