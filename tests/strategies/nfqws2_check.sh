#!/bin/sh
# Runs inside docker linux/amd64. Usage: nfqws2_check.sh <release-dir> <cases-file>
# Each case: nfqws2 --dry-run (options, files) and --intercept=0 (lua-init, desync functions exist).
# Lua arguments of desync functions are not validated by nfqws2 at all.
set -u
ZAPRET_BASE=$1
CASES=$2
N="$ZAPRET_BASE/binaries/linux-x86_64/nfqws2"
LUA="--lua-init=@$ZAPRET_BASE/lua/zapret-lib.lua --lua-init=@$ZAPRET_BASE/lua/zapret-antidpi.lua"
TAB=$(printf '\t')
fails=0
total=0

"$N" --version 2>&1 | grep -m1 'version' || { echo "FAIL: $N не запускается"; exit 1; }

while IFS="$TAB" read -r id variant args; do
	for mode in --dry-run --intercept=0; do
		total=$((total + 1))
		# same expansion as blockcheck2 custom/10-list.sh
		eval "set -- $args"
		# shellcheck disable=SC2086
		if out=$("$N" --qnum=200 $mode $LUA "$@" 2>&1); then
			:
		else
			fails=$((fails + 1))
			# on a bad option nfqws2 prints the error and then the whole usage
			why=$(printf '%s\n' "$out" | grep -v "^seccomp:" | grep -i -m1 -e unrecogni -e invalid -e cannot -e 'not exist' -e duplicate -e error -e bad -e fail -e 'not accessible')
			[ -n "$why" ] || why=$(printf '%s\n' "$out" | tail -n 2 | tr '\n' ' ')
			echo "FAIL $id [$variant, ${mode#--}]: ${why:-exit code != 0}"
		fi
	done
done <"$CASES"

echo "nfqws2: $total проверок, $fails ошибок"
[ "$total" -gt 0 ] || { echo "FAIL: нечего проверять (пустой набор стратегий)"; exit 1; }
[ "$fails" -eq 0 ]
