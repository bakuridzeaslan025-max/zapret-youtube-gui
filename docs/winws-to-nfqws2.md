# winws / nfqws1 → nfqws2: таблица соответствия

Опции, встречающиеся в `desync_args` YouTube-стратегий `strategies/flowseal.json`, и их перевод в
nfqws2 (zapret2). Результат перевода — `strategies/nfqws2.json` и `strategies/blockcheck2/*.txt`.

Ссылки:
- **z2** — релиз zapret2 `v1.0.5.2` (`docs/readme.md`, `docs/manual.md`, `lua/*.lua`, `blockcheck2*`);
- **z1** — zapret1, commit `d437963` (`nfq/*.c`, `nfq/params.h`).

## Общий принцип

nfqws1 применял один набор опций профиля ко всем пакетам, которые генерировал. В nfqws2 каждая
lua-функция (`--lua-desync=func:arg=val:...`) — отдельный инстанс со своими аргументами, поэтому
общие опции nfqws1 раскладываются по инстансам:

| что в nfqws1 | куда в nfqws2 | почему |
|---|---|---|
| fooling, repeats | только инстанс `fake` и фейковые части `fakedsplit`/`hostfakesplit` | в nfqws1 fooling/repeats действуют только на фейки (z1 `desync.c:1994-2002`, `2153-2159`; реальные сегменты шлются с `fooling_orig=FOOL_NONE`, `desync.c:1947`). У `multisplit`/`multidisorder` в nfqws2 fooling/repeats применились бы к реальным сегментам — туда НЕ ставим. У `fakedsplit`/`hostfakesplit` nfqws2 сам применяет их только к фейкам (z2 `zapret-antidpi.lua:699`, `817`) |
| `--ip-id` | каждый инстанс, генерирующий пакеты | в nfqws1 — на все сгенерированные пакеты (z1 `desync.c:838-852`); в nfqws2 — standard arg `ip_id` каждой функции (z2 `zapret-antidpi.lua:60-62`, `zapret-lib.lua:1086-1107`) |
| desync только на TLS/HTTP (без `any-protocol`) | `--payload=tls_client_hello` перед инстансами | по умолчанию `--payload=all` (z2 `manual.md:1196`); функции сами пропускают неизвестные пейлоады, но явный фильтр как в примерах автора (z2 `readme.md:363-366`) |
| режимы `mode0,mode1,mode2` | инстансы по порядку: `syndata` → `--payload=...` → `fake` → split-функция | порядок вызова важен (z2 `readme.md:259-267`); `syndata` ставится ДО `--payload`, иначе не вызовется на пустом SYN (так же в z2 `blockcheck2.d/standard/24-syndata.sh:28`) |

## Режимы `--dpi-desync`

| nfqws1 | nfqws2 | примечание / риск |
|---|---|---|
| `fake` | `--lua-desync=fake:blob=<B>` (по инстансу на каждый `--dpi-desync-fake-tls`) | z2 `zapret-antidpi.lua:444-472`. Шлётся один раз на соединение (`replay_first`) — как в nfqws1 |
| `multisplit` | `multisplit:pos=<split-pos>` | z2 `zapret-antidpi.lua:475-540`. Дефолт pos=2 в обоих (z1 `nfqws.c:1367-1371`, z2 `zapret-antidpi.lua:497`). **Риск:** многопакетный ClientHello (kyber) режется по reasm целиком, nfqws1 резал по частям |
| `multidisorder` | `multidisorder:pos=<split-pos>` | z2 `zapret-antidpi.lua:588-641`. **Риск:** работает с reasm целиком, порядок частей для многопакетных CH иной; точный аналог — `multidisorder_legacy` (z2 `manual.md:4293-4295`, `zapret-antidpi.lua:643-696`). Выбран новый, как в порте пресета автором (z2 `readme.md:366`); `blockcheck2` позволяет подменить (`MULTIDISORDER=multidisorder_legacy`, z2 `manual.md:5114`) |
| `fakedsplit` | `fakedsplit:pos=<первая позиция>` | z2 `zapret-antidpi.lua:816-919`, порядок частей = nfqws1 altorder=0. При списке split-pos nfqws1 выбирает позицию по l7-правилам (z1 `nfqws.c:1880-1881`) — транслятор падает, выбрать руками |
| `hostfakesplit` | `hostfakesplit` | z2 `zapret-antidpi.lua:698-814`. Генерация фейкового хоста совпадает (z1 `desync.c:2112-2140` ≡ z2 `zapret-lib.lua:1374-1392`) |
| `syndata` | `--lua-desync=syndata` | z2 `zapret-antidpi.lua:391-416`; дефолт 16 нулей в обоих (z1 `params.c:231`). nfqws1 не фулит syndata (z1 `desync.c:1465`), repeats — применяет. **Риск:** в очередь должен попадать исходящий SYN; hostname на SYN неизвестен → профиль с hostlist SYN не поймает |
| `fake,multisplit` / `fake,multidisorder` / `fake,fakedsplit` / `fake,hostfakesplit` / `syndata,multidisorder` | цепочка инстансов в том же порядке | см. «Общий принцип» |
| `fakeddisorder`, `rst`, `synack`, `ipfrag2`, `udplen`, … | не встречаются | транслятор — ошибка. Соответствия есть (`fakeddisorder`, `rst`, `send:ipfrag`, `udplen`; z2 `readme.md:293-301`) |

