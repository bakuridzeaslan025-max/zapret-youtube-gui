#!/usr/bin/env python3
"""Extract YouTube TCP/TLS strategies from a flowseal/zapret-discord-youtube clone.

Usage: extract_flowseal.py <clone_dir> [--nfqws-src <zapret>/nfq/nfqws.c]
"""
import argparse
import datetime
import json
import re
import subprocess
from pathlib import Path

HERE = Path(__file__).resolve().parent

# Defaults service.bat sets when Game Filter is disabled: port 12 is a dummy that never matches.
BAT_VARS = {"GameFilter": "12", "GameFilterTCP": "12", "GameFilterUDP": "12"}

WINDOWS_ONLY_PREFIXES = ("--wf-", "--ssid-filter", "--nlm-")
MATCH_OPTS = {
    "--filter-tcp", "--filter-udp", "--filter-l3", "--filter-l7",
    "--hostlist", "--hostlist-exclude", "--hostlist-domains", "--hostlist-exclude-domains",
    "--ipset", "--ipset-exclude", "--ipset-ip", "--ipset-exclude-ip",
}
YT_PROBE_HOSTS = ["www.youtube.com", "youtubei.googleapis.com", "i.ytimg.com", "rr1---sn-abc.googlevideo.com"]
YT_DOMAIN_RE = re.compile(r"(youtu|yt-video|ytimg|ggpht|googlevideo|^yt3\.googleusercontent\.com$|^jnn-pa\.googleapis\.com$)")
# Files service.bat creates on the user's machine; they are not in the repo.
USER_LIST_RE = re.compile(r"-user\.txt$")

# Per-option caveats for Linux nfqws (zapret1). Only facts verified against zapret docs/source.
LINUX_NOTES = {
    "--dpi-desync-fooling=ts": "fooling=ts needs TCP timestamps; on Linux they are on by default "
                               "(net.ipv4.tcp_timestamps=1), check it is not disabled",
    "syndata": "desync=syndata acts on the SYN: nft/iptables rules must queue the outgoing SYN too",
    "--ip-id": "--ip-id exists in zapret1 nfqws, but needs a recent nfqws build (check --help of the bundled binary)",
}


def git_head(repo):
    try:
        return subprocess.check_output(["git", "-C", str(repo), "rev-parse", "HEAD"], text=True).strip()
    except (OSError, subprocess.CalledProcessError):
        return None


def winws_command(bat_text):
    """Return the winws.exe command line with ^-continuations joined."""
    logical, buf = [], ""
    for line in bat_text.splitlines():
        s = line.rstrip()
        if s.endswith("^"):
            buf += s[:-1] + " "
            continue
        logical.append(buf + s)
        buf = ""
    if buf:
        logical.append(buf)
    for line in logical:
        if "winws.exe" in line:
            return line.split("winws.exe", 1)[1].lstrip('"').strip()
    return None


def tokenize(cmd):
    """cmd.exe-like split: quotes group and are removed, ^ escapes the next char outside quotes."""
    tokens, cur, in_q, have, i = [], "", False, False, 0
    while i < len(cmd):
        c = cmd[i]
        if c == '"':
            in_q, have = not in_q, True
        elif c == "^" and not in_q and i + 1 < len(cmd):
            i += 1
            cur += cmd[i]
            have = True
        elif c.isspace() and not in_q:
            if have:
                tokens.append(cur)
            cur, have = "", False
        else:
            cur += c
            have = True
        i += 1
    if have:
        tokens.append(cur)
    return tokens


def substitute(token):
    token = token.replace("%BIN%", "{BIN}/").replace("%LISTS%", "{LISTS}/")
    for k, v in BAT_VARS.items():
        token = token.replace(f"%{k}%", v)
    return token


def split_opt(tok):
    if "=" in tok:
        k, v = tok.split("=", 1)
        return k, v
    return tok, None


