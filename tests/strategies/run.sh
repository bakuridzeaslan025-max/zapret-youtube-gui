#!/bin/sh
# Checks every strategy in strategies/nfqws2.json and strategies/blockcheck2/list_https_tls1{2,3}.txt:
#   1) consistency (ids, --comment, source comments, blob files present in the zapret2 release);
#   2) nfqws2 (linux-x86_64 from the release, docker linux/amd64) accepts each one
#      in --dry-run and --intercept=0 with lua from the same release.
# zapret2 version/sha256 are taken from system/fetch-zapret2.sh (single pin).
# Env: STRATEGIES_DIR (default: strategies/), ZAPRET2_TARBALL (local tarball instead of download),
#      ZAPRETAPP_CACHE (default: ${XDG_CACHE_HOME:-~/.cache}/zapretApp).
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
STRATEGIES_DIR=${STRATEGIES_DIR:-$ROOT/strategies}
PIN="$ROOT/system/fetch-zapret2.sh"
CACHE=${ZAPRETAPP_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/zapretApp}

VERSION=$(sed -n 's/^VERSION=//p' "$PIN")
SHA256=$(sed -n 's/^SHA256=//p' "$PIN")
[ -n "$VERSION" ] && [ -n "$SHA256" ] || { echo "ERROR: не нашёл VERSION=/SHA256= в $PIN" >&2; exit 2; }

sha256() { if command -v sha256sum >/dev/null; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1; }

mkdir -p "$CACHE"
TARBALL="$CACHE/zapret2-$VERSION.tar.gz"
REL="$CACHE/zapret2-$VERSION"
if [ ! -f "$REL/.sha256" ] || [ "$(cat "$REL/.sha256")" != "$SHA256" ]; then
	if [ ! -f "$TARBALL" ] || [ "$(sha256 "$TARBALL")" != "$SHA256" ]; then
		if [ -n "${ZAPRET2_TARBALL:-}" ]; then
			cp "$ZAPRET2_TARBALL" "$TARBALL.part"
		else
			echo "downloading zapret2 $VERSION -> $TARBALL"
			curl -fsSL --retry 5 --retry-all-errors --retry-delay 3 -o "$TARBALL.part" "https://github.com/bol-van/zapret2/releases/download/$VERSION/zapret2-$VERSION.tar.gz"
		fi
		sum=$(sha256 "$TARBALL.part")
		[ "$sum" = "$SHA256" ] || { rm -f "$TARBALL.part"; echo "ERROR: sha256 mismatch: $sum (ждали $SHA256)" >&2; exit 2; }
		mv "$TARBALL.part" "$TARBALL"
	fi
	rm -rf "$REL"
	tar -xzf "$TARBALL" -C "$CACHE"
	echo "$SHA256" >"$REL/.sha256"
fi

CASES=$(mktemp "$CACHE/cases.XXXXXX")
trap 'rm -f "$CASES"' EXIT

echo "== strategies: $STRATEGIES_DIR; zapret2 $VERSION: $REL"
rc=0
python3 "$HERE/check_consistency.py" "$STRATEGIES_DIR" "$REL" "$CASES" /z || rc=1

# without NET_ADMIN nfqws2 fails every case (setpcap on droproot) -> false FAIL
docker run --rm --platform linux/amd64 --cap-add=NET_ADMIN \
	-v "$REL:/z:ro" -v "$HERE/nfqws2_check.sh:/check.sh:ro" -v "$CASES:/cases:ro" \
	alpine:3 sh /check.sh /z /cases || rc=1

[ "$rc" -eq 0 ] && echo "== OK" || echo "== FAILED"
exit "$rc"
