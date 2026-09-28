#!/bin/sh
# shellcheck disable=SC3043
# Installs ytunblock into /opt/ytunblock. Run as root (pkexec) from a readable copy of the payload:
#   <payload>/system/install.sh  (+ <payload>/system/vendor/zapret2, <payload>/strategies)
# Usage: install.sh [--appimage PATH] [--exec-name NAME] [--no-deps]
# Output: JSON lines {"event":"step",...}, last line {"ok":true,...} or {"error":CODE,...}. Idempotent.

SRC=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=lib/common.sh
. "$SRC/lib/common.sh"

Z2_SRC=$SRC/vendor/zapret2
STRAT_SRC=$(cd "$SRC/../strategies" 2>/dev/null && pwd)
APPIMAGE=
EXEC_NAME=ytunblock
DEPS=1

while [ $# -gt 0 ]; do
	case "$1" in
		--appimage) APPIMAGE=$2; shift 2 ;;
		--exec-name) EXEC_NAME=$2; shift 2 ;;
		--no-deps) DEPS=0; shift ;;
		*) die HELPER_FAILED "unknown argument: $1" ;;
	esac
done

STEP=0
STEPS=8
step()
{
	case "$1" in
		deps:*) ;;
		*) STEP=$((STEP + 1)) ;;
	esac
	printf '{"event":"step","step":%s,"done":%s,"total":%s}\n' "$(json_str "$1")" $((STEP - 1)) $STEPS
}

is_root || die AUTH_FAILED "install.sh must run as root"
ARCH=$(z2_arch) || die MISSING_REQUIREMENTS "unsupported architecture: $(uname -m)"
[ -x "$Z2_SRC/binaries/$ARCH/nfqws2" ] || [ -f "$Z2_SRC/binaries/$ARCH/nfqws2" ] ||
	die HELPER_FAILED "payload incomplete: $Z2_SRC/binaries/$ARCH/nfqws2"
[ -f "$STRAT_SRC/blockcheck2/list_https_tls13.txt" ] || die HELPER_FAILED "payload incomplete: strategies"
case "$EXEC_NAME" in
	""|*[!A-Za-z0-9._-]*) die HELPER_FAILED "bad --exec-name" ;;
esac

# requirement -> package, per package manager
pkg_for()
{
	# $1 - manager, $2 - requirement
	case "$1:$2" in
		apt:nft) echo nftables ;;
		dnf:nft|zypper:nft|pacman:nft) echo nftables ;;
		*:curl) echo curl ;;
	esac
}

install_deps()
{
	local mgr='' r p pkgs=''
	if have apt-get; then mgr=apt
	elif have dnf; then mgr=dnf
	elif have zypper; then mgr=zypper
	elif have pacman; then mgr=pacman
	else return 1
	fi
	for r in $1; do
		p=$(pkg_for $mgr "$r")
		[ -n "$p" ] && pkgs="$pkgs $p"
	done
	[ -n "$pkgs" ] || return 1
	step "deps:$mgr:$(echo $pkgs)"
	# shellcheck disable=SC2086
	case $mgr in
		apt)
			export DEBIAN_FRONTEND=noninteractive
			apt-get install -y -q --no-install-recommends $pkgs >&2 ||
				{ apt-get update -q >&2 && apt-get install -y -q --no-install-recommends $pkgs >&2; }
			;;
		dnf) dnf install -y -q $pkgs >&2 ;;
		zypper) zypper --non-interactive install $pkgs >&2 ;;
		pacman) pacman -S --noconfirm --needed $pkgs >&2 ;;
	esac
}

step requirements
modprobe -q nfnetlink_queue 2>/dev/null
modprobe -q nft_queue 2>/dev/null
missing=$(requirements_hard_missing)
if [ -n "$missing" ] && [ $DEPS = 1 ]; then
	install_deps "$missing"
	missing=$(requirements_hard_missing)
fi
if [ -z "$missing" ] && ! nft_queue_works; then
	missing="nfnetlink_queue nft_queue"
