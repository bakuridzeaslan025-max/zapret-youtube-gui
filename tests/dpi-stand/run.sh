#!/usr/bin/env bash
# DPI stand: client -> isp (fake DPI) -> server. See README.md.
# Usage: ./run.sh [up|down|fetch|smoke|dpi|blockcheck [MODE]|apply [MODE]|path|all]
set -uo pipefail
cd "$(dirname "$0")" || exit 2

# The only zapret2 pin lives in system/fetch-zapret2.sh.
PIN=../../system/fetch-zapret2.sh
ZAPRET2_VERSION=$(sed -n 's/^VERSION=//p' $PIN)
ZAPRET2_SHA256=$(sed -n 's/^SHA256=//p' $PIN)
[ -n "$ZAPRET2_VERSION" ] && [ -n "$ZAPRET2_SHA256" ] || { echo "no VERSION=/SHA256= in $PIN" >&2; exit 2; }
ZAPRET2_URL="https://github.com/bol-van/zapret2/releases/download/$ZAPRET2_VERSION/zapret2-$ZAPRET2_VERSION.tar.gz"

TARGETS="www.youtube.com youtubei.googleapis.com i.ytimg.com rr1---sn-test.googlevideo.com"
INNOCENT=example.org
PROBE_TIMEOUT=${PROBE_TIMEOUT:-3}
BC_MODE=${BC_MODE:-sni-drop-reasm}
# Modes for scenarios 2-3 in `all`.
BC_MODES=${BC_MODES:-sni-drop-reasm sni-drop}
# Per-packet control: breaks every token (youtubei needs host+1, the rest midsld).
CONTROL_SPLIT='--payload=tls_client_hello --lua-desync=multisplit:pos=host+1,midsld'

CACHE=.cache
LOGS=$CACHE/logs
mkdir -p "$LOGS"
FAILED=()

dc() { docker compose "$@"; }
cx() { dc exec -T client sh -c "$1"; }
set_dpi() { dc exec -T isp dpi-mode "$1" >/dev/null || { echo "cannot set DPI mode $1" >&2; exit 2; }; }
bypass() { dc exec -T client bypass "$@"; }

pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1"; FAILED+=("$1"); }

fetch() {
	[ "$(cat $CACHE/zapret2/.sha256 2>/dev/null)" = "$ZAPRET2_SHA256" ] && return 0
	local tgz=${ZAPRET2_TARBALL:-$CACHE/zapret2-$ZAPRET2_VERSION.tar.gz} sum
	[ -f "$tgz" ] || { curl -fL --retry 5 --retry-all-errors --retry-delay 3 -o "$tgz.part" "$ZAPRET2_URL" && mv "$tgz.part" "$tgz"; } || { rm -f "$tgz.part"; return 1; }
	if command -v sha256sum >/dev/null; then sum=$(sha256sum "$tgz"); else sum=$(shasum -a 256 "$tgz"); fi
	if [ "${sum%% *}" != "$ZAPRET2_SHA256" ]; then
		echo "sha256 mismatch for $tgz" >&2
		[ -n "${ZAPRET2_TARBALL:-}" ] || rm -f "$tgz"  # never delete a user-supplied file
		return 1
	fi
	rm -rf $CACHE/zapret2 "$CACHE/zapret2-$ZAPRET2_VERSION"
	tar -xzf "$tgz" -C $CACHE && mv "$CACHE/zapret2-$ZAPRET2_VERSION" $CACHE/zapret2 &&
		echo "$ZAPRET2_SHA256" >$CACHE/zapret2/.sha256
}

up() {
	fetch || { echo "zapret2 fetch failed" >&2; exit 2; }
	local out
	out=$(dc up -d --build 2>&1) || { echo "$out" >&2; exit 2; }
	# Containers may survive from a previous run with another DPI mode or a running bypass.
	for _ in $(seq 50); do dc exec -T isp dpi-mode none >/dev/null 2>&1 && break; sleep 0.2; done
	for _ in $(seq 50); do
		cx "bypass stop && [ -x /opt/zapret2/nfq2/nfqws2 ] && curl -so /dev/null --max-time 1 https://$INNOCENT/" && return 0
		sleep 0.2
	done
	echo "stand did not come up" >&2; dc logs >&2; exit 2
}

