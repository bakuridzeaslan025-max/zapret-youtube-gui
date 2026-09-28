#!/bin/sh
# Removes everything install.sh put into the system. Run as root.

HERE=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=lib/common.sh
. "$HERE/lib/common.sh"

is_root || die AUTH_FAILED "uninstall.sh must run as root"

if have systemctl; then
	systemctl stop "$YTU_SELECT_UNIT" >/dev/null 2>&1
	systemctl disable --now "$YTU_UNIT" >/dev/null 2>&1
fi
nft delete table inet "$YTU_NFT" 2>/dev/null
nft_drop_blockcheck_tables
rm -f "$YTU_SYSTEMD_DIR/$YTU_UNIT"
if have systemctl; then
	systemctl daemon-reload 2>/dev/null
	systemctl reset-failed "$YTU_UNIT" "$YTU_SELECT_UNIT" 2>/dev/null
fi

if [ -f "$YTU_AA_PROFILE" ]; then
	have apparmor_parser && apparmor_parser -R "$YTU_AA_PROFILE" >/dev/null 2>&1
	rm -f "$YTU_AA_PROFILE"
fi
rm -f "$YTU_POLICY" "$YTU_MODLOAD"
rm -rf "$YTU_ROOT" "$YTU_ROOT.new" "$YTU_ROOT.old" "$YTU_STATE" "$YTU_LOGDIR" "$YTU_RUN"

echo '{"ok":true}'