def parse_ports(spec):
    ports = []
    for part in spec.split(","):
        part = part.strip()
        if not part:
            continue
        if "-" in part:
            a, b = part.split("-", 1)
            ports.append((int(a), int(b)))
        else:
            ports.append((int(part), int(part)))
    return ports


def port_in(ports, p):
    return any(a <= p <= b for a, b in ports)


def load_hostlist(path):
    if not path.exists():
        return None
    out = []
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = line.strip()
        if line and not line.startswith("#"):
            out.append(line.lower())
    return out


def host_matches(host, entries):
    """zapret hostlist semantics: 'a.b' matches a.b and subdomains; '^a.b' matches exactly a.b."""
    for e in entries:
        if e.startswith("^"):
            if host == e[1:]:
                return True
        elif host == e or host.endswith("." + e):
            return True
    return False


def ipset_is_placeholder(path):
    """flowseal ships ipset-all.txt as a TEST-NET-3 dummy when the IPSet filter is 'none'."""
    if not path.exists():
        return True
    lines = [l.strip() for l in path.read_text().splitlines() if l.strip() and not l.startswith("#")]
    return all(l.startswith("203.0.113.") for l in lines)


def list_path(placeholder, clone):
    if placeholder.startswith("{LISTS}/"):
        return clone / "lists" / placeholder[len("{LISTS}/"):]
    if placeholder.startswith("{BIN}/"):
        return clone / "bin" / placeholder[len("{BIN}/"):]
    return None


def analyze_profile(args, clone):
    opts = [split_opt(a) for a in args]
    get = lambda k: [v for kk, v in opts if kk == k]

    tcp = get("--filter-tcp")
    udp = get("--filter-udp")
    l7 = [x for v in get("--filter-l7") for x in v.split(",")]
    # zapret: with only one of filter-tcp/filter-udp set, the other protocol is not matched.
    tcp_ports = parse_ports(",".join(tcp)) if tcp else (None if not udp else [])
    udp_ports = parse_ports(",".join(udp)) if udp else (None if not tcp else [])

    hostlists = get("--hostlist")
    hostlist_domains = [d for v in get("--hostlist-domains") for d in v.split(",")]
    hl_excl = get("--hostlist-exclude")
    hl_excl_domains = [d for v in get("--hostlist-exclude-domains") for d in v.split(",")]
    ipsets = get("--ipset")

    tags, notes = [], []
    if udp or "quic" in l7:
        tags.append("udp")
    if "quic" in l7 or (udp and port_in(udp_ports, 443)):
        tags.append("quic")
    if "discord" in l7 or any("discord" in d for d in hostlist_domains) or (
            tcp_ports and port_in(tcp_ports, 2053) and not port_in(tcp_ports, 443)):
        tags.append("discord")
    if tcp == ["12"] or udp == ["12"]:
        tags.append("game_filter")

    include_entries, missing = [], []
    for h in hostlists:
        entries = load_hostlist(list_path(h, clone))
        if entries is None:
            missing.append(h)
        else:
            include_entries += entries
    include_entries += [d.lower() for d in hostlist_domains]
    exclude_entries = [d.lower() for d in hl_excl_domains]
    for h in hl_excl:
        exclude_entries += load_hostlist(list_path(h, clone)) or []

    ipset_active = [i for i in ipsets if not ipset_is_placeholder(list_path(i, clone))]
    if ipsets and not ipset_active:
        notes.append("ipset-all.txt is a placeholder by default (IPSet filter 'none'); profile matches nothing "
                     "unless the user switches IPSet to 'loaded'")

    catch_all = not hostlists and not hostlist_domains and not ipsets
    if hostlists or hostlist_domains:
        yt_hosts = [h for h in YT_PROBE_HOSTS
                    if host_matches(h, include_entries) and not host_matches(h, exclude_entries)]
    elif catch_all and tcp_ports != []:
        yt_hosts = [h for h in YT_PROBE_HOSTS if not host_matches(h, exclude_entries)]
        notes.append("no hostlist/ipset: profile applies to ALL traffic on its ports")
    else:
        yt_hosts = []

    tcp_web = tcp_ports is None or port_in(tcp_ports, 443) or port_in(tcp_ports, 80)
    l7_web = not l7 or "tls" in l7 or "http" in l7
    relevant = bool(tcp_web and l7_web and yt_hosts and "game_filter" not in tags)
    if relevant and tcp_ports and port_in(tcp_ports, 2053):
        notes.append("port filter also includes Discord ports")
    if relevant and (hostlists and "list-google.txt" in " ".join(hostlists)):
        tags.append("google")
    if relevant and yt_hosts != YT_PROBE_HOSTS:
        notes.append("covers only: " + ", ".join(yt_hosts))

    return {
        "tcp": ",".join(tcp) if tcp else None,
        "udp": ",".join(udp) if udp else None,
        "l7": l7 or None,
        "hostlists": hostlists,
        "hostlist_domains": hostlist_domains,
        "hostlist_excludes": hl_excl + hl_excl_domains,
        "ipsets": ipsets,
        "ipset_excludes": get("--ipset-exclude"),
        "user_lists": sorted({v for _, v in opts if v and USER_LIST_RE.search(v)}),
        "tags": sorted(set(tags)),
        "relevant_youtube": relevant,
        "youtube_hosts_matched": yt_hosts,
        "notes": notes,
    }


