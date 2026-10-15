#!/usr/bin/env bash
# Checks docker-entrypoint.sh in the image's base, without building the image:
#
#   tests/docker/entrypoint.sh
#
# Each case is a container of `node:22-bookworm-slim` with the entrypoint
# copied in, a data directory in the state the case is about, and a command
# that says who it ran as and whether it could write there. Needs Docker.
set -uo pipefail

root=$(cd "$(dirname "$0")/../.." && pwd)
BASE=${HEDDOHON_BASE_IMAGE:-node:22-bookworm-slim}
passed=0
failed=0

# The entrypoint's command: who it runs as, its extra groups, whether it can
# write the data directory, and whether it could become root again.
SAYS='echo "$(id -u):$(id -g) groups=$(id -G) write=$(touch /data/probe 2>/dev/null && echo yes || echo no) nnp=$(grep -c "NoNewPrivs:.1" /proc/self/status) caps=$(grep CapEff /proc/self/status | cut -f2)"'

# run <name> <expected, a regular expression> <docker create arguments...> -- <what root does first>
run() {
	local name=$1 expected=$2
	shift 2
	local args=()
	while [ "$1" != -- ]; do
		args+=("$1")
		shift
	done
	shift
	local before=$1 id out
	# With --user there is no root to prepare anything: the entrypoint is the command.
	if printf '%s\n' "${args[@]}" | grep -q -- '^--user$'; then
		id=$(docker create "${args[@]}" "$BASE" /entry.sh sh -c "$SAYS")
	else
		id=$(docker create "${args[@]}" "$BASE" sh -c "$before; exec /entry.sh sh -c '$SAYS'")
	fi
	docker cp -q "$root/docker-entrypoint.sh" "$id:/entry.sh"
	out=$(docker start -a "$id" 2>&1)
	docker rm -f "$id" >/dev/null
	if printf '%s' "$out" | grep -Eq "$expected"; then
		passed=$((passed + 1))
		echo "ok - $name"
	else
		failed=$((failed + 1))
		echo "not ok - $name"
		echo "#   expected: $expected"
		echo "#   got:      $out"
	fi
}

docker image inspect "$BASE" >/dev/null 2>&1 || docker pull -q "$BASE" >/dev/null

# Docker made the directory, as root: it is given to node, and the server runs as node.
run 'a directory that is new, or root'"'"'s, is given to 1000 and written as 1000' \
	'^1000:1000 groups=1000 write=yes nnp=1 caps=0000000000000000$' \
	-- 'mkdir -p /data'
run 'the tree under it is given too, files included' \
	'giving /data to 1000:1000 \(it was 0:0\)' \
	-- 'mkdir -p /data/covers && touch /data/covers/a && chmod 600 /data/covers/a'
# A deployment that already has its directory keeps it, and runs as its owner.
run 'a directory that has an owner is left alone and run as that owner' \
	'^99:100 groups=100 write=yes nnp=1 caps=0000000000000000$' \
	-- 'mkdir -p /data && chown 99:100 /data'
run 'PUID and PGID choose the user and take the directory' \
	'^99:100 groups=100 write=yes' \
	-e PUID=99 -e PGID=100 -- 'mkdir -p /data'
run 'PUID and PGID take a directory that was someone else'"'"'s' \
	'giving /data to 99:100 \(it was 1000:1000\)' \
	-e PUID=99 -e PGID=100 -- 'mkdir -p /data && chown 1000:1000 /data'
run 'PUID alone takes its own number as the group' \
	'^1234:1234 groups=1234 write=yes' \
	-e PUID=1234 -- 'mkdir -p /data'
run 'the data directory can be elsewhere' \
	'^1000:1000 .*' \
	-e HEDDOHON_DATA_DIR=/srv/heddohon -- 'ln -s /srv/heddohon /data'
run 'a PUID that is not a number stops the start and says so' \
	"PUID must be a number, got 'nobody'" \
	-e PUID=nobody -- 'mkdir -p /data'
run 'a PGID that is not a number stops the start' \
	"PGID must be a number, got '1 0'" \
	-e PUID=99 -e 'PGID=1 0' -- 'mkdir -p /data'
run 'root only where PUID=0 asks for it, and it says so' \
	'running as root, as PUID=0 asks' \
	-e PUID=0 -- 'mkdir -p /data'
# With --user the entrypoint has no root: the command runs as that user, as before.
run 'started with --user it runs as that user and changes nothing' \
	'^99:100 groups=100 write=no' \
	--user 99:100 -- ''

echo "# $passed passed, $failed failed"
[ "$failed" -eq 0 ]