## Параметры split

| nfqws1 | nfqws2 | примечание / риск |
|---|---|---|
| `--dpi-desync-split-pos=1` / `2` / `2,sniext+1` / `1,midsld` | `pos=...` тот же синтаксис маркеров | маркеры те же (`method,host,endhost,sld,endsld,midsld,sniext`). `midsld` не бьёт `youtubei.googleapis.com` (см. CLAUDE.md) — свойство стратегии, не перевода |
| `--dpi-desync-split-seqovl=N` | `seqovl=N` | для multisplit/fakedsplit только абсолютное N>0 в обоих (z1 `nfqws.c:1373-1377`). Для multidisorder N < первой позиции, иначе отменяется (z2 `zapret-antidpi.lua:564-566`) |
| `--dpi-desync-split-seqovl-pattern={BIN}/f.bin` | `--blob=f:@<fake>/f.bin` + `seqovl_pattern=f` | паттерн циклически повторяется в обоих (z1 `fill_pattern`, `nfqws.c:2919-2922`; z2 `pattern()`). Файл `tls_clienthello_www_google_com.bin` (681 байт) побайтно одинаков во flowseal, zapret1 и zapret2 `files/fake` (md5 `41e47557…`) |
| `--dpi-desync-fakedsplit-pattern=0x00` | `pattern=0x00` | hex-блоб прямо в аргументе (z2 `zapret-lib.lua:534-546`) |
| `--dpi-desync-hostfakesplit-mod=host=X` | `host=X` | z1 `nfqws.c:1155-1161` |
| `--dpi-desync-hostfakesplit-mod=altorder=1` | `nofake2` — **приближение** | nfqws1: before, fake, after_host, real_host, без второго фейка (z1 `desync.c:2175-2181`, `2217`). nfqws2 фиксированно шлёт before, fake1, real, fake2, after (z2 `zapret-antidpi.lua:731-799`); `nofake2` убирает второй фейк, но real_host идёт ДО after_host. Точно не выражается без своей lua-функции. В `nfqws2.json` помечено `"exact": false` (ALT3) |
| `--dpi-desync-hostfakesplit-midhost` | `midhost=` | не встречается; транслятор — ошибка |

## Фейки

