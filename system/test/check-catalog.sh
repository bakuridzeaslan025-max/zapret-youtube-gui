#!/bin/sh
# Runs inside the test container after install: every catalog strategy -> nfqws2 --dry-run
# with the exact profile layout of `ytu-helper _run`. Prints "<n> OK" or "BAD <id>".
. /opt/ytunblock/lib/common.sh
n=0
for id in $(sed -n 's/^ *"id": "\([^"]*\)".*/\1/p' "$YTU_CATALOG"); do
	a=$(strategy_args "$id") || { echo "BAD $id (refused)"; continue; }
	set --
	while IFS= read -r l; do
		set -- "$@" "$l"
	done <<E
$a
E
	if "$YTU_Z2/nfq2/nfqws2" --dry-run --qnum=1 \
		--lua-init=@"$YTU_Z2/lua/zapret-lib.lua" --lua-init=@"$YTU_Z2/lua/zapret-antidpi.lua" \
		--filter-tcp=443 --hostlist="$YTU_HOSTLIST" "$@" \
		--new --filter-udp=443 --filter-l7=quic --hostlist="$YTU_HOSTLIST" --lua-desync=drop >/dev/null 2>&1; then
		n=$((n + 1))
	else
		echo "BAD $id"
	fi
done
echo "$n OK"
