# shellcheck shell=sh
# shellcheck disable=SC3043,SC2034
# Shared by install.sh, uninstall.sh and ytu-helper. Paths here are the install contract.

YTU_ROOT=/opt/ytunblock
YTU_Z2=$YTU_ROOT/zapret2
YTU_STRAT=$YTU_ROOT/strategies
YTU_HELPER=$YTU_ROOT/bin/ytu-helper
YTU_STATE=/var/lib/ytunblock
YTU_RUN=/run/ytunblock
YTU_LOGDIR=/var/log/ytunblock
YTU_UNIT=ytunblock.service
YTU_SELECT_UNIT=ytunblock-select.service
YTU_SYSTEMD_DIR=/etc/systemd/system
YTU_POLICY=/usr/share/polkit-1/actions/org.ytunblock.helper.policy
YTU_AA_PROFILE=/etc/apparmor.d/ytunblock-appimage
YTU_MODLOAD=/etc/modules-load.d/ytunblock.conf
YTU_NFT=ytunblock
YTU_QNUM=7713
# nfqws2 default fwmark for generated packets; queue rules skip it to avoid loops
YTU_MARK=0x40000000
YTU_PKT_OUT=20
YTU_PKT_IN=10
YTU_PKT_QUIC=10
YTU_CATALOG=$YTU_STRAT/nfqws2.json
YTU_LIST13=$YTU_STRAT/blockcheck2/list_https_tls13.txt
YTU_HOSTLIST=$YTU_STRAT/hostlist-youtube.txt
# rr*.googlevideo.com node names are ISP-specific and not derivable offline;
# redirector shares the googlevideo.com SNI, which is what DPI matches.
YTU_VIDEO_HOST=redirector.googlevideo.com
YTU_CHECK_HOSTS="youtubei.googleapis.com www.youtube.com $YTU_VIDEO_HOST i.ytimg.com"

PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
# pkexec passes LANG/LC_*; parsing below assumes C collation and messages
LC_ALL=C
export PATH LC_ALL
umask 022

have() { command -v "$1" >/dev/null 2>&1; }
is_root() { [ "$(id -u)" = 0 ]; }

json_str()
{
	printf '%s' "$1" | tr -d '\000-\010\013\014\016-\037' | awk '
		BEGIN { ORS = ""; printf "\"" }
		{ gsub(/\\/, "\\\\"); gsub(/"/, "\\\""); gsub(/\t/, "\\t"); gsub(/\r/, "\\r")
		  if (NR > 1) printf "\\n"; print }
		END { printf "\"" }'
}

# words -> JSON array of strings
json_arr()
{
	local first=1 w
	printf '['
	for w in $1; do
		[ $first = 1 ] || printf ','
		first=0
		json_str "$w"
	done
	printf ']'
}

die()
{
	# $1 - error code from ipc-api.md, $2 - message
	printf '{"error":"%s","message":%s}\n' "$1" "$(json_str "$2")"
	exit 1
}

z2_arch()
{
	case "$(uname -m)" in
		x86_64|amd64) echo linux-x86_64 ;;
		aarch64|arm64) echo linux-arm64 ;;
		*) return 1 ;;
	esac
}

# kernel module is loaded, built in, or present on disk for modprobe.
# Without a module tree (containers) it cannot be judged here: install.sh probes nft queue for real.
kmod_available()
{
	local k
	k=/lib/modules/$(uname -r)
	[ -d "/sys/module/$1" ] || [ ! -d "$k" ] ||
		grep -qs "/$1\.ko" "$k/modules.builtin" ||
		grep -qs "/$1\.ko" "$k/modules.dep" ||
		modinfo "$1" >/dev/null 2>&1
}

apparmor_userns_restricted()
{
	[ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null)" = 1 ]
}

# prints missing requirement names (space separated)
requirements_missing()
{
	local m=
	have nft || m="$m nft"
	kmod_available nfnetlink_queue || [ -e /proc/net/netfilter/nfnetlink_queue ] || m="$m nfnetlink_queue"
	kmod_available nft_queue || m="$m nft_queue"
	have curl || m="$m curl"
	{ [ -d /run/systemd/system ] && have systemctl && have systemd-run; } || m="$m systemd"
	[ "$(cat /proc/sys/net/ipv4/tcp_timestamps 2>/dev/null)" = 0 ] && m="$m tcp_timestamps"
	apparmor_userns_restricted && [ ! -f "$YTU_AA_PROFILE" ] && m="$m apparmor"
	echo $m
}