| nfqws1 | nfqws2 | примечание / риск |
|---|---|---|
| `--dpi-desync-fake-tls={BIN}/f.bin` | `--blob=f:@<zapret2>/files/fake/f.bin` + `fake:blob=f` | транслятор проверяет наличие файла в `files/fake` релиза. Имя блоба = имя файла без `.bin` (должно быть Lua-идентификатором, z2 `manual.md:1187-1188`) |
| `--dpi-desync-fake-tls=0xHEX` | `fake:blob=0xHEX` | |
| `--dpi-desync-fake-tls=!` | `fake:blob=fake_default_tls` | встроенный fake: 680 байт, побайтно идентичен в z1 `desync.c:20` и z2 `nfq2/params.c:29` (SNI www.microsoft.com, z2 `manual.md:1851`) |
| несколько `--dpi-desync-fake-tls` | несколько инстансов `fake`, каждый со своими fooling/repeats | nfqws1 шлёт каждый фейк из коллекции по `repeats` раз |
| fake без `--dpi-desync-fake-tls` | `fake:blob=fake_default_tls` | z1 `params.c:251-257`. Если нет и `--dpi-desync-fake-tls-mod` — nfqws1 неявно добавлял `rnd,rndsni,dupsid` (z1 `nfqws.c:1540-1541`); транслятор переносит это явно |
| `--dpi-desync-fake-tls-mod=rnd,dupsid,sni=X` | `tls_mod=rnd,dupsid,sni=X` на инстансе `fake` | **Порядок важен:** в nfqws1 мод применяется к последнему уже загруженному фейку и ко всем последующим (z1 `nfqws.c:3020-3046`). Поэтому в FAKE TLS AUTO (`fake-tls=0x00000000 fake-tls=! fake-tls-mod=...`) мод только на `fake_default_tls`, 0x00000000 — без мода. **Риск:** `rnd` в nfqws2 применяется на каждую отправку, в nfqws1 — один раз при старте (z2 `readme.md:270-271`); привести к nfqws1 можно через `--lua-init="fake_default_tls=tls_mod(fake_default_tls,'rnd')"` (`readme.md:286-290`), но это глобально для всех профилей. `dupsid` — per-connection в обоих |
| `--dpi-desync-fake-tls-mod=none` | без `tls_mod` | z1 `nfqws.c:1120-1121` |
| `padencap`, `rndsni` | `tls_mod=padencap` / `rndsni` | те же имена (z2 `manual.md:2514-2522`); в YouTube-стратегиях не встречаются |

## Fooling

| nfqws1 | nfqws2 | примечание / риск |
|---|---|---|
| `--dpi-desync-fooling=badseq` | `tcp_seq=-10000:tcp_ack=-66000:tcp_ts_up` | badseq в nfqws2 нет; nfqws1 сдвигал seq на `badseq-increment` (деф. −10000) и ack на `badack-increment` (деф. −66000) (z1 `params.h:29-30`, `darkmagic.c:132-135`; z2 `readme.md:225-226`). **`tcp_ts_up` обязателен:** nfqws1 собирал tcp-опции заново и TS шёл первым, Linux-сервер отбрасывает пакет с плохим ack только в этом случае; без него фейк может быть принят (z2 `readme.md:228-232`, `zapret-lib.lua:1028-1030`; так же в `blockcheck2.d/standard/def.inc:1`) |
| `--dpi-desync-badseq-increment=N` | `tcp_seq=N` (ack остаётся −66000) | 2, 1000, 10000000 — все int32, `u32add` корректно заворачивает |
| `--dpi-desync-badack-increment=N` | `tcp_ack=N` | не встречается |
| `--dpi-desync-fooling=ts` | `tcp_ts=-600000` | деф. `ts-increment` −600000 (z1 `params.h:32`, `darkmagic.c:176`; z2 `zapret-lib.lua:1009-1020`). **Риск:** нужен `net.ipv4.tcp_timestamps=1`, без TS-опции nfqws2 только пишет DLOG и фейк уходит нефуленым. `tcp_ts_up` не добавляем (PAWS от порядка опций не зависит; blockcheck2 тоже без него) |
| `--dpi-desync-ts-increment=N` | `tcp_ts=N` | не встречается |
| `md5sig` | `tcp_md5` | не встречается в YouTube-стратегиях (есть в пресете автора, z2 `readme.md:365`) |
| `badsum` | `badsum` | не встречается |
| `datanoack` | `tcp_flags_unset=ack` | не встречается (z2 `readme.md:282`) |
| `hopbyhop`, `hopbyhop2` | `ip6_hopbyhop`, `ip6_hopbyhop2` | не встречается; транслятор — ошибка |

## Прочее