def nfqws_known_options(src):
    """Long options nfqws accepts on Linux (drops #elif __CYGWIN__/BSD branches)."""
    text = Path(src).read_text(errors="replace")
    body = text[text.index("long_options[]"):]
    body = body[:body.index("IDX_LAST] = {NULL")]
    known, skip = set(), []
    for line in body.splitlines():
        s = line.strip()
        if s.startswith("#ifdef") or s.startswith("#ifndef"):
            cond = s.split(None, 1)[1]
            active = (cond == "__linux__") if s.startswith("#ifdef") else (cond != "__linux__")
            skip.append(not active)
        elif s.startswith("#elif"):
            skip[-1] = "__linux__" not in s
        elif s.startswith("#else"):
            skip[-1] = not skip[-1]
        elif s.startswith("#endif"):
            skip.pop()
        elif not any(skip):
            m = re.search(r'\{"([a-z0-9-]+)"', s)
            if m:
                known.add("--" + m.group(1))
    return known


def to_nfqws1(args, known):
    out, notes = [], []
    for a in args:
        k, v = split_opt(a)
        if k.startswith(WINDOWS_ONLY_PREFIXES):
            continue
        out.append(a)
        if known is not None and k not in known:
            notes.append(f"{k}: not found in nfqws Linux option table")
    joined = " ".join(out)
    for key, note in LINUX_NOTES.items():
        if key in joined and note not in notes:
            notes.append(note)
    return out, notes


def files_used(args):
    bins, lists = set(), set()
    for a in args:
        _, v = split_opt(a)
        if not v:
            continue
        for m in re.finditer(r"\{BIN\}/([^,\s]+)", v):
            bins.add(m.group(1))
        for m in re.finditer(r"\{LISTS\}/([^,\s]+)", v):
            lists.add(m.group(1))
    return sorted(bins), sorted(lists)


def parse_bat(path, clone, known):
    cmd = winws_command(path.read_text(encoding="utf-8", errors="replace"))
    if cmd is None:
        return None
    tokens = [substitute(t) for t in tokenize(cmd)]
    global_args, profiles, cur = [], [], []
    started = False
    for t in tokens:
        if t == "--new":
            profiles.append(cur)
            cur = []
            continue
        k, _ = split_opt(t)
        if not started and k.startswith(WINDOWS_ONLY_PREFIXES):
            global_args.append(t)
            continue
        started = True
        cur.append(t)
    if cur:
        profiles.append(cur)

    out_profiles = []
    for idx, args in enumerate(profiles):
        info = analyze_profile(args, clone)
        nfq, nfq_notes = to_nfqws1(args, known)
        bins, lists = files_used(args)
        info.update({
            "index": idx,
            "args": args,
            "nfqws1_args": nfq,
            "bin_files": bins,
            "list_files": lists,
        })
        info["notes"] = info["notes"] + nfq_notes
        out_profiles.append(info)
    return {"file": path.name, "global_args": global_args, "profiles": out_profiles}


