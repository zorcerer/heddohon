#!/usr/bin/env bash
# Checks the ffmpeg the image carries for sound analysis (issue #314): it
# builds the Dockerfile's `ffmpeg` stage for this machine, then, in the
# image's base, has it decode a FLAC and an MP3 of a 440Hz tone peaking at
# 0.0625 (`fixtures/`, one second each) the way the analysis will:
#
#   tests/docker/ffmpeg.sh
#   tests/docker/ffmpeg.sh --platform linux/arm64
#
# For another platform (#342) the stage is cross-compiled as the release
# builds it, and run under emulation: Docker's, where QEMU is registered with
# the kernel (`docker/setup-qemu-action` in CI), or a user-mode QEMU named by
# HEDDOHON_QEMU, which needs no root (Debian's `qemu-user` package, unpacked
# anywhere: HEDDOHON_QEMU=/path/to/qemu-aarch64). The arm64 build decoded both
# files to within 7e-8 of the amd64 one under QEMU on 2026-11-18.
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
platform=''
if [ "${1:-}" = --platform ]; then
	platform=${2:?--platform needs a platform, such as linux/arm64}
fi
TAG=hh-test-ffmpeg:${platform:+${platform//\//-}-}local
# Every container this starts is named, as the host's rules ask (hh-*).
name=hh-test-ffmpeg-$$
passed=0
failed=0

if ! docker build -q --load ${platform:+--platform "$platform"} --target ffmpeg -t "$TAG" "$root" >/dev/null; then
	echo "not ok: the ffmpeg stage did not build"
	exit 1
fi
bin=$(mktemp -d)
id=$(docker create --name "$name-copy" ${platform:+--platform "$platform"} "$TAG")
docker cp -q "$id:/opt/ffmpeg/bin/ffmpeg" "$bin/ffmpeg"
docker rm -f "$id" >/dev/null
echo "ffmpeg${platform:+ for $platform}: $(du -h "$bin/ffmpeg" | cut -f1)"

# Runs a shell command in the image's base for the platform, with the binary
# at /opt/ffmpeg/ffmpeg and the fixtures at /fixtures. Under HEDDOHON_QEMU it
# runs here instead, the binary under that QEMU and node this machine's.
qemu=${HEDDOHON_QEMU:-}
inside() {
	if [ -n "$qemu" ]; then
		FFMPEG="$qemu $bin/ffmpeg" FIXTURES="$root/tests/docker/fixtures" sh -c "$1"
	else
		docker run --rm --name "$name" ${platform:+--platform "$platform"} -v "$bin:/opt/ffmpeg:ro" \
			-v "$root/tests/docker/fixtures:/fixtures:ro" -e FFMPEG=/opt/ffmpeg/ffmpeg -e FIXTURES=/fixtures "$BASE" sh -c "$1"
	fi
}

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

# Static: in the base image, `ldd` finds nothing to load. Under a user-mode
# QEMU there is no base image, and `file` says it instead.
if [ -n "$qemu" ]; then
	linked=$(file -b "$bin/ffmpeg")
	check 'needs no library' "$(printf '%s' "$linked" | grep -q 'statically linked' && echo yes || echo no)" "$linked"
else
	linked=$(inside 'ldd "$FFMPEG" 2>&1 || true')
	check 'needs no library' "$(printf '%s' "$linked" | grep -q 'not a dynamic executable' && echo yes || echo no)" "$linked"
fi

for file in tone.flac tone.mp3; do
	# Samples and RMS of what it decodes, as the analysis asks for it.
	out=$(inside "node -e \"
		const { spawnSync } = require('node:child_process');
		const [command, ...prefix] = process.env.FFMPEG.split(' ');
		const d = spawnSync(command, [...prefix, '-nostdin', '-v', 'error', '-i', process.env.FIXTURES + '/$file', '-ac', '1', '-ar', '22050', '-f', 'f32le', 'pipe:1'], { maxBuffer: 1 << 24 });
		if (d.status !== 0) { console.log('error ' + d.stderr); process.exit(); }
		const x = new Float32Array(d.stdout.buffer, d.stdout.byteOffset, d.stdout.length / 4);
		let s = 0; for (const v of x) s += v * v;
		console.log(x.length + ' ' + Math.sqrt(s / x.length).toFixed(4));
	\"")
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
