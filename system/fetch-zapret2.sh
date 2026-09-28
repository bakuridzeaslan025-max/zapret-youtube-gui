#!/bin/sh
# Build step: puts the pinned zapret2 release subset into system/vendor/zapret2
# (payload for install.sh). Usage: fetch-zapret2.sh [local-tarball]
set -eu

VERSION=v1.0.5.2
SHA256=fb3bcf69e7d86b9fa2d60bd53c956ac06d9dcc3adf9392afd84865f1d94b1158
URL="https://github.com/bol-van/zapret2/releases/download/$VERSION/zapret2-$VERSION.tar.gz"

HERE=$(cd "$(dirname "$0")" && pwd)
DEST="$HERE/vendor/zapret2"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

TARBALL=${1:-}
if [ -z "$TARBALL" ]; then
	TARBALL="$TMP/z2.tar.gz"
	curl -fsSL -o "$TARBALL" "$URL"
fi
if command -v sha256sum >/dev/null; then
	sum=$(sha256sum "$TARBALL" | cut -d' ' -f1)
else
	sum=$(shasum -a 256 "$TARBALL" | cut -d' ' -f1)
fi
[ "$sum" = "$SHA256" ] || { echo "sha256 mismatch: $sum" >&2; exit 1; }

tar -xzf "$TARBALL" -C "$TMP"
S="$TMP/zapret2-$VERSION"

rm -rf "$DEST"
mkdir -p "$DEST/files" "$DEST/binaries" "$DEST/blockcheck2.d"
cp -R "$S/lua" "$S/common" "$DEST/"
cp -R "$S/files/fake" "$DEST/files/"
cp -R "$S/blockcheck2.d/standard" "$S/blockcheck2.d/custom" "$DEST/blockcheck2.d/"
cp "$S/blockcheck2.sh" "$S/config.default" "$S/docs/LICENSE.txt" "$DEST/"
for a in linux-x86_64 linux-arm64; do
	mkdir -p "$DEST/binaries/$a"
	cp "$S/binaries/$a/nfqws2" "$S/binaries/$a/mdig" "$DEST/binaries/$a/"
done
echo "$VERSION" >"$DEST/VERSION"
echo "zapret2 $VERSION -> $DEST"
