#!/usr/bin/env python3
"""Static checks of strategies/nfqws2.json vs strategies/blockcheck2/list_https_tls1{2,3}.txt.

Usage: check_consistency.py <strategies-dir> <zapret2-release-dir> <cases-out> <release-dir-in-container>

Prints `FAIL <id>: <reason>` per problem, exit 1 if any. Writes <cases-out> for nfqws2_check.sh:
`<id>\t<variant>\t<args as shell words>` (variant: json | tls12 | tls13).
"""
import json
import os
import re
import shlex
import sys

LISTS = ("tls12", "tls13")
BUILTIN_BLOBS = {"fake_default_tls", "fake_default_http", "fake_default_quic"}
# lua-desync args whose value is a blob name (zapret-lib.lua blob(): 0xHEX | --blob name | builtin);
# nfqws2 --intercept=0 does not resolve them, a typo fails only on a live packet
BLOB_ARGS = {"blob", "pattern", "seqovl_pattern", "fallback", "dataxor"}
ZB = "$ZAPRET_BASE"

errors = []


def fail(sid, msg):
    errors.append(f"FAIL {sid}: {msg}")


def parse_list(path):
    """-> {id: {"line", "header", "winws", "lineno"}}; the source comment block sits right above the line."""
    out = {}
    block = []
    with open(path, encoding="utf-8") as f:
        for n, raw in enumerate(f, 1):
            line = raw.rstrip("\n")
            if not line.strip():
                block = []
                continue
            if line.startswith("#"):
                block.append(line)
                continue
            where = f"{os.path.basename(path)}:{n}"
            ids = re.findall(r"(?:^|\s)--comment=(\S+)", line)
            if len(ids) != 1:
                fail(where, f"ожидается ровно один --comment=<id>, найдено {len(ids)}")
                block = []
                continue
            sid = ids[0]
            if sid in out:
                fail(sid, f"{where}: id повторяется (первый раз в строке {out[sid]['lineno']})")
            header = next((c for c in block if c.startswith(f"# {sid} (")), None)
            winws = next((c[len("# winws: "):] for c in block if c.startswith("# winws: ")), None)
            out[sid] = {"line": line, "header": header, "winws": winws, "lineno": n, "where": where}
            block = []
    return out


def split_list_line(sid, where, line):
    # blockcheck2 eval's the line; $ZAPRET_BASE is the only expansion we allow
    rest = line.replace(ZB, "")
    if re.search(r"[$`\\;|&<>()]", rest):
        fail(sid, f"{where}: shell-метасимволы кроме $ZAPRET_BASE — строка eval'ится blockcheck2")
        return None
    try:
        return shlex.split(line)
    except ValueError as e:
        fail(sid, f"{where}: не разбирается как shell-слова: {e}")
        return None


def file_refs(tokens, prefix):
    """--blob=name:@<prefix>/path -> [path relative to release]"""
    refs = []
    for t in tokens:
        m = re.match(r"--blob=[^:]+:@(.*)$", t)
        if m:
            p = m.group(1)
            if not p.startswith(prefix + "/"):
                refs.append((p, None))
            else:
                refs.append((p, p[len(prefix) + 1:]))
    return refs


def check_blob_refs(sid, where, tokens):
    declared = set()
    for t in tokens:
        m = re.match(r"--blob=([^:]+):", t)
        if m:
            name = m.group(1)
            if name in declared:
                fail(sid, f"{where}: --blob={name} объявлен дважды")
            declared.add(name)
    for t in tokens:
        if not t.startswith("--lua-desync="):
            continue
        fn, *args = t[len("--lua-desync="):].split(":")
        for a in args:
            k, _, v = a.partition("=")
            # zapret-lib.lua apply_arg_prefix: any arg `%name` / `#name` is a blob value / length
            if v[:1] in ("%", "#"):
                v = v[1:]
            elif k not in BLOB_ARGS:
                continue
            if not v.startswith("0x") and v not in declared | BUILTIN_BLOBS:
                fail(sid, f"{where}: {fn}:{a} — блоб не объявлен через --blob и не встроенный")