fi
[ -z "$missing" ] || {
	printf '{"error":"MISSING_REQUIREMENTS","message":%s,"missing":%s}\n' \
		"$(json_str "missing: $missing")" "$(json_arr "$missing")"
	exit 1
}

step stop
# the helper's lock: no passwordless select/start/apply can begin while /opt is being replaced
mkdir -p "$YTU_RUN"
exec 8>"$YTU_RUN/lock"
flock -n 8 || die BUSY "another helper command is running"
# replacing /opt under a running blockcheck2 would pull nfqws2 from under it
case "$(systemctl is-active "$YTU_SELECT_UNIT" 2>/dev/null)" in
	active|activating|deactivating) die BUSY "strategy selection is running" ;;
esac
was_active=0
if systemctl is-active --quiet "$YTU_UNIT" 2>/dev/null; then
	was_active=1
	systemctl stop "$YTU_UNIT"
fi

step copy
NEW=$YTU_ROOT.new
rm -rf "$NEW"
mkdir -p "$NEW/bin" "$NEW/lib" "$NEW/zapret2/nfq2" "$NEW/zapret2/mdig" "$NEW/zapret2/files" \
	"$NEW/zapret2/blockcheck2.d" "$NEW/strategies/blockcheck2" "$NEW/licenses" || die HELPER_FAILED "mkdir $NEW"
{
	cp "$SRC/bin/ytu-helper" "$NEW/bin/" &&
	cp "$SRC/lib/common.sh" "$NEW/lib/" &&
	cp "$SRC/uninstall.sh" "$NEW/" &&
	cp -R "$SRC/libexec" "$NEW/" &&
	cp "$Z2_SRC/binaries/$ARCH/nfqws2" "$NEW/zapret2/nfq2/" &&
	cp "$Z2_SRC/binaries/$ARCH/mdig" "$NEW/zapret2/mdig/" &&
	cp -R "$Z2_SRC/lua" "$Z2_SRC/common" "$NEW/zapret2/" &&
	cp -R "$Z2_SRC/files/fake" "$NEW/zapret2/files/" &&
	cp -R "$Z2_SRC/blockcheck2.d/standard" "$Z2_SRC/blockcheck2.d/custom" "$NEW/zapret2/blockcheck2.d/" &&
	cp "$Z2_SRC/blockcheck2.sh" "$Z2_SRC/config.default" "$NEW/zapret2/" &&
	cp "$Z2_SRC/config.default" "$NEW/zapret2/config" &&
	cp "$STRAT_SRC/nfqws2.json" "$STRAT_SRC/hostlist-youtube.txt" "$NEW/strategies/" &&
	cp "$STRAT_SRC/blockcheck2/list_https_tls12.txt" "$STRAT_SRC/blockcheck2/list_https_tls13.txt" "$NEW/strategies/blockcheck2/" &&
	cp "$SRC/licenses/zapret2-LICENSE.txt" "$NEW/licenses/" &&
	cp "$SRC/licenses/flowseal-LICENSE.txt" "$NEW/licenses/"
} || die HELPER_FAILED "copy failed"
printf 'zapret2 %s\n' "$(cat "$Z2_SRC/VERSION" 2>/dev/null)" >"$NEW/VERSION"

