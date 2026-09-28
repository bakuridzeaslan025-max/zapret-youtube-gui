#!/bin/sh
# Docker tests for system/. Usage: run-tests.sh <image> <platform> full|nosystemd
# full      - systemd works in the container (native arch): service start/stop/apply via systemd
# nosystemd - systemd units cannot exec (e.g. amd64 under qemu): unit hooks are run by hand
# Needs: system/vendor/zapret2 (fetch-zapret2.sh). Real network tests go through the host network.
set -u
IMAGE=$1 PLATFORM=$2 MODE=$3
REPO=$(cd "$(dirname "$0")/../.." && pwd)
C=ytu-test-$$
fail=0

ok() { echo "PASS $*"; }
bad() { echo "FAIL $*"; fail=1; }
x() { docker exec "$C" sh -c "$1"; }
expect() {
	# $1 name, $2 command, $3 grep -E pattern expected in output
	out=$(x "$2" 2>&1 | tr '\n' ' ')
	if printf '%s' "$out" | grep -qE -- "$3"; then ok "$1"; else bad "$1: $out"; fi
}

docker run -d --name "$C" --platform "$PLATFORM" --privileged --cgroupns=host \
	-v /sys/fs/cgroup:/sys/fs/cgroup:rw --tmpfs /run --tmpfs /run/lock \
	-v "$REPO:/src:ro" "$IMAGE" >/dev/null || exit 1
trap 'docker rm -f "$C" >/dev/null 2>&1' EXIT
sleep 6

H=/opt/ytunblock/bin/ytu-helper
# the way real.js does it: payload copy in a 0755 temp dir
expect "install" 'P=$(mktemp -d); cp -R /src/system /src/strategies $P/; chmod -R a+rX $P; sh $P/system/install.sh --appimage /home/u/ytunblock.AppImage 2>/tmp/install.err | tail -n 1' '"ok":true'
expect "install idempotent" 'P=$(mktemp -d); cp -R /src/system /src/strategies $P/; chmod -R a+rX $P; sh $P/system/install.sh 2>/dev/null | tail -n 1' '"ok":true'
expect "perms 0755 path" 'stat -c %a /opt /opt/ytunblock /opt/ytunblock/zapret2 /opt/ytunblock/zapret2/lua | sort -u | tr "\n" " "' '^755 $'
expect "nfqws2 runs" "/opt/ytunblock/zapret2/nfq2/nfqws2 --version" 'v1.0.5.2'
expect "status unprivileged" "su nobody -s /bin/sh -c '$H status'" '"installed":true.*"service":"off"'
expect "start without strategy" "$H start" 'no strategy selected'
expect "apply unknown" "$H apply nope" 'unknown strategy'
expect "apply bad network" "$H apply flowseal-general-alt --network 'a b'" 'error'
expect "apply" "$H apply flowseal-general-alt11 --network n-home" '"ok":true'
expect "status strategy" "$H status" '"network":"n-home","strategy":\{"id":"flowseal-general-alt11".*"scope":"network"'

expect "apply uppercase id refused" "$H apply Flowseal-general-alt" 'unknown strategy'
expect "catalog args parsed" ". /opt/ytunblock/lib/common.sh; strategy_args flowseal-general-alt7" '^--blob=tls_clienthello_www_google_com:@/opt/ytunblock/zapret2/files/fake/tls_clienthello_www_google_com.bin --payload=tls_client_hello --lua-desync=multisplit:pos=2,sniext\+1:seqovl=679'
expect "unsafe custom args refused" ". /opt/ytunblock/lib/common.sh; mkdir -p /var/lib/ytunblock/custom; echo '--lua-init=@/tmp/x.lua' >/var/lib/ytunblock/custom/bc2-1.args; strategy_args bc2-1; echo rc=\$?; rm /var/lib/ytunblock/custom/bc2-1.args" '^rc=1 $'
expect "nfqws2 accepts every catalog strategy" "sh /src/system/test/check-catalog.sh" '^[0-9]+ OK $'

