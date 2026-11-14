#!/usr/bin/env bash
# Checks the ffmpeg the image carries for sound analysis (issue #314): it
# builds the Dockerfile's `ffmpeg` stage for this machine, then, in the
# image's base, has it decode a FLAC and an MP3 of a 440Hz tone peaking at
# 0.0625 (`fixtures/`, one second each) the way the analysis will:
#
#   tests/docker/ffmpeg.sh
#
# Each must decode to about one second of 22.05kHz mono float samples whose
# level is that of the tone, and the binary must need no library. Needs
# Docker.
#
# With HEDDOHON_FFMPEG_OUT=<file> the binary is left there, for the tests
# that decode with it (`tests/e2e/analysis-decode.test.mjs`).
set -uo pipefail

root=$(cd "$(dirname "$0")/../.." && pwd)
BASE=${HEDDOHON_BASE_IMAGE:-node:22-bookworm-slim}
TAG=hh-test-ffmpeg:local
passed=0
failed=0

if ! docker build -q --target ffmpeg -t "$TAG" "$root" >/dev/null; then
	echo "not ok: the ffmpeg stage did not build"
	exit 1
fi
bin=$(mktemp -d)
id=$(docker create "$TAG")
docker cp -q "$id:/opt/ffmpeg/bin/ffmpeg" "$bin/ffmpeg"
docker rm -f "$id" >/dev/null
echo "ffmpeg: $(du -h "$bin/ffmpeg" | cut -f1)"

check() {
	local name=$1 ok=$2 detail=$3
	if [ "$ok" = yes ]; then
		echo "ok   $name: $detail"
		passed=$((passed + 1))
	else
		echo "FAIL $name: $detail"
		failed=$((failed + 1))
	fi
}

# Static: in the base image, `ldd` finds nothing to load.
linked=$(docker run --rm -v "$bin:/opt/ffmpeg:ro" "$BASE" sh -c 'ldd /opt/ffmpeg/ffmpeg 2>&1 || true')
check 'needs no library' "$(printf '%s' "$linked" | grep -q 'not a dynamic executable' && echo yes || echo no)" "$linked"

for file in tone.flac tone.mp3; do
	# Samples and RMS of what it decodes, as the analysis asks for it.
	out=$(docker run --rm -v "$bin:/opt/ffmpeg:ro" -v "$root/tests/docker/fixtures:/fixtures:ro" "$BASE" node -e "
		const { spawnSync } = require('node:child_process');
		const d = spawnSync('/opt/ffmpeg/ffmpeg', ['-nostdin', '-v', 'error', '-i', '/fixtures/$file', '-ac', '1', '-ar', '22050', '-f', 'f32le', 'pipe:1'], { maxBuffer: 1 << 24 });
		if (d.status !== 0) { console.log('error ' + d.stderr); process.exit(); }
		const x = new Float32Array(d.stdout.buffer, d.stdout.byteOffset, d.stdout.length / 4);
		let s = 0; for (const v of x) s += v * v;
		console.log(x.length + ' ' + Math.sqrt(s / x.length).toFixed(4));
	")
	read -r samples rms <<<"$out"
	# A sine peaking at 0.0625 (ffmpeg's sine source at 1/8, halved) has an
	# RMS of 0.0442; MP3 may add about a frame of padding.
	ok=$(awk -v n="$samples" -v r="$rms" 'BEGIN { print (n >= 21000 && n <= 23500 && r >= 0.042 && r <= 0.047) ? "yes" : "no" }' 2>/dev/null)
	check "decodes $file" "${ok:-no}" "$out"
done

if [ -n "${HEDDOHON_FFMPEG_OUT:-}" ]; then
	cp "$bin/ffmpeg" "$HEDDOHON_FFMPEG_OUT"
	chmod 0755 "$HEDDOHON_FFMPEG_OUT"
fi
rm -rf "$bin"
echo "$passed passed, $failed failed"
[ "$failed" -eq 0 ]
