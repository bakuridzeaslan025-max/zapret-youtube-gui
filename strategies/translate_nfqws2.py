#!/usr/bin/env python3
"""One-off translator: flowseal YouTube strategies (winws / nfqws1 syntax) -> nfqws2 (zapret2).

Usage: translate_nfqws2.py <zapret2_release_dir> [--in strategies/flowseal.json]

Writes strategies/nfqws2.json and strategies/blockcheck2/list_https_tls1{2,3}.txt.
The outputs are then maintained by hand; see docs/winws-to-nfqws2.md for the option mapping.
Any option or value not covered here is a hard error naming the strategy.
"""
import argparse
import datetime
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent

# nfqws1 defaults, zapret1 nfq/params.h:29-32
BADSEQ_INC, BADACK_INC, TS_INC = -10000, -66000, -600000
# nfqws1 implicit mods for the built-in fake when no --dpi-desync-fake-tls/-mod given, nfqws.c:1540-1541
IMPLICIT_DEFAULT_TLS_MOD = ["rnd", "rndsni", "dupsid"]
TLS_MODS = {"none", "rnd", "rndsni", "sni", "dupsid", "padencap"}
# flowseal.json notes about the zapret1 binary; the ts caveat is re-stated in risks
NFQWS1_ONLY_NOTES = ("--ip-id exists in zapret1", "fooling=ts needs TCP timestamps")
MODES = {"syndata", "fake", "multisplit", "multidisorder", "fakedsplit", "hostfakesplit"}

RISK = {
    "badseq": "badseq -> tcp_seq/tcp_ack + tcp_ts_up: в nfqws2 нет badseq, tcp_ts_up повторяет порядок tcp-опций nfqws1 (readme.md:225-232)",
    "ts": "fooling ts: нужен net.ipv4.tcp_timestamps=1, иначе фейк не фулится (zapret-lib.lua:1009-1019 — без опции только DLOG)",
    "multidisorder": "multidisorder в nfqws2 режет reasm целиком; для многопакетного ClientHello (kyber) порядок сегментов иной, чем в nfqws1. Точный аналог — multidisorder_legacy (manual.md:4293-4295)",
    "reasm": "многопакетный ClientHello (kyber) режется по reasm целиком, nfqws1 резал по частям (replay)",
    "altorder": "hostfakesplit altorder=1 не выражается: nfqws1 шлёт before,fake,after,real (без fake2); nfqws2 с nofake2 — before,fake,real,after (desync.c:2175 vs zapret-antidpi.lua:698-707)",
    "syndata": "syndata работает на SYN: в очередь должен попадать исходящий SYN; hostname на SYN неизвестен — профиль с hostlist его не поймает",
    "implicit_fake": "fake без --dpi-desync-fake-tls: nfqws1 брал встроенный fake, в nfqws2 это fake_default_tls (байты идентичны, SNI www.microsoft.com)",
    "implicit_mod": "ни fake-tls, ни fake-tls-mod не заданы: nfqws1 неявно применял tls_mod=rnd,rndsni,dupsid (nfqws.c:1540-1541), перенесено явно",
}


class TranslateError(Exception):
    pass


def resolve_blob(value, fake_dir, blobs):
    """nfqws1 blob value -> nfqws2 blob reference (name or 0xHEX)."""
    if value.startswith("0x"):
        return value
    if value == "!":
        return "fake_default_tls"
    if value.startswith("{BIN}/"):
        fname = value[len("{BIN}/"):]
        if not (fake_dir / fname).is_file():
            raise TranslateError(f"fake file '{fname}' not found in {fake_dir}")
        name = Path(fname).stem
        if not name.isidentifier():
            raise TranslateError(f"cannot derive a Lua blob name from '{fname}'")
        blobs[name] = fname
        return name
    raise TranslateError(f"unsupported blob value '{value}' (offsets +N / other paths are not handled)")


