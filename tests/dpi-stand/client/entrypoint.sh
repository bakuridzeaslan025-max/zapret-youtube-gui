#!/bin/sh
set -eu
: "${ISP_IP:?}"

ip route replace default via "$ISP_IP"
echo "nameserver $ISP_IP" >/etc/resolv.conf

i=0
until [ -s /pki/ca.crt ]; do
	i=$((i + 1)); [ $i -lt 100 ] || { echo "no /pki/ca.crt" >&2; exit 1; }
	sleep 0.1
done
cp /pki/ca.crt /usr/local/share/ca-certificates/dpi-stand.crt
update-ca-certificates >/dev/null

# Copy out of the bind mount: nfqws2 drops root to an unprivileged uid before reading lua.
src=/repo/tests/dpi-stand/.cache/zapret2
if [ -x "$src/blockcheck2.sh" ]; then
	rm -rf /opt/zapret2
	cp -R "$src" /opt/zapret2
	case $(uname -m) in
		aarch64) arch=linux-arm64 ;;
		x86_64) arch=linux-x86_64 ;;
		*) echo "unsupported arch $(uname -m)" >&2; exit 1 ;;
	esac
	cp /opt/zapret2/binaries/$arch/nfqws2 /opt/zapret2/nfq2/nfqws2
	cp /opt/zapret2/binaries/$arch/mdig /opt/zapret2/mdig/mdig
	chmod -R a+rX /opt/zapret2
else
	echo "WARNING: $src missing, run ./run.sh fetch" >&2
fi

exec sleep infinity
