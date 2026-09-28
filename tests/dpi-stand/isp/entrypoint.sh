#!/bin/sh
set -eu
: "${SERVER_IP:?}"

wan_if=$(ip -o -4 addr show | awk -v ip="${SERVER_IP%.*}." 'index($4, ip) == 1 {print $2; exit}')
lan_ip=$(ip -o -4 addr show | awk -v w="$wan_if" '$2 != w && $2 != "lo" {sub("/.*", "", $4); print $4; exit}')
iptables -t nat -A POSTROUTING -o "$wan_if" -j MASQUERADE

# The stand has no internet: stand names resolve to the server.
cat >/etc/dnsmasq.d/stand.conf <<EOF
no-resolv
no-hosts
listen-address=$lan_ip
bind-interfaces
address=/youtube.com/$SERVER_IP
address=/youtubei.googleapis.com/$SERVER_IP
address=/ytimg.com/$SERVER_IP
address=/googlevideo.com/$SERVER_IP
address=/example.org/$SERVER_IP
EOF
dnsmasq --conf-dir=/etc/dnsmasq.d --log-facility=/var/log/dnsmasq.log

dpi-mode "${DPI_MODE:-none}"
exec sleep infinity