def translate(desync_args, fake_dir):
    modes, repeats, ip_id = [], None, None
    fooling, badseq_inc, badack_inc, ts_inc = [], BADSEQ_INC, BADACK_INC, TS_INC
    split_pos = seqovl = seqovl_pattern = fakedsplit_pattern = None
    hfs = {}
    fakes, tls_mod_last = [], None
    blobs, risks, notes, exact = {}, [], [], True

    for arg in desync_args:
        key, _, val = arg.partition("=")
        if key == "--dpi-desync":
            modes = val.split(",")
            for m in modes:
                if m not in MODES:
                    raise TranslateError(f"desync mode '{m}' is not supported by the translator")
        elif key == "--dpi-desync-repeats":
            repeats = int(val)
        elif key == "--ip-id":
            if val not in ("zero", "seq", "rnd"):
                raise TranslateError(f"--ip-id={val} has no nfqws2 equivalent")
            ip_id = val
        elif key == "--dpi-desync-fooling":
            fooling = val.split(",")
        elif key == "--dpi-desync-badseq-increment":
            badseq_inc = int(val, 0)
        elif key == "--dpi-desync-badack-increment":
            badack_inc = int(val, 0)
        elif key == "--dpi-desync-ts-increment":
            ts_inc = int(val, 0)
        elif key == "--dpi-desync-split-pos":
            split_pos = val
        elif key == "--dpi-desync-split-seqovl":
            if not val.isdigit():
                raise TranslateError(f"split-seqovl '{val}': only absolute N is handled")
            seqovl = int(val)
        elif key == "--dpi-desync-split-seqovl-pattern":
            seqovl_pattern = resolve_blob(val, fake_dir, blobs)
        elif key == "--dpi-desync-fakedsplit-pattern":
            fakedsplit_pattern = resolve_blob(val, fake_dir, blobs)
        elif key == "--dpi-desync-hostfakesplit-mod":
            for item in val.split(","):
                k, _, v = item.partition("=")
                if k == "host" and v:
                    hfs["host"] = v
                elif k == "altorder" and v in ("0", "1"):
                    hfs["altorder"] = int(v)
                elif k != "none":
                    raise TranslateError(f"hostfakesplit-mod '{item}' is not supported")
        elif key == "--dpi-desync-fake-tls":
            fakes.append({"blob": resolve_blob(val, fake_dir, blobs), "mod": list(tls_mod_last or [])})
        elif key == "--dpi-desync-fake-tls-mod":
            mods = []
            for item in val.split(","):
                if item.partition("=")[0] not in TLS_MODS:
                    raise TranslateError(f"fake-tls-mod '{item}' is not supported")
                if item != "none":
                    mods.append(item)
            # nfqws1: the mod applies to the last loaded fake and to all fakes loaded after it (nfqws.c:3020-3046)
            tls_mod_last = mods
            if fakes:
                fakes[-1]["mod"] = mods
        else:
            raise TranslateError(f"option '{arg}' is not supported by the translator")

    if not modes:
        raise TranslateError("no --dpi-desync")

    fool = []
    for f in fooling:
        if f == "badseq":
            fool += [f"tcp_seq={badseq_inc}", f"tcp_ack={badack_inc}", "tcp_ts_up"]
            risks.append(RISK["badseq"])
        elif f == "ts":
            fool.append(f"tcp_ts={ts_inc}")
            risks.append(RISK["ts"])
        elif f == "md5sig":
            fool.append("tcp_md5")
        elif f == "badsum":
            fool.append("badsum")
        elif f == "datanoack":
            fool.append("tcp_flags_unset=ack")
        elif f != "none":
            raise TranslateError(f"fooling '{f}' is not supported by the translator")
    rep = [f"repeats={repeats}"] if repeats else []
    ipid = [f"ip_id={ip_id}"] if ip_id else []
    fake_side = fool + rep + ipid  # nfqws1 applies fooling/repeats only to fakes

    used = set()
    pre, main = [], []
    for m in modes:
        if m == "syndata":
            pre.append(["syndata"] + rep)
            used.add("repeats")
            risks.append(RISK["syndata"])
        elif m == "fake":
            if not fakes:
                fakes = [{"blob": "fake_default_tls",
                          "mod": tls_mod_last if tls_mod_last is not None else IMPLICIT_DEFAULT_TLS_MOD}]
                risks.append(RISK["implicit_fake"])
                if tls_mod_last is None:
                    risks.append(RISK["implicit_mod"])
            for f in fakes:
                inst = ["fake", f"blob={f['blob']}"] + fake_side
                if f["mod"]:
                    inst.append("tls_mod=" + ",".join(f["mod"]))
                main.append(inst)
            used |= {"fooling", "repeats", "fake"}
        elif m in ("multisplit", "multidisorder"):
            inst = [m, f"pos={split_pos or '2'}"]
            if seqovl:
                inst.append(f"seqovl={seqovl}")
                if seqovl_pattern:
                    inst.append(f"seqovl_pattern={seqovl_pattern}")
            main.append(inst + ipid)
            used |= {"split_pos", "seqovl"}
            risks.append(RISK["multidisorder" if m == "multidisorder" else "reasm"])
        elif m == "fakedsplit":
            if split_pos and "," in split_pos:
                raise TranslateError("fakedsplit with a split-pos list: nfqws1 picks one by l7 rules, pick by hand")
            inst = ["fakedsplit", f"pos={split_pos or '2'}"]
            if fakedsplit_pattern:
                inst.append(f"pattern={fakedsplit_pattern}")
            if seqovl:
                inst.append(f"seqovl={seqovl}")
                if seqovl_pattern:
                    inst.append(f"seqovl_pattern={seqovl_pattern}")
            main.append(inst + fake_side)
            used |= {"split_pos", "seqovl", "fooling", "repeats", "fakedsplit_pattern"}
            risks.append(RISK["reasm"])
        elif m == "hostfakesplit":
            inst = ["hostfakesplit"]
            if "host" in hfs:
                inst.append(f"host={hfs['host']}")
            if hfs.get("altorder") == 1:
                inst.append("nofake2")
                risks.append(RISK["altorder"])
                exact = False
            main.append(inst + fake_side)
            used |= {"fooling", "repeats", "hfs"}
            risks.append(RISK["reasm"])

    present = {"fooling": fooling, "repeats": repeats, "split_pos": split_pos, "seqovl": seqovl,
               "fakedsplit_pattern": fakedsplit_pattern, "hfs": hfs, "fake": fakes or tls_mod_last}
    for k, v in present.items():
        if v and k not in used:
            notes.append(f"'{k}' задан, но режимы {','.join(modes)} его не используют (nfqws1 тоже игнорирует) — опущен")

    args = [f"--blob={n}:@{{FAKE}}/{f}" for n, f in sorted(blobs.items())]
    args += ["--lua-desync=" + ":".join(i) for i in pre]
    args.append("--payload=tls_client_hello")
    args += ["--lua-desync=" + ":".join(i) for i in main]
    return args, exact, list(dict.fromkeys(risks)), notes


