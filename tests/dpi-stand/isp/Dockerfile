FROM ubuntu:24.04
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
		iproute2 iptables dnsmasq tcpdump python3 python3-pip python3-dev gcc libc6-dev \
		libnetfilter-queue-dev libnfnetlink-dev \
	&& pip3 install --no-cache-dir --break-system-packages NetfilterQueue==1.1.0 \
	&& apt-get purge -y gcc python3-dev && apt-get autoremove -y && rm -rf /var/lib/apt/lists/* \
	&& python3 -c 'import netfilterqueue'
COPY entrypoint.sh dpi-mode reasm_dpi.py /usr/local/bin/
RUN chmod 755 /usr/local/bin/entrypoint.sh /usr/local/bin/dpi-mode
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