def youtube_strategy(bat):
    """winws matches profiles in order, first match wins: the first relevant profile is what YouTube gets."""
    for p in bat["profiles"]:
        if p["relevant_youtube"]:
            return p
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("clone", type=Path)
    ap.add_argument("--nfqws-src", help="path to zapret1 nfq/nfqws.c to validate option names")
    ap.add_argument("--out", type=Path, default=HERE / "flowseal.json")
    ap.add_argument("--hostlist-out", type=Path, default=HERE / "hostlist-youtube.txt")
    a = ap.parse_args()

    known = nfqws_known_options(a.nfqws_src) if a.nfqws_src else None
    bats = []
    for f in sorted(a.clone.glob("general*.bat")):
        b = parse_bat(f, a.clone, known)
        if b:
            bats.append(b)

    dedup = {}
    for b in bats:
        p = youtube_strategy(b)
        if p is None:
            continue
        key = tuple(p["nfqws1_args"])
        if key not in dedup:
            dedup[key] = {
                "id": None,
                "sources": [],
                "profile_index": {},
                "tcp": p["tcp"],
                "l7": p["l7"],
                "hostlists": p["hostlists"],
                "ipsets": p["ipsets"],
                "desync_args": [x for x in p["nfqws1_args"] if split_opt(x)[0] not in MATCH_OPTS],
                "nfqws1_args": p["nfqws1_args"],
                "args": p["args"],
                "bin_files": p["bin_files"],
                "list_files": p["list_files"],
                "user_lists": p["user_lists"],
                "youtube_hosts_matched": p["youtube_hosts_matched"],
                "notes": p["notes"],
            }
        dedup[key]["sources"].append(b["file"])
        dedup[key]["profile_index"][b["file"]] = p["index"]

    strategies = list(dedup.values())
    for s in strategies:
        s["id"] = "flowseal-" + re.sub(r"[^a-z0-9]+", "-", Path(s["sources"][0]).stem.lower()).strip("-")

    google_list = load_hostlist(a.clone / "lists" / "list-google.txt") or []
    yt_domains = [d for d in google_list if YT_DOMAIN_RE.search(d.lstrip("^"))]
    dropped = [d for d in google_list if d not in yt_domains]
    a.hostlist_out.write_text("\n".join(yt_domains) + "\n")

    all_bins = sorted({x for s in strategies for x in s["bin_files"]})
    all_lists = sorted({x for s in strategies for x in s["list_files"]})

    result = {
        "source": {
            "repo": "https://github.com/flowseal/zapret-discord-youtube",
            "commit": git_head(a.clone),
            "license": "MIT (Flowseal, bol-van); bin/ also has WinDivert (LGPLv3/GPLv2) - not used here",
            "generated": datetime.date.today().isoformat(),
            "bat_vars": BAT_VARS,
            "nfqws_options_validated": known is not None,
        },
        "youtube": {
            "count_before_dedup": sum(len(s["sources"]) for s in strategies),
            "count_after_dedup": len(strategies),
            "bats_without_youtube_profile": [b["file"] for b in bats if youtube_strategy(b) is None],
            "required_bin_files": all_bins,
            "required_list_files": all_lists,
            "hostlist_file": a.hostlist_out.name,
            "hostlist_dropped_from_list_google": dropped,
            "strategies": strategies,
        },
        "raw": bats,
    }
    a.out.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    print(f"bats={len(bats)} youtube_before={result['youtube']['count_before_dedup']} "
          f"after={len(strategies)} bins={all_bins} lists={all_lists}")


if __name__ == "__main__":
    main()