# probe_all "HOSTS" -> "HOST tlsV CODE TIME" per host and TLS version (in parallel); ok = 200
probe_all() {
	local hosts=$1
	cx "d=\$(mktemp -d); n=0
	for h in $hosts; do for v in 1.2 1.3; do
		n=\$((n + 1))
		if [ \$v = 1.2 ]; then o='--tlsv1.2 --tls-max 1.2'; else o=--tlsv1.3; fi
		(r=\$(curl -s -o /dev/null -w '%{http_code} %{time_total}' --max-time $PROBE_TIMEOUT \$o https://\$h/)
		 echo \"\$h tls\$v \$r\" >\$d/\$n) &
	done; done
	wait; for i in \$(seq \$n); do cat \$d/\$i; done; rm -rf \$d"
}

# Same rule as the app's CheckResult: all targets ok -> unblocked; innocent SNI dead -> path; else dpi.
verdict() {
	local out=$1
	if ! echo "$out" | awk -v h=$INNOCENT '$1 == h && $3 != 200 {bad=1} END {exit bad}'; then
		echo path
	elif echo "$out" | awk -v h=$INNOCENT '$1 != h && $3 != 200 {bad=1} END {exit bad}'; then
		echo unblocked
	else
		echo dpi
	fi
}

# Beyond the verdict, negative cases are strict: dpi = every target 000 and innocent 200,
# path = everything 000. Broken probe output is a failure, never a verdict.
expect_verdict() { # name expected hosts
	local out v nh bad
	out=$(probe_all "$3")
	echo "$out" | sed 's/^/      /'
	nh=$(echo $3 | wc -w)
	if [ "$(echo "$out" | grep -cE '^[^ ]+ tls1\.[23] [0-9]{3} ')" -ne $((nh * 2)) ]; then
		fail "$1 (probe output broken: expected $((nh * 2)) results)"; return
	fi
	v=$(verdict "$out")
	case "$2" in
		dpi) bad=$(echo "$out" | awk -v h=$INNOCENT '($1 == h) != ($3 == 200) || ($1 != h && $3 != "000")') ;;
		path) bad=$(echo "$out" | awk '$3 != "000"') ;;
		*) bad= ;;
	esac
	if [ "$v" = "$2" ] && [ -z "$bad" ]; then pass "$1 (verdict $v)"
	elif [ "$v" = "$2" ]; then fail "$1 (verdict $v, but not strict: $(echo $bad | cut -c1-80))"
	else fail "$1 (verdict $v, expected $2)"; fi
}

sc_smoke() {
	echo "== smoke: DPI none, no bypass"
	set_dpi none; bypass stop
	expect_verdict smoke unblocked "$TARGETS $INNOCENT"
}

sc_dpi() {
	echo "== 1. dpi: sni-drop, no bypass -> targets hang, $INNOCENT ok"
	set_dpi sni-drop; bypass stop
	expect_verdict "1 dpi/sni-drop" dpi "$TARGETS $INNOCENT"
	echo "== 1b. DPI self-check: plain split ($CONTROL_SPLIT)"
	bypass start "$CONTROL_SPLIT"
	expect_verdict "1b plain split passes sni-drop" unblocked "$TARGETS $INNOCENT"
	set_dpi sni-drop-reasm
	expect_verdict "1c plain split blocked by sni-drop-reasm" dpi "$TARGETS $INNOCENT"
	bypass stop
	expect_verdict "1d sni-drop-reasm without bypass" dpi "$TARGETS $INNOCENT"
}

# blockcheck2 TEST=custom with the repo lists; log -> $LOGS/blockcheck-MODE.log
sc_blockcheck() {
	local mode=${1:-$BC_MODE} log=$LOGS/blockcheck-${1:-$BC_MODE}.log common
	echo "== 2. blockcheck2 TEST=custom, DPI $mode"
	set_dpi "$mode"; bypass stop
	cx "cd /opt/zapret2 && BATCH=1 TEST=custom SKIP_DNSCHECK=1 IPVS=4 ENABLE_HTTP=0 ENABLE_HTTP3=0 \
		ENABLE_HTTPS_TLS12=1 ENABLE_HTTPS_TLS13=1 UNBLOCKED_DOM=$INNOCENT \
		DOMAINS='$TARGETS' \
		LIST_HTTPS_TLS12=/repo/strategies/blockcheck2/list_https_tls12.txt \
		LIST_HTTPS_TLS13=/repo/strategies/blockcheck2/list_https_tls13.txt \
		./blockcheck2.sh" >"$log" 2>&1
	summarize "$log"
	common=$(common_ids "$log")
	if [ -n "$common" ]; then
		pass "2 blockcheck2/$mode: $(echo "$common" | wc -l | tr -d ' ') strategies pass ALL hosts (tls1.2+1.3)"
	else
		fail "2 blockcheck2/$mode: no strategy passes all hosts (log: $log)"
	fi
}

