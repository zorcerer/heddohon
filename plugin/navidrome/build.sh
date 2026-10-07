#!/bin/sh
# Builds heddohon.ndp, the package Navidrome loads: the manifest and the
# plugin compiled to WebAssembly, zipped. The file's name is the plugin's id
# in Navidrome, so it carries no version; the manifest inside does, from
# VERSION, or the repository's package.json with "-dev" where that is not set.
#
# Uses tinygo where it is installed (0.39 or later) and the tinygo/tinygo
# image through Docker otherwise.
set -eu
cd "$(dirname "$0")"

TINYGO_IMAGE=tinygo/tinygo:0.42.0
version="${VERSION:-$(sed -n 's/^[[:space:]]*"version": "\(.*\)",$/\1/p' ../../package.json)-dev}"
out="$PWD/heddohon.ndp"
work="$(mktemp -d)"
trap 'rm -rf "$work" plugin.wasm' EXIT

# Without debug information the module is 0.9MB, in place of 2.4MB.
set -- tinygo build -o plugin.wasm -target wasip1 -buildmode=c-shared -no-debug .
if command -v tinygo >/dev/null 2>&1; then
	"$@"
else
	docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD":/src -w /src "$TINYGO_IMAGE" "$@"
fi

sed "s/^  \"version\": \"[^\"]*\"/  \"version\": \"$version\"/" manifest.json > "$work/manifest.json"
grep -q "\"version\": \"$version\"" "$work/manifest.json"
cp plugin.wasm "$work/plugin.wasm"
rm -f "$out"
if command -v zip >/dev/null 2>&1; then
	(cd "$work" && zip -q -X "$out" manifest.json plugin.wasm)
else
	(cd "$work" && python3 -m zipfile -c "$out" manifest.json plugin.wasm)
fi
echo "heddohon.ndp, version $version, $(wc -c < "$out") bytes"