if [ "$MODE" = full ]; then
	expect "start" "$H start" '"ok":true'
	expect "service active" "systemctl is-active ytunblock" '^active'
	expect "nft table" "nft list table inet ytunblock" 'tcp dport 443 ct original packets 1-20 queue flags bypass to 7713'
	expect "quic queue rule" "nft list chain inet ytunblock quic" 'udp dport 443 ct original packets 1-10 queue'
	expect "quic nfqws2 profile" "ps -o args= -C nfqws2" '--new --filter-udp=443 --filter-l7=quic --hostlist=/opt/ytunblock/strategies/hostlist-youtube.txt --lua-desync=drop'
	expect "nfqws2 dropped root" "ps -o user= -C nfqws2" '^[0-9]+|nobody'
	expect "no lua access error" "sleep 1; journalctl -u ytunblock -o cat --no-pager" 'lua_compat_ver'
	x "journalctl -u ytunblock -o cat --no-pager" | grep -q 'not accessible' && bad "lua not accessible"
	expect "set-quic off" "$H set-quic off; nft list tables inet; ps -o args= -C nfqws2 | grep -c filter-udp" '"ok":true\} table inet ytunblock 0 $'
	expect "set-quic off: no quic chain" "nft list table inet ytunblock | grep -c 'chain quic'" '^0 $'
	expect "set-quic on" "$H set-quic on; nft list table inet ytunblock | grep -c 'chain quic'" '"ok":true\} 1 $'
	expect "apply syndata drops hostlist" "$H apply flowseal-general-alt5 --network n-home >/dev/null; ps -o args= -C nfqws2" '--filter-tcp=443 --comment=flowseal-general-alt5 --lua-desync=syndata --payload'
	expect "wssize gets ipcache-hostname" "echo '--comment=bc2-9 --payload=tls_client_hello --lua-desync=wssize:wsize=1:scale=6' >/var/lib/ytunblock/custom/bc2-9.args; $H apply bc2-9 --network n-home; ps -o args= -C nfqws2" '"ok":true\} .*--filter-tcp=443 --hostlist=\S+ --ipcache-hostname=1 --comment=bc2-9 --payload=tls_client_hello --lua-desync=wssize'
	x "$H apply flowseal-general-alt11 --network n-home" >/dev/null
	expect "network switch keeps strategies" "$H apply - --network n-other; $H status" '"network":"n-other","strategy":\{"id":"flowseal-general-alt11".*"scope":"default"'
	expect "conflict" "nft add table inet zapret2; nft add chain inet zapret2 p '{ type filter hook postrouting priority 99; }'; nft add rule inet zapret2 p tcp dport 443 queue num 200 bypass; $H start; nft delete table inet zapret2" 'FIREWALL_CONFLICT'
	expect "stop" "$H stop; systemctl is-active ytunblock; nft list tables" '^\{"ok":true\} inactive $'
	x "$H apply - --network n-home; $H start" >/dev/null

	expect "select quick (SIMULATE)" "YTU_SIMULATE=1 YTU_SIM_RATE=80 $H select quick --network n-work | tail -n 1" '"event":"done","mode":"quick","found":true'
	expect "select progress lines" "head -n 3 /run/ytunblock/select.jsonl | tail -n 1" '"event":"progress","mode":"quick","done":[0-9]+,"total":[0-9]+,"current":"youtubei.*"startedAt":"20.*"hosts":\[\{"host":"youtubei.googleapis.com","ok":null\}'
	expect "last-select.json" "cat /var/lib/ytunblock/last-select.json" '"event":"done","mode":"quick","found":true'
	expect "select-follow unprivileged, no select" "su nobody -s /bin/sh -c '$H select-follow' | tail -n 1" '"event":"done","mode":"quick"'
	expect "select quick none (SIMULATE)" "YTU_SIMULATE=1 YTU_SIM_RATE=0 $H select quick | tail -n 1" '"found":false'
	expect "select deep (SIMULATE)" "YTU_SIMULATE=1 YTU_SIM_RATE=90 $H select deep --network n-lte | tail -n 1" '"found":true,"strategyId":"bc2-'
	expect "custom strategy stored" "$H status" '"custom":\[\{"id":"bc2-'
	expect "service restored after select" "sleep 2; systemctl is-active ytunblock" '^active'
	expect "select survives caller kill" "$H select quick >/dev/null 2>&1 & p=\$!; sleep 6; kill \$p; sleep 2; $H status" '"service":"selecting"'
	expect "follow reattaches (unprivileged)" "su nobody -s /bin/sh -c 'timeout 5 $H select-follow' | head -n 1" '"event":"progress"'
	expect "busy while selecting" "$H apply flowseal-general-alt; $H set-quic off; $H start" 'BUSY.*BUSY.*BUSY'
	expect "cancel" "$H cancel; tail -n 1 /run/ytunblock/select.jsonl" '"running":true\} .*"cancelled":true'
	expect "no leftovers after cancel" "nft list tables | grep -c blockcheck; pgrep -fc '[b]lockcheck2.sh'" '^0 0 $'
	expect "service restored after cancel" "sleep 2; systemctl is-active ytunblock" '^active'
	expect "crash recovery" "($H select quick >/dev/null 2>&1 &); sleep 8; nft list tables | grep -c blockcheck; systemctl kill -s KILL ytunblock-select; sleep 1; $H status >/dev/null; nft list tables | grep -c blockcheck; sleep 2; systemctl is-active ytunblock; cat /var/lib/ytunblock/last-select.json" '^1 0 active .*"found":false'