def blockcheck_line(sid, args):
    # --comment is ignored by nfqws2 but lands in blockcheck2 SUMMARY, mapping a result back to the strategy id
    return f"--comment={sid} " + " ".join(a.replace(":@{FAKE}/", ':@"$ZAPRET_BASE/files/fake/') + '"' if a.startswith("--blob=") else a
                    for a in args)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("zapret2", type=Path, help="zapret2 release dir (files/fake is checked for blobs)")
    ap.add_argument("--in", dest="inp", type=Path, default=HERE / "flowseal.json")
    a = ap.parse_args()

    src = json.loads(a.inp.read_text())
    fake_dir = a.zapret2 / "files" / "fake"
    out, errors = [], []
    for s in src["youtube"]["strategies"]:
        try:
            args, exact, risks, notes = translate(s["desync_args"], fake_dir)
        except (TranslateError, ValueError) as e:
            errors.append(f"{s['id']}: {e}")
            continue
        out.append({
            "id": s["id"],
            "sources": s["sources"],
            "winws": " ".join(s["desync_args"]),
            "nfqws2": args,
            "blockcheck2": blockcheck_line(s["id"], args),
            "exact": exact,
            "risks": risks,
            "notes": [n for n in s.get("notes", []) if not n.startswith(NFQWS1_ONLY_NOTES)] + notes,
        })
    if errors:
        sys.exit("translation failed:\n  " + "\n  ".join(errors))

    doc = {
        "source": {
            "flowseal": {k: src["source"][k] for k in ("repo", "commit") if k in src["source"]},
            "zapret2_release": a.zapret2.name,
            "translated": datetime.date.today().isoformat(),
            "note": "переведено разово translate_nfqws2.py, дальше поддерживается вручную",
            "placeholders": {"{FAKE}": "<zapret2>/files/fake"},
        },
        "strategies": out,
    }
    (HERE / "nfqws2.json").write_text(json.dumps(doc, ensure_ascii=False, indent=2) + "\n")

    bc = HERE / "blockcheck2"
    bc.mkdir(exist_ok=True)
    commit = doc["source"]["flowseal"].get("commit", "?")[:7]
    for tls in ("tls12", "tls13"):
        lines = [
            f"# nfqws2 strategies for blockcheck2 TEST=custom (LIST_HTTPS_{tls.upper()}=<this file>)",
            f"# translated once from flowseal {commit} for zapret2 {a.zapret2.name}; maintained by hand",
            "# each line is eval'd by blockcheck2 (custom/10-list.sh): $ZAPRET_BASE expands there",
            "",
        ]
        for s in out:
            lines.append(f"# {s['id']} ({', '.join(s['sources'])}){'' if s['exact'] else ' APPROX'}")
            lines.append(f"# winws: {s['winws']}")
            lines.append(s["blockcheck2"])
            lines.append("")
        (bc / f"list_https_{tls}.txt").write_text("\n".join(lines))
    print(f"translated {len(out)} strategies ({sum(not s['exact'] for s in out)} approximate)")


if __name__ == "__main__":
    main()