# nfqws2 drops root before reading lua/blobs: everything must be world-readable
chown -R root:root "$NEW"
find "$NEW" -type d -exec chmod 0755 {} +
find "$NEW" -type f -exec chmod 0644 {} +
chmod 0755 "$NEW"/libexec/shim/* "$NEW/bin/ytu-helper" "$NEW/uninstall.sh" "$NEW/zapret2/nfq2/nfqws2" "$NEW/zapret2/mdig/mdig" \
	"$NEW/zapret2/blockcheck2.sh"
rm -rf "$YTU_ROOT.old"
[ -d "$YTU_ROOT" ] && mv "$YTU_ROOT" "$YTU_ROOT.old"
mv "$NEW" "$YTU_ROOT" || die HELPER_FAILED "cannot move into $YTU_ROOT"
rm -rf "$YTU_ROOT.old"
# every path component up to the lua files must be traversable by nobody
d=$(dirname "$YTU_ROOT")
while [ "$d" != / ]; do
	[ "$(stat -c %A "$d" | cut -c 10)" = x ] || chmod o+x "$d"
	d=$(dirname "$d")
done

step state
mkdir -p "$YTU_STATE/strategy" "$YTU_STATE/custom" "$YTU_LOGDIR"
chmod 0755 "$YTU_STATE" "$YTU_STATE/strategy" "$YTU_STATE/custom" "$YTU_LOGDIR"
[ -f "$YTU_STATE/quic" ] || echo on >"$YTU_STATE/quic"
# drop strategy references that no longer exist after an upgrade
for f in "$YTU_STATE"/strategy/*; do
	[ -f "$f" ] || continue
	id=$(kv_get "$f" id)
	strategy_exists "$id" || rm -f "$f"
done

step systemd
install -m 0644 "$SRC/units/$YTU_UNIT" "$YTU_SYSTEMD_DIR/$YTU_UNIT"
# leftovers of older versions
rm -f "$YTU_SYSTEMD_DIR/ytunblock-refresh.service" "$YTU_SYSTEMD_DIR/ytunblock-refresh.timer"
printf 'nfnetlink_queue\nnft_queue\n' >"$YTU_MODLOAD"
systemctl daemon-reload

step polkit
mkdir -p "$(dirname "$YTU_POLICY")"
install -m 0644 "$SRC/polkit/org.ytunblock.helper.policy" "$YTU_POLICY"

step apparmor
aa=skipped
aa_note=
if apparmor_userns_restricted; then
	aa=unsupported
	if have apparmor_parser && [ -f /etc/apparmor.d/abi/4.0 ]; then
		# type2 runtime mounts at /tmp/.mount_<first 6 chars of the file name><6 random chars>.
		# Any user can create such a path, so the glob is narrowed to our file name prefix;
		# a renamed AppImage needs a reinstall to keep the sandbox.
		prefix=$(basename "$APPIMAGE" 2>/dev/null | cut -c 1-6)
		case "$prefix" in
			""|*[!A-Za-z0-9._-]*)
				attach="/tmp/.mount_*/$EXEC_NAME"
				aa_note="AppImage name '$(basename "$APPIMAGE" 2>/dev/null)' is empty or not plain ASCII: AppArmor profile allows any /tmp/.mount_*/$EXEC_NAME"
				;;
			*)
				attach="/tmp/.mount_$prefix??????/$EXEC_NAME"
				aa_note="AppArmor profile is bound to AppImage names starting with '$prefix': after renaming the file reinstall, otherwise the Chromium sandbox fails to start"
				;;
		esac
		ytu_log "$aa_note"
		echo "$aa_note" >&2
		cat >"$YTU_AA_PROFILE" <<EOF
# ytunblock: lets the Electron AppImage create user namespaces for the Chromium sandbox
# (kernel.apparmor_restrict_unprivileged_userns=1, Ubuntu 23.10+)
abi <abi/4.0>,
include <tunables/global>

profile ytunblock-appimage "$attach" flags=(unconfined) {
  userns,

  include if exists <local/ytunblock-appimage>
}
EOF
		chmod 0644 "$YTU_AA_PROFILE"
		if apparmor_parser -r "$YTU_AA_PROFILE" >&2; then
			aa=loaded
		else
			rm -f "$YTU_AA_PROFILE"
			aa=failed
		fi
	fi
fi

step start
[ $was_active = 1 ] && systemctl start "$YTU_UNIT"

ytu_log "install $(cat "$YTU_ROOT/VERSION") arch=$ARCH apparmor=$aa"
printf '{"ok":true,"version":%s,"apparmor":"%s","apparmorNote":%s,"requirements":%s}\n' \
	"$(json_str "$(cat "$YTU_ROOT/VERSION")")" "$aa" "$(json_str "$aa_note")" "$(requirements_json)"
