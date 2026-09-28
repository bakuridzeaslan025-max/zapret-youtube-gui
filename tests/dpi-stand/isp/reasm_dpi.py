#!/usr/bin/env python3
"""Reassembling fake DPI for the dpi-stand (NFQUEUE, client->server tcp/443 only).

Per flow it reassembles the client stream until the first TLS record is complete,
extracts SNI and latches a verdict: block (drop this and all later packets of the
flow) or allow. Deliberate simplifications that decide which tricks pass:
  - stream start = ISN+1 from the SYN (REASM_TRACK_ISN=1, default) or the seq of
    the first data segment seen (REASM_TRACK_ISN=0); data carried in SYN is ignored;
  - overlapping bytes: first write wins;
  - no validation of TCP timestamps, checksums or seq/ack windows;
  - unparseable or non-TLS start of stream -> allow (fail-open);
  - a SYN on a tuple with a verdict does not reset it unless the flow was idle > VERDICT_HOLD s;
  - SNI match is case-insensitive; IP fragments and malformed packets are accepted.
"""
import os
import struct
import sys
import time

from netfilterqueue import NetfilterQueue

TOKENS = [t.lower().encode() for t in os.environ.get("DPI_TOKENS", "youtube").split()]
LIMIT = int(os.environ.get("REASM_LIMIT", "16384"))
TRACK_ISN = os.environ.get("REASM_TRACK_ISN", "1") == "1"
FLOW_TTL = 60
VERDICT_HOLD = 10


class Flow:
    __slots__ = ("base", "buf", "filled", "verdict", "seen")

    def __init__(self):
        self.base = None
        self.buf = bytearray(LIMIT)
        self.filled = bytearray(LIMIT)
        self.verdict = None
        self.seen = time.monotonic()

    def write(self, seq, data):
        if self.base is None:
            self.base = seq
        off = (seq - self.base) & 0xFFFFFFFF
        if off >= 1 << 31:
            off -= 1 << 32
        for i, b in enumerate(data):
            p = off + i
            if 0 <= p < LIMIT and not self.filled[p]:
                self.buf[p] = b
                self.filled[p] = 1

    def prefix(self):
        n = self.filled.find(0)
        return LIMIT if n < 0 else n


def parse_sni(rec):
    """rec = full TLS record. Returns SNI bytes, or None if it can't be parsed."""
    try:
        if rec[0] != 0x16 or rec[5] != 0x01:
            return None
        p = 5 + 4 + 2 + 32
        p += 1 + rec[p]
        p += 2 + struct.unpack_from("!H", rec, p)[0]
        p += 1 + rec[p]
        end = min(len(rec), p + 2 + struct.unpack_from("!H", rec, p)[0])
        p += 2
        while p + 4 <= end:
            etype, elen = struct.unpack_from("!HH", rec, p)
            p += 4
            if etype == 0:
                nlen = struct.unpack_from("!H", rec, p + 3)[0]
                return bytes(rec[p + 5:p + 5 + nlen])
            p += elen
    except (IndexError, struct.error):
        pass
    return None


def decide(flow):
    n = flow.prefix()
    if n == 0:
        return None
    if flow.buf[0] != 0x16:
        return "allow", "not tls"
    if n < 5:
        return None
    need = min(LIMIT, 5 + struct.unpack_from("!H", flow.buf, 3)[0])
    if n < need:
        return None
    sni = parse_sni(flow.buf[:need])
    if sni is None:
        return "allow", "unparseable"
    if any(t in sni.lower() for t in TOKENS):
        return "block", sni.decode(errors="replace")
    return "allow", sni.decode(errors="replace")


flows = {}
last_gc = time.monotonic()


def handle(pkt):
    try:
        verdict = inspect(pkt.get_payload())
    except (IndexError, struct.error) as e:
        print(f"malformed packet, accept: {e}", flush=True)
        verdict = "accept"
    pkt.drop() if verdict == "drop" else pkt.accept()


def inspect(p):
    global last_gc
    if p[9] != 6 or struct.unpack_from("!H", p, 6)[0] & 0x3FFF:
        return "accept"  # not TCP, or an IP fragment: not modelled
    ihl = (p[0] & 0x0F) * 4
    p = p[:struct.unpack_from("!H", p, 2)[0]]
    src, dst = p[12:16], p[16:20]
    sport, dport, seq = struct.unpack_from("!HHI", p, ihl)
    doff = (p[ihl + 12] >> 4) * 4
    flags = p[ihl + 13]
    key = (src, sport, dst, dport)
    now = time.monotonic()

    if now - last_gc > 10:
        last_gc = now
        for k in [k for k, f in flows.items() if now - f.seen > FLOW_TTL]:
            del flows[k]

    flow = flows.get(key)
    # A SYN can't reset a fresh verdict (re-SYN evasion); an idle tuple may be legitimately reused.
    if flags & 0x02 and (flow is None or flow.verdict is None or now - flow.seen > VERDICT_HOLD):
        flow = flows[key] = Flow()
        if TRACK_ISN:
            flow.base = (seq + 1) & 0xFFFFFFFF
        return "accept"
    if flow is None:
        flow = flows[key] = Flow()
    flow.seen = now
    data = p[ihl + doff:]

    if flow.verdict == "block":
        return "drop"
    if flow.verdict == "allow" or not data or flags & 0x02:
        return "accept"

    flow.write(seq, data)
    res = decide(flow)
    if res is None:
        return "accept"
    flow.verdict, why = res
    print(f"{'.'.join(map(str, src))}:{sport} {flow.verdict} ({why})", flush=True)
    return "drop" if flow.verdict == "block" else "accept"


def main():
    q = NetfilterQueue()
    q.bind(int(sys.argv[1]), handle)
    print(f"reasm_dpi: queue {sys.argv[1]}, tokens {TOKENS}, track_isn {TRACK_ISN}", flush=True)
    try:
        q.run()
    finally:
        q.unbind()


if __name__ == "__main__":
    main()