# ids from * COMMON present for both tls12 and tls13
common_ids() {
	sed -n '/^\* COMMON/,/^$/p' "$1" | grep -o 'curl_test_https_tls1[23] .*--comment=[^ ]*' |
		sed -E 's/^curl_test_https_(tls1[23]).*--comment=/\1 /' | sort -u |
		awk '{n[$2]++} END {for (i in n) if (n[i] == 2) print i}' | sort
}

# per strategy: hosts passed for tls1.2 / tls1.3
summarize() {
	awk '
		/^- curl_test_https_tls1[23] ipv4 / { t = substr($2, 17); match($0, /--comment=[^ ]*/); id = substr($0, RSTART + 10, RLENGTH - 10); next }
		id != "" && /AVAILABLE !!!!!/ { ok[id, t]++; ids[id] = 1; id = ""; next }
		id != "" && /UNAVAILABLE/ { ids[id] = 1; id = ""; next }
		END { for (i in ids) printf "      %-42s tls1.2 %d/%d  tls1.3 %d/%d\n", i, ok[i, "tls12"], n, ok[i, "tls13"], n }
	' n="$(echo $TARGETS | wc -w | tr -d ' ')" "$1" | sort
}

strategy_args() { # id -> args from the tls13 list
	grep -- "--comment=$1 " ../../strategies/blockcheck2/list_https_tls13.txt | head -1
}

sc_apply() {
	local mode=${1:-$BC_MODE} log=$LOGS/blockcheck-${1:-$BC_MODE}.log id args
	id=${STRATEGY:-$( [ -f "$log" ] && common_ids "$log" | head -1)}
	echo "== 3. apply strategy '${id:-?}' under DPI $mode"
	[ -n "$id" ] || { fail "3 apply/$mode: no strategy (run blockcheck $mode first or set STRATEGY=id)"; return; }
	args=$(strategy_args "$id")
	[ -n "$args" ] || { fail "3 apply/$mode: unknown strategy $id"; return; }
	set_dpi "$mode"
	bypass start "$args" || { fail "3 apply/$mode: nfqws2 did not start"; return; }
	expect_verdict "3 apply/$mode $id" unblocked "$TARGETS $INNOCENT"
	bypass stop
}

sc_path() {
	echo "== 4. path: blackhole -> nothing answers, any SNI"
	set_dpi blackhole; bypass stop
	expect_verdict "4 path/blackhole" path "$TARGETS $INNOCENT"
}

trap 'echo "interrupted" >&2; dc exec -T isp dpi-mode none >/dev/null 2>&1; bypass stop >/dev/null 2>&1; exit 130' INT TERM

finish() {
	dc exec -T isp dpi-mode none >/dev/null 2>&1; bypass stop >/dev/null 2>&1
	echo "-- ${SECONDS}s"
	if [ ${#FAILED[@]} -eq 0 ]; then echo "ALL PASS"; exit 0; fi
	echo "FAILED: ${#FAILED[@]}"; printf '  %s\n' "${FAILED[@]}"; exit 1
}

cmd=${1:-all}
case "$cmd" in
	fetch) fetch; exit ;;
	up) up; exit ;;
	down) dc down -v; exit ;;
esac
up
case "$cmd" in
	smoke) sc_smoke ;;
	dpi) sc_dpi ;;
	blockcheck) sc_blockcheck "${2:-}" ;;
	apply) sc_apply "${2:-}" ;;
	path) sc_path ;;
	all)
		sc_smoke; sc_dpi
		for m in $BC_MODES; do sc_blockcheck "$m"; sc_apply "$m"; done
		sc_path ;;
	*) echo "usage: $0 [up|down|fetch|smoke|dpi|blockcheck [MODE]|apply [MODE]|path|all]" >&2; exit 2 ;;
esac
finish
