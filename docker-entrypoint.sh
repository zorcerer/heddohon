#!/bin/sh
# Starts Heddohon as an unprivileged user that can write its data directory.
#
# Docker creates a missing bind-mount source owned by root. Started as an
# unprivileged user, the server then could not write `/data` and answered every
# request with "HEDDOHON_DATA_DIR /data is not writable", which only a `chown`
# on the host put right. This runs first, as root, gives the directory to the
# user the server will run as, and drops to that user before Node starts. Root
# is held for these lines and for nothing else.
#
# The user is PUID and PGID where they are set (99 and 100 on Unraid). Where
# they are not, it is whoever owns the data directory, so a deployment that
# already has one keeps its files as they are, and `node` (1000) for a
# directory that is new or root's.
#
# Started as another user (`docker run --user`, `user:` in a compose file),
# this has no root to use: it runs the command as that user, as the image did
# before it had an entrypoint, and the directory is the operator's to give.
set -eu

DATA="${HEDDOHON_DATA_DIR:-/data}"

if [ "$(id -u)" != 0 ]; then
	exec "$@"
fi

number() {
	case "$2" in
		'' | *[!0-9]*)
			echo "heddohon: $1 must be a number, got '$2'" >&2
			exit 64
			;;
	esac
}

mkdir -p "$DATA"
OWNER_UID="$(stat -c %u "$DATA")"
OWNER_GID="$(stat -c %g "$DATA")"

if [ -n "${PUID:-}" ]; then
	number PUID "$PUID"
	RUN_UID="$PUID"
elif [ "$OWNER_UID" != 0 ]; then
	RUN_UID="$OWNER_UID"
else
	RUN_UID=1000
fi

if [ -n "${PGID:-}" ]; then
	number PGID "$PGID"
	RUN_GID="$PGID"
elif [ -z "${PUID:-}" ] && [ "$OWNER_GID" != 0 ]; then
	RUN_GID="$OWNER_GID"
elif [ -n "${PUID:-}" ]; then
	RUN_GID="$RUN_UID"
else
	RUN_GID=1000
fi

# Root only when it is asked for by number. Nothing here chooses it.
if [ "$RUN_UID" = 0 ]; then
	echo "heddohon: running as root, as PUID=0 asks. The server does not need it." >&2
	exec "$@"
fi

# The whole tree, and only when the directory itself is someone else's: a
# cover cache holds tens of thousands of files, and walking it at every start
# to change nothing would cost seconds.
if [ "$OWNER_UID" != "$RUN_UID" ] || [ "$OWNER_GID" != "$RUN_GID" ]; then
	echo "heddohon: giving $DATA to $RUN_UID:$RUN_GID (it was $OWNER_UID:$OWNER_GID)" >&2
	chown -R "$RUN_UID:$RUN_GID" "$DATA"
fi

# No supplementary groups, no capabilities to inherit, and no way to gain any
# through a set-uid file: what runs from here is that user and nothing more.
exec setpriv --reuid "$RUN_UID" --regid "$RUN_GID" --clear-groups --inh-caps=-all --no-new-privs "$@"