else
	expect "pre-start hook" "INVOCATION_ID=test $H _pre-start && nft list table inet ytunblock" 'queue flags bypass to 7713'
	expect "run hook (nfqws2 with strategy)" "INVOCATION_ID=test timeout 4 $H _run 2>&1; true" 'binding this socket to queue'
	expect "post-stop hook" "INVOCATION_ID=test $H _post-stop; nft list tables | grep -c ytunblock" '^0 $'
	# systemd cannot exec units here: run the select body directly
	expect "select-run quick (SIMULATE)" "mkdir -p /run/ytunblock; : >/run/ytunblock/select.jsonl; YTU_SIMULATE=1 YTU_SIM_RATE=80 INVOCATION_ID=test $H _select-run quick --network n-work; tail -n 1 /run/ytunblock/select.jsonl" '"event":"done","mode":"quick","found":true'
	expect "select-run deep (SIMULATE)" ": >/run/ytunblock/select.jsonl; YTU_SIMULATE=1 YTU_SIM_RATE=90 INVOCATION_ID=test $H _select-run deep; tail -n 1 /run/ytunblock/select.jsonl" '"found":true,"strategyId":"bc2-'
	expect "no nslookup/host in image (shim path)" "command -v nslookup || command -v host || echo none" '^none $'
	expect "real select-run starts nfqws2 (x86_64) via blockcheck2" ": >/run/ytunblock/select.jsonl; (INVOCATION_ID=test timeout -s TERM 25 $H _select-run quick; true); grep -c '^- curl_test' /var/log/ytunblock/select-quick.log; grep -c 'nfqws2 redirection' /var/log/ytunblock/select-quick.log; tail -n 1 /run/ytunblock/select.jsonl" '"cancelled":true|"reason":"not blocked"'
	expect "no leftovers after TERM" "nft list tables | grep -c blockcheck; pgrep -fc '[b]lockcheck2.sh'" '^0 0 $'
fi

expect "uninstall" "/opt/ytunblock/uninstall.sh" '"ok":true'
expect "clean after uninstall" "ls -d /opt/ytunblock /var/lib/ytunblock /etc/systemd/system/ytunblock.service /usr/share/polkit-1/actions/org.ytunblock.helper.policy 2>&1 | grep -vc 'No such'; nft list tables | grep -c ytunblock" '^0 0 $'

[ $fail = 0 ] && echo "ALL PASS ($IMAGE $PLATFORM $MODE)" || echo "SOME FAILED ($IMAGE $PLATFORM $MODE)"
exit $fail