# soft ones degrade something but do not block the service
requirement_is_hard()
{
	case "$1" in
		tcp_timestamps|apparmor) return 1 ;;
	esac
	return 0
}

requirements_hard_missing()
{
	local r h=
	for r in $(requirements_missing); do
		requirement_is_hard "$r" && h="$h $r"
	done
	echo $h
}

requirements_json()
{
	local m h r
	m=$(requirements_missing)
	h=
	for r in $m; do requirement_is_hard "$r" && h=1; done
	if [ -n "$h" ]; then h=false; else h=true; fi
	printf '{"ok":%s,"missing":%s}' "$h" "$(json_arr "$m")"
}

# root only: nft can create a queue rule (nf_tables + nft_queue)
nft_queue_works()
{
	local t=ytunblock_probe r=1
	nft delete table inet $t 2>/dev/null
	nft add table inet $t 2>/dev/null && {
		nft add chain inet $t c && nft add rule inet $t c queue num $YTU_QNUM bypass 2>/dev/null && r=0
		nft delete table inet $t
	}
	return $r
}

# root only: prints human-readable conflicts, one per line.
# Only real traffic diversion counts; process names prove nothing (userspace byedpi, renamed binaries).
firewall_conflicts()
{
	local p
	if ! systemctl is-active --quiet "$YTU_UNIT" 2>/dev/null &&
		awk -v q="$YTU_QNUM" '$1 == q' /proc/net/netfilter/nfnetlink_queue 2>/dev/null | grep -q .; then
		echo "NFQUEUE $YTU_QNUM is bound by another process"
	fi
	have nft && nft list ruleset 2>/dev/null | awk -v own="inet $YTU_NFT" '
		/^table / { t = $2 " " $3 }
		/ queue / && t != own && t !~ /blockcheck/ { if (!(t in seen)) { seen[t] = 1; print "nft table " t " uses NFQUEUE" } }'
	for p in iptables-legacy ip6tables-legacy; do
		have $p && $p -t mangle -S 2>/dev/null | grep -q NFQUEUE && echo "$p mangle has NFQUEUE rules"
	done
	return 0
}