| nfqws1 | nfqws2 | примечание / риск |
|---|---|---|
| `--ip-id=zero` | `ip_id=zero` на каждом инстансе | `seq`/`rnd` — те же имена; `seqgroup` аналога нет (ошибка). Только IPv4 |
| `--dpi-desync-repeats=N` | `repeats=N` на фейковых инстансах | см. «Общий принцип» |
| `--dpi-desync-ttl=N` / `--dpi-desync-ttl6=N` | `ip_ttl=N:ip6_ttl=N` | не встречается. **Риск:** в nfqws2 нет автоприменения ttl к IPv6 — писать оба (z2 `readme.md:211`) |
| `--dpi-desync-autottl=d:min-max` | `ip_autottl=d,min-max:ip6_autottl=d,min-max` | не встречается. Запятая вместо двоеточия (z2 `readme.md:244`); nfqws1 применял autottl и к IPv6 (z1 `nfqws.c:1871`), в nfqws2 — только если явно `ip6_autottl` |
| `--dpi-desync-any-protocol=1` | `payload=all` у инстанса / `--payload=all` | не встречается в YouTube-стратегиях (есть в UDP/Discord-профилях). Без него функции берут только известные пейлоады (z2 `zapret-antidpi.lua:55-57`) |
| `--dpi-desync-cutoff=nN` / `dN` / `sN` | `--out-range=<nN` / `<dN` / `<sN` | не встречается в YouTube-стратегиях. nfqws1: «меньше N» (z1 `nfqws.c:1909`) = исключающая граница `<` (z2 `manual.md:1197-1203`). По умолчанию `--out-range=a`, `--in-range=x`. Для экономии CPU в рантайме разумно `--out-range=-d10` (z2 `readme.md:316-318`) |
| `--filter-*`, `--hostlist*`, `--ipset*` | те же опции профиля | в перевод не входят — задаём сами |

## blockcheck2 `TEST=custom`

- Формат (z2 `blockcheck2.d/custom/10-list.sh`, `README.txt`, `manual.md:5140-5146`): одна стратегия —
  одна строка nfqws2-аргументов, `#` — комментарий. Строка проходит через `eval` в shell →
  спецсимволы экранировать, `$VAR` раскрывается.
- Списки: `list_https_tls12.txt`, `list_https_tls13.txt`. Путь — `blockcheck2.d/<test>/` либо env
  `LIST_HTTPS_TLS12=... LIST_HTTPS_TLS13=...` при `TEST=custom`.
- Блобы: `--blob=name:@"$ZAPRET_BASE/files/fake/<file>"` прямо в строке — `$ZAPRET_BASE` задаёт сам
  blockcheck2 (`blockcheck2.sh:5`), как делают стандартные тесты (`standard/23-seqovl.sh:52`).
  `--lua-init` zapret-lib/antidpi blockcheck2 добавляет сам (`blockcheck2.sh:951`).
- `--comment=<id>` (nfqws2 игнорирует, z2 `manual.md:706`) — попадает в `* SUMMARY`, по нему
  результат маппится на стратегию.
- Для реального прогона blockcheck2 нужны `hexdump` и `nslookup`/`host` (без них он падает/всё FAILED).

## Проверка перевода (релиз v1.0.5.2, linux-x86_64, docker linux/amd64)

1. `nfqws2 --qnum=200 --dry-run` + `--lua-init` zapret-lib/antidpi: опции и наличие файлов.
   Lua-аргументы не проверяет (z2 `manual.md:705`).
2. `nfqws2 --intercept=0`: выполняет lua-init и проверяет, что desync-функции существуют.
3. Живой прогон по loopback: NFQUEUE на `lo:443` (с SYN), `openssl s_server`, curl c SNI
   www.youtube.com (TLS 1.2 и 1.3), `--debug`: каждая функция отработала, lua-ошибок нет.
4. `blockcheck2.sh` `SIMULATE=1 BATCH=1 TEST=custom` с `LIST_HTTPS_TLS12/13`: все строки приняты,
   `BAD STRATEGY` нет, в SUMMARY видны `--comment=<id>`.

Проверка не заменяет прогон на реальном канале: семантические отличия выше влияют на то, пробьёт ли
стратегия DPI, а не на то, запустится ли она.