def main():
    sdir, rel, cases_out, crel = sys.argv[1:5]
    with open(os.path.join(sdir, "nfqws2.json"), encoding="utf-8") as f:
        data = json.load(f)

    strategies = {}
    for i, s in enumerate(data.get("strategies", [])):
        sid = s.get("id") or f"nfqws2.json#{i}"
        for k in ("id", "sources", "winws", "nfqws2", "blockcheck2", "exact"):
            if k not in s:
                fail(sid, f"nfqws2.json: нет поля {k}")
        if sid in strategies:
            fail(sid, "nfqws2.json: id повторяется")
        strategies[sid] = s

    lists = {v: parse_list(os.path.join(sdir, "blockcheck2", f"list_https_{v}.txt")) for v in LISTS}

    for v, entries in lists.items():
        for sid in sorted(set(strategies) - set(entries)):
            fail(sid, f"есть в nfqws2.json, нет в list_https_{v}.txt")
        for sid in sorted(set(entries) - set(strategies)):
            fail(sid, f"есть в list_https_{v}.txt, нет в nfqws2.json")

    cases = []
    for sid, s in strategies.items():
        json_tokens = [t.replace("{FAKE}", f"{ZB}/files/fake") for t in s.get("nfqws2", [])]
        if any("{" in t for t in json_tokens):
            fail(sid, "nfqws2.json: нераскрытый плейсхолдер (известен только {FAKE})")
        if any(t.startswith(("--filter-", "--hostlist", "--ipset", "--new")) for t in json_tokens):
            fail(sid, "nfqws2.json: в nfqws2[] только desync-часть, без --filter/--hostlist/--ipset/--new")
        check_blob_refs(sid, "nfqws2.json", json_tokens)
        for p, relp in file_refs(json_tokens, f"{ZB}/files/fake"):
            if relp is None:
                fail(sid, f"nfqws2.json: блоб не из {{FAKE}}: {p}")
            elif not os.path.isfile(os.path.join(rel, "files", "fake", relp)):
                fail(sid, f"nfqws2.json: файла нет в релизе: files/fake/{relp}")
        cases.append((sid, "json", " ".join(shlex.quote(t.replace(ZB, crel)) for t in json_tokens)))

        own = s.get("winws") is None
        if own and not (sid.startswith("own-") and s.get("sources")):
            fail(sid, "nfqws2.json: winws=null только у собственных стратегий (id own-*, непустые sources)")
        if not own and not isinstance(s.get("winws"), str):
            fail(sid, "nfqws2.json: winws должен быть строкой-оригиналом flowseal")

        bc = s.get("blockcheck2", "")
        if not bc.startswith(f"--comment={sid} "):
            fail(sid, "nfqws2.json: blockcheck2 должен начинаться с --comment=<id>")

        for v in LISTS:
            e = lists[v].get(sid)
            if not e:
                continue
            where = e["where"]
            if e["header"] is None:
                fail(sid, f"{where}: над строкой нет комментария-источника `# {sid} (<.bat>)`")
            else:
                for src in s.get("sources", []):
                    if src not in e["header"]:
                        fail(sid, f"{where}: в комментарии-источнике нет {src!r}")
                if e["header"].endswith(" APPROX") == bool(s.get("exact", True)):
                    fail(sid, f"{where}: пометка APPROX не совпадает с exact={s.get('exact')}")
            if own:
                if e["winws"] is not None:
                    fail(sid, f"{where}: у собственной стратегии не должно быть `# winws:`")
            elif e["winws"] is None:
                fail(sid, f"{where}: нет комментария `# winws: <исходная строка>`")
            elif e["winws"] != s.get("winws"):
                fail(sid, f"{where}: `# winws:` отличается от nfqws2.json")
            if e["line"] != bc:
                fail(sid, f"{where}: строка отличается от nfqws2.json .blockcheck2")
            tokens = split_list_line(sid, where, e["line"])
            if tokens is None:
                continue
            if tokens[0] != f"--comment={sid}":
                fail(sid, f"{where}: --comment=<id> должен быть первым")
            desync = [t for t in tokens if not t.startswith("--comment=")]
            if desync != json_tokens:
                fail(sid, f"{where}: опции отличаются от nfqws2.json .nfqws2[] ({{FAKE}} = $ZAPRET_BASE/files/fake)")
            check_blob_refs(sid, where, tokens)
            for p, relp in file_refs(tokens, f"{ZB}/files/fake"):
                if relp is None:
                    fail(sid, f"{where}: блоб не из $ZAPRET_BASE/files/fake: {p}")
                elif not os.path.isfile(os.path.join(rel, "files", "fake", relp)):
                    fail(sid, f"{where}: файла нет в релизе: files/fake/{relp}")
            cases.append((sid, v, e["line"]))

    with open(cases_out, "w", encoding="utf-8") as f:
        for c in cases:
            f.write("\t".join(c) + "\n")

    if not strategies:
        fail("nfqws2.json", "нет ни одной стратегии")

    for e in errors:
        print(e)
    print(f"consistency: {len(strategies)} стратегий, {len(errors)} ошибок")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
