#!/bin/sh
# Non-privileged: install.sh + blockcheck2 SIMULATE selection with nft/systemctl stubs.
#   docker run --rm -v <repo>:/src:ro <image> sh /src/system/test/simulate-tests.sh
fail=0
t() {
	n=$1 e=$2
	shift 2
	o=$("$@" 2>&1 | tr '\n' ' ')
	if printf '%s' "$o" | grep -qE -- "$e"; then echo "PASS $n"; else echo "FAIL $n: $(printf '%s' "$o" | cut -c 1-400)"; fail=1; fi
}
cp /src/system/test/stubs/* /usr/local/sbin/
mkdir -p /run/systemd/system
P=$(mktemp -d)
cp -R /src/system /src/strategies "$P/"
t "install (stubbed nft/systemd)" '"ok":true' sh "$P/system/install.sh" --appimage "/home/u/YouTube Unblock.AppImage"
H=/opt/ytunblock/bin/ytu-helper
J=/run/ytunblock/select.jsonl
sel() {
	# $1 mode, $2 ipvs, $3 rate
	mkdir -p /run/ytunblock
	: >$J
	INVOCATION_ID=t YTU_SIMULATE=1 YTU_SIM_RATE=$3 YTU_IPVS=$2 $H _select-run "$1"
	cat $J
}
N=$(grep -c '^--comment=' /src/strategies/blockcheck2/list_https_tls13.txt)
t "quick ipvs=4 total 4 hosts x N" "\"total\":$((4 * N))," sel quick 4 100
t "quick ipvs=46 total doubled" "\"total\":$((8 * N))," sel quick 46 100
t "quick ipvs=46 found" '"event":"done","mode":"quick","found":true' sel quick 46 100
t "ipvs=46 SUMMARY has ipv6 lines" 'curl_test_https_tls13 ipv6 youtubei.googleapis.com : nfqws2 --comment=' sh -c 'sed -n "/^\* SUMMARY/,\$p" /var/log/ytunblock/select-quick.log'
t "ipvs=46 progress counts v6 tests" "\"done\":$((8 * N))" sh -c "grep -o '\"done\":[0-9]*' $J | tail -n 1"
t "hosts[] marks passed domains" '"host":"youtubei.googleapis.com","ok":true' sh -c "grep '\"current\":\"www.youtube.com' $J | tail -n 1"
t "deep ipvs=46 found" '"found":true,"strategyId":"bc2-' sel deep 46 95
sel deep 4 0 >/dev/null
echo "INFO deep ipvs=4 all-fail tests: $(grep -c '^- curl_test' /var/log/ytunblock/select-deep.log)"
sel deep 46 0 >/dev/null
echo "INFO deep ipvs=46 all-fail tests: $(grep -c '^- curl_test' /var/log/ytunblock/select-deep.log)"

# criterion: a strategy counts for a domain only if it worked on every IP version
f=$(mktemp -d)
sed -n '/^bc_working()/,/^}/p' $H >"$f/fn.sh"
printf '%s\n' '* SUMMARY' \
	'curl_test_https_tls13 ipv4 d.example : nfqws2 --comment=both --payload=tls_client_hello' \
	'curl_test_https_tls13 ipv6 d.example : nfqws2 --comment=both --payload=tls_client_hello' \
	'curl_test_https_tls13 ipv4 d.example : nfqws2 --comment=v4only --payload=tls_client_hello' \
	'curl_test_https_tls13 ipv6 other.example : nfqws2 --comment=v4only --payload=tls_client_hello' \
	'curl_test_https_tls13 ipv6 d.example : nfqws2 not working' >"$f/out"
t "bc_working ipvs=46 needs both" '^--comment=both --payload=tls_client_hello $' sh -c ". $f/fn.sh; SEL_WORK=$f SEL_NV=2 bc_working d.example"
t "bc_working ipvs=4 takes v4" '^--comment=both .* --comment=v4only' sh -c ". $f/fn.sh; SEL_WORK=$f SEL_NV=1 bc_working d.example"
[ $fail = 0 ] && echo "ALL PASS (simulate)" || echo "SOME FAILED (simulate)"
exit $fail