# helper args come from any process of the active session: ids only, never paths or raw nfqws2 args
valid_id()
{
	case "$1" in
		""|*[!a-z0-9-]*) return 1 ;;
	esac
	[ ${#1} -le 64 ]
}

strategy_file()
{
	# $1 - network id or empty for default
	if [ -n "$1" ]; then
		echo "$YTU_STATE/strategy/net-$1"
	else
		echo "$YTU_STATE/strategy/default"
	fi
}

kv_get()
{
	# $1 - file, $2 - key
	sed -n "s/^$2=//p" "$1" 2>/dev/null | head -n 1
}

current_network()
{
	cat "$YTU_STATE/network" 2>/dev/null
}

# prints the strategy file in effect: network one if present, else default
effective_strategy_file()
{
	local net f
	net=$(current_network)
	if [ -n "$net" ]; then
		f=$(strategy_file "$net")
		[ -f "$f" ] && { echo "$f"; return 0; }
	fi
	f=$(strategy_file "")
	[ -f "$f" ] && { echo "$f"; return 0; }
	return 1
}

# prints nfqws2 args of catalog strategy $1 from root-owned nfqws2.json (pretty-printed, one item per line)
catalog_args()
{
	awk -v want="$1" '
		function unq(x) {
			sub(/^[ \t]*"/, "", x); sub(/",?[ \t]*$/, "", x)
			gsub(/\\"/, "\"", x); gsub(/\\\\/, "\\", x)
			return x
		}
		/^[ \t]*"id":[ \t]*"/ { id = $0; sub(/^[ \t]*"id":[ \t]*"/, "", id); sub(/".*$/, "", id); next }
		id == want && /^[ \t]*"nfqws2":[ \t]*\[/ { inarr = 1; next }
		inarr && /^[ \t]*\]/ { exit }
		inarr { print unq($0) }
	' "$YTU_CATALOG" | sed "s#{FAKE}#$YTU_Z2/files/fake#g"
}

# only desync options pass; anything touching files, privileges or queue setup is refused
args_safe()
{
	local a
	while IFS= read -r a; do
		case "$a" in
			*..*) return 1 ;;
			--blob=*:@"$YTU_Z2"/files/fake/*) ;;
			--blob=*@*) return 1 ;;
			# inline Lua is code: only the forms blockcheck2 standard tests generate (23-seqovl.sh)
			--lua-init=*)
				printf '%s\n' "$a" | grep -Eqx -- "--lua-init=[a-z0-9_]+=tls_mod\([a-z0-9_]+,'rnd'\)" || return 1
				;;
			--lua-desync=luaexec*)
				printf '%s\n' "$a" | grep -Eqx -- "--lua-desync=luaexec:code=desync\.patmod=tls_mod\([a-z0-9_]+,'rnd,dupsid,padencap',desync\.reasm_data\)" || return 1
				;;
			--comment=*|--blob=*|--payload=*|--lua-desync=*|--out-range=*|--in-range=*) ;;
			*) return 1 ;;
		esac
	done
	return 0
}

strategy_exists()
{
	[ -f "$YTU_STATE/custom/$1.args" ] || [ -n "$(catalog_args "$1")" ]
}

# prints nfqws2 args of strategy $1, one per line
strategy_args()
{
	local a
	if [ -f "$YTU_STATE/custom/$1.args" ]; then
		# written by our own root blockcheck2 run, already expanded, no spaces inside args
		a=$(tr -s ' \t' '\n\n' <"$YTU_STATE/custom/$1.args" | grep -v '^$')
	else
		a=$(catalog_args "$1")
	fi
	[ -n "$a" ] || return 1
	printf '%s\n' "$a" | args_safe || return 1
	printf '%s\n' "$a"
}

quic_state()
{
	local q
	q=$(cat "$YTU_STATE/quic" 2>/dev/null)
	[ "$q" = off ] && echo off || echo on
}

nft_ruleset()
{
	cat <<EOF
add table inet $YTU_NFT
delete table inet $YTU_NFT
table inet $YTU_NFT {
	chain out {
		type filter hook output priority -150; policy accept;
		meta mark and $YTU_MARK != 0 return
		tcp dport 443 ct original packets 1-$YTU_PKT_OUT queue num $YTU_QNUM bypass
	}
	chain in {
		type filter hook input priority -150; policy accept;
		tcp sport 443 ct reply packets 1-$YTU_PKT_IN queue num $YTU_QNUM bypass
	}
	chain predefrag {
		type filter hook output priority -401; policy accept;
		meta mark and $YTU_MARK == 0 return
		ip frag-off & 0x1fff != 0 notrack
		exthdr frag exists notrack
		tcp flags & (syn | rst | ack) == 0 notrack
	}
EOF
	# QUIC Initial carries the SNI: nfqws2 drops YouTube QUIC flows (profile in cmd_run)
	[ "$(quic_state)" = on ] && cat <<EOF
	chain quic {
		type filter hook output priority -150; policy accept;
		meta mark and $YTU_MARK != 0 return
		udp dport 443 ct original packets 1-$YTU_PKT_QUIC queue num $YTU_QNUM bypass
	}
EOF
	echo "}"
}

nft_table_exists()
{
	nft list table inet $YTU_NFT >/dev/null 2>&1
}

# blockcheck2 tables left by a killed selection queue traffic to test IPs with no listener
nft_drop_blockcheck_tables()
{
	local t
	for t in $(nft list tables 2>/dev/null | awk '$3 ~ /^blockcheck/ {print $2 ":" $3}'); do
		nft delete table "${t%%:*}" "${t#*:}" 2>/dev/null
	done
	return 0
}

ytu_log()
{
	is_root || return 0
	[ -d "$YTU_LOGDIR" ] || return 0
	local f="$YTU_LOGDIR/helper.log"
	[ -f "$f" ] && [ "$(wc -c <"$f")" -gt 1048576 ] && mv -f "$f" "$f.1"
	printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >>"$f"
	chmod 0644 "$f" 2>/dev/null
}
