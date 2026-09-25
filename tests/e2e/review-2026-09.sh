# Checks for the findings of the 24 September 2026 audit in SECURITY.md.
# Sourced by run.sh, which provides the helpers, the running app and the mocks.
# shellcheck shell=bash

echo '# 2026-09 F1: throttle counters are per backend'
# `alice` exists on both mock servers with different passwords, as two people
# with one name on two servers would. Guesses at the Subsonic account must not
# be reset by a sign-in to the Jellyfin one.
X="$TMP/f1-guess.jar"
: >"$X"
for _ in $(seq 9); do login "$X" subsonic alice wrong >/dev/null; done
: >"$TMP/f1-jf.jar"
expect_eq 'F1 other-backend sign-in succeeds' "$(login "$TMP/f1-jf.jar" jellyfin alice jellyfin-alice)" 303
login "$X" subsonic alice wrong >/dev/null
expect_eq 'F1 eleventh guess throttled despite a sign-in on the other backend' "$(login "$X" subsonic alice wrong)" 429

# The known-device cookie from one backend must not count as known on the
# other, or its own budget becomes the only limit and a sign-in resets it.
# A signed-in browser is sent away from /login before the action runs, so the
# session cookie is dropped after each sign-in and the device cookie kept.
D="$TMP/f1-device.jar"
: >"$D"
drop_session() { sed -i '/heddohon_session/d' "$D"; }
expect_eq 'F1 device sign-in on jellyfin' "$(login "$D" jellyfin carol jellyfin-carol)" 303
drop_session
for _ in $(seq 9); do login "$D" subsonic carol wrong >/dev/null; done
login "$D" jellyfin carol jellyfin-carol >/dev/null
drop_session
login "$D" subsonic carol wrong >/dev/null
expect_eq 'F1 jellyfin device cookie does not reset subsonic guesses' "$(login "$D" subsonic carol wrong)" 429
expect_eq 'F1 jellyfin carol unaffected by subsonic guesses' "$(login "$D" jellyfin carol jellyfin-carol)" 303
drop_session

echo '# 2026-09 F2: a reused upstream name does not inherit the account'
P="$TMP/f2-first.jar"
Q="$TMP/f2-second.jar"
: >"$P"
: >"$Q"
expect_eq 'F2 first bob signs in' "$(login "$P" jellyfin bob bob-first)" 303
json "$P" PATCH /api/settings '{"theme":"light"}' >/dev/null
expect_eq 'F2 first bob shares a song' "$(json "$P" POST /api/shares '{"songId":"j1"}')" 200
bob_share="$(body | jq -r .path)"
# The administrator deletes bob and creates a new user with the same name.
curl -s "$JF/__recreate?name=bob&password=bob-second" >/dev/null
expect_eq 'F2 second bob signs in' "$(login "$Q" jellyfin bob bob-second)" 303
expect_eq 'F2 second bob makes a private playlist' "$(json "$Q" POST /api/playlists '{"name":"second bob only"}')" 201
status="$(http "$P" GET /api/playlists)"
expect_eq "F2 first bob's session is ended" "$status" 401
expect_lacks "F2 first bob cannot read second bob's playlists" "$(body)" 'second bob only'
expect_eq "F2 first bob's link does not play as second bob" "$(http "$ANON" GET "$bob_share/stream")" 404
expect_eq "F2 second bob does not inherit first bob's settings" "$(http "$Q" GET /api/settings; body | jq -r .theme)" 200dark
# The same user signing in again from another browser keeps everything.
json "$Q" PATCH /api/settings '{"theme":"light"}' >/dev/null
: >"$TMP/f2-third.jar"
expect_eq 'F2 second bob signs in again elsewhere' "$(login "$TMP/f2-third.jar" jellyfin bob bob-second)" 303
expect_eq "F2 a repeat sign-in keeps the other session and its settings" "$(http "$Q" GET /api/settings; body | jq -r .theme)" 200light

echo '# 2026-09 F3: /healthz on a broken configuration is hardened'
BROKEN_PORT=$((APP_PORT + 1))
start_app "$BROKEN_PORT" "$TMP/broken" "$TMP/broken.log" HEDDOHON_SECRET=short
wait_for "http://127.0.0.1:$BROKEN_PORT/healthz"
code="$(curl -s -o "$TMP/body" -D "$TMP/headers" -w '%{http_code}' "http://127.0.0.1:$BROKEN_PORT/healthz")"
expect_eq 'F3 misconfigured healthz answers 503' "$code" 503
expect_eq 'F3 misconfigured healthz reports it' "$(body | jq -r .status)" misconfigured
hardened 'F3 misconfigured healthz'

echo '# 2026-09 F2 (Subsonic): a changed password ends the other sessions'
# Navidrome reports no user id, so a name given to someone else and a password
# change look the same. Either ends the sessions signed in with the old one.
S1="$TMP/f2s-first.jar"
S2="$TMP/f2s-second.jar"
S3="$TMP/f2s-third.jar"
: >"$S1"
: >"$S2"
: >"$S3"
expect_eq 'F2s dave signs in' "$(login "$S1" subsonic dave dave-first)" 303
json "$S1" PATCH /api/settings '{"theme":"light"}' >/dev/null
expect_eq 'F2s dave shares a song' "$(json "$S1" POST /api/shares '{"songId":"s2"}')" 200
dave_share="$(body | jq -r .path)"
curl -s "$SUB/__password?name=dave&password=dave-second" >/dev/null
expect_eq 'F2s sign-in with the new password' "$(login "$S2" subsonic dave dave-second)" 303
expect_eq 'F2s session from the old password is ended' "$(http "$S1" GET /api/settings)" 401
expect_eq 'F2s new session works' "$(http "$S2" GET /api/settings; body | jq -r .theme)" 200light
expect_eq 'F2s links are kept' "$(http "$ANON" GET "$dave_share/stream")" 200
expect_eq 'F2s repeat sign-in with the same password' "$(login "$S3" subsonic dave dave-second)" 303
expect_eq 'F2s repeat sign-in keeps the other session' "$(http "$S2" GET /api/settings)" 200
