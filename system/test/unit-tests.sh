#!/bin/sh
# Non-privileged checks (no nft/systemd needed). Run as root inside a plain container:
#   docker run --rm -v <repo>:/src:ro <image> sh /src/system/test/unit-tests.sh
S=/src/system
H=$S/bin/ytu-helper
fail=0
t() {
	# $1 name, $2 expected ERE, rest: command
	n=$1 e=$2
	shift 2
	o=$("$@" 2>&1 | tr '\n' ' ')
	if printf '%s' "$o" | grep -qE -- "$e"; then echo "PASS $n"; else echo "FAIL $n: $o"; fail=1; fi
}
safe() { printf '%s\n' "$@" | (. $S/lib/common.sh; args_safe) && echo safe || echo refused; }

t "lua os[] refused" '^refused' safe "--lua-init=os[\"execute\"](\"id\")"
t "lua io[] refused" '^refused' safe "--lua-init=io[\"popen\"](\"id\")"
t "lua file refused" '^refused' safe "--lua-init=@/tmp/x.lua"
t "luaexec arbitrary refused" '^refused' safe "--lua-desync=luaexec:code=os.execute('id')"
t "blockcheck tls_mod lua-init ok" '^safe' safe "--lua-init=fake_default_tls=tls_mod(fake_default_tls,'rnd')"
t "blockcheck padencap luaexec ok" '^safe' safe "--lua-desync=luaexec:code=desync.patmod=tls_mod(fake_default_tls,'rnd,dupsid,padencap',desync.reasm_data)"
t "blob outside fake refused" '^refused' safe "--blob=x:@/etc/shadow"
t "debug refused" '^refused' safe "--debug=@/etc/passwd"
t "catalog strategies all safe" '^0 $' sh -c ". $S/lib/common.sh; YTU_CATALOG=/src/strategies/nfqws2.json; n=0; for id in \$(sed -n 's/^ *\"id\": \"\\([^\"]*\\)\".*/\\1/p' \$YTU_CATALOG); do catalog_args \$id | args_safe || n=\$((n+1)); done; echo \$n"
t "LC_ALL=C" '^C $' sh -c ". $S/lib/common.sh; echo \$LC_ALL"
for c in _pre-start _run _post-stop _select-run; do
	t "$c refused via pkexec" 'internal command' env PKEXEC_UID=1000 INVOCATION_ID=x sh $H $c quick
	t "$c refused outside systemd" 'internal command' env -u INVOCATION_ID sh $H $c quick
done
t "uninstall no longer a helper command" 'unknown command' sh $H uninstall
mkdir -p /run/ytunblock /var/lib/ytunblock
printf '%s\n' '{"event":"progress","mode":"quick","done":1}' '{"event":"done","mode":"quick","found":true,"strategyId":"x"}' >/run/ytunblock/select.jsonl
t "follow on finished select gives only result" '^\{"event":"done","mode":"quick","found":true,"strategyId":"x"\} $' sh $H select-follow
: >/run/ytunblock/select.jsonl
rm -f /var/lib/ytunblock/last-select.json
t "follow without select: none" '"event":"none"' sh $H select-follow
t "strict follow on dead unit: error" '"error":"HELPER_FAILED"' sh $H select-follow strict
t "which shim" '/bin/sh' env PATH="/usr/bin:/bin:$S/libexec/shim" sh -c 'which sh'
t "blockcheck2 exists() through shims" '^ok' env PATH="/usr/bin:/bin:$S/libexec/shim" sh -c ". $S/vendor/zapret2/common/base.sh; exists sh && exists nslookup && exists hexdump && echo ok"
t "hexdump shim format" '^[0-9a-f]{32}$' sh -c "head -c 16 /dev/urandom | $S/libexec/shim/hexdump -e '1 \"%02x\"'"
[ $fail = 0 ] && echo "ALL PASS (unit)" || echo "SOME FAILED (unit)"
exit $fail
