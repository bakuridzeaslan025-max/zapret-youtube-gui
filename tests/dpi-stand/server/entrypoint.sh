#!/bin/sh
set -eu
# One CA for the stand; server cert carries every stand name as SAN.
cd /pki
if [ ! -s ca.crt ] || [ ! -s server.crt ]; then
	openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 3650 \
		-subj "/CN=dpi-stand CA" -keyout ca.key -out ca.crt.tmp
	openssl req -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes \
		-subj "/CN=www.youtube.com" -keyout server.key -out server.csr
	printf 'subjectAltName=%s\n' \
		"DNS:www.youtube.com,DNS:*.youtube.com,DNS:youtubei.googleapis.com,DNS:i.ytimg.com,DNS:*.googlevideo.com,DNS:example.org" \
		>san.ext
	openssl x509 -req -in server.csr -CA ca.crt.tmp -CAkey ca.key -CAcreateserial \
		-days 3650 -extfile san.ext -out server.crt
	chmod 644 server.key
	mv ca.crt.tmp ca.crt
fi
exec nginx -g 'daemon off;'
