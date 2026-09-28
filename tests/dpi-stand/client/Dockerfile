FROM ubuntu:24.04
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
		ca-certificates curl nftables iproute2 bsdextrautils dnsutils netcat-openbsd \
		iputils-ping procps tcpdump \
	&& rm -rf /var/lib/apt/lists/*
COPY entrypoint.sh bypass /usr/local/bin/
RUN chmod 755 /usr/local/bin/entrypoint.sh /usr/local/bin/bypass
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
