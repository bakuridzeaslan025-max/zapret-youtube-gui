# strategies

Стратегии для YouTube (TCP/TLS), извлечённые из
[flowseal/zapret-discord-youtube](https://github.com/flowseal/zapret-discord-youtube).

- Commit: `249a70424aae2676f99c5363e21073ed89873eda` (2026-09-26).
- Лицензия источника: MIT (Flowseal, bol-van). В `bin/` репо лежит ещё WinDivert (LGPLv3/GPLv2) —
  нам не нужен. Нужные fake-файлы (`tls_clienthello_www_google_com.bin`) — из zapret bol-van, MIT.
- Опции проверены по таблице `long_options` из `nfq/nfqws.c` zapret1 (commit `d437963`).

## Перегенерация

```sh
git clone --depth 1 https://github.com/flowseal/zapret-discord-youtube /tmp/flowseal
git clone --depth 1 https://github.com/bol-van/zapret /tmp/zapret   # опционально, для проверки опций
python3 strategies/extract_flowseal.py /tmp/flowseal --nfqws-src /tmp/zapret/nfq/nfqws.c
```

Пишет `strategies/flowseal.json` и `strategies/hostlist-youtube.txt`.

## Как считается

- Из каждого `general*.bat` берётся командная строка `winws.exe`, склеиваются `^`-переносы,
  раскрываются `^`-экраны и `%BIN%`/`%LISTS%` → `{BIN}/`, `{LISTS}/`. `%GameFilter*%` = `12`
  (дефолт service.bat при выключенном Game Filter).
- Профили режутся по `--new`. Профиль `relevant_youtube`, если это TCP 80/443 без не-TLS
  `--filter-l7`, и его hostlist (реальные файлы из клона, с учётом `^` и exclude) покрывает хосты
  из критерия «пробило», либо у профиля нет hostlist/ipset вообще. `ipset-all.txt` в репо —
  заглушка `203.0.113.113/32`, ipset-профили по умолчанию ничего не матчат.
- YouTube-стратегия .bat = первый relevant-профиль (winws/nfqws: первый совпавший выигрывает).
  Дедупликация — по `nfqws1_args`.
- `nfqws1_args` = `args` без Windows-only опций (`--wf-*`, `--ssid-filter`, `--nlm-*`).

## Формат flowseal.json

```
source    — repo, commit, license, bat_vars, nfqws_options_validated
youtube
  count_before_dedup / count_after_dedup
  required_bin_files, required_list_files, hostlist_file
  hostlist_dropped_from_list_google — что выкинуто из list-google.txt при сборке hostlist-youtube.txt
  strategies[]
    id, sources[] (.bat), profile_index{bat: idx}
    tcp, l7, hostlists, ipsets
    desync_args  — только «как» (без filter/hostlist/ipset)
    nfqws1_args  — полный профиль для Linux nfqws
    args         — исходный профиль winws (после подстановок)
    bin_files, list_files, user_lists (файлы, которых нет в репо)
    youtube_hosts_matched, notes
raw[]       — все .bat целиком: file, global_args (--wf-*), profiles[] с tags
              (udp/quic/discord/game_filter/google) и relevant_youtube
```

Плейсхолдеры `{BIN}/…`, `{LISTS}/…` приложение заменяет на свои пути; `{LISTS}/list-google.txt`
разумно подменять на `hostlist-youtube.txt`.

## nfqws2 (zapret2): `nfqws2.json` и `blockcheck2/`

Переведено **разово** из `flowseal.json` (flowseal commit `249a704`) под zapret2 `v1.0.5.2`
скриптом `translate_nfqws2.py`; **дальше поддерживается вручную** — это источник истины, повторно
транслятор не гоняем (иначе затрёт ручные правки). Таблица соответствия опций и семантические
отличия — `docs/winws-to-nfqws2.md`.

Как было получено (для истории / если понадобится перевести новые стратегии flowseal):

```sh
python3 strategies/translate_nfqws2.py <zapret2-v1.0.5.2>   # проверяет fake-файлы в files/fake
```

Неизвестная опция/режим = ошибка с id стратегии, ничего не пишется. Единственное приближение —
`hostfakesplit-mod=altorder=1` (ALT3, `"exact": false`).

### `nfqws2.json`

```
source      — flowseal repo/commit, zapret2_release, дата перевода, placeholders
strategies[]
  id, sources[] (.bat)
  winws       — исходные desync_args из flowseal.json (как было)
  nfqws2[]    — desync-часть профиля nfqws2 (без --filter/--hostlist): --blob, --lua-desync, --payload
                {FAKE} = <zapret2>/files/fake
  blockcheck2 — та же стратегия строкой для blockcheck2 (+ --comment=<id>)
  exact       — false, если перевод приближённый
  risks[]     — семантические отличия от nfqws1, проверять на живом канале
  notes[]     — прочее (ALT5: нет hostlist, syndata требует SYN в очереди)
```

`--blob` — глобальная опция nfqws2: при сборке нескольких профилей в одну командную строку одно имя
блоба объявлять один раз.

### `blockcheck2/list_https_tls12.txt`, `list_https_tls13.txt`

Этап 1 автоподбора: `blockcheck2 TEST=custom`. Одна строка = одна стратегия, над ней комментарий
с id, .bat и исходной winws-строкой. Строки eval'ятся shell'ом blockcheck2, `$ZAPRET_BASE`
раскрывается там. `--comment=<id>` попадает в `* SUMMARY` — по нему маппим результат на стратегию.
При правке стратегии менять и `nfqws2.json`, и оба списка.

```sh
BATCH=1 TEST=custom SKIP_DNSCHECK=1 IPVS=4 ENABLE_HTTP=0 ENABLE_HTTP3=0 \
  ENABLE_HTTPS_TLS12=1 ENABLE_HTTPS_TLS13=1 \
  DOMAINS="www.youtube.com youtubei.googleapis.com i.ytimg.com" \
  LIST_HTTPS_TLS12=.../list_https_tls12.txt LIST_HTTPS_TLS13=.../list_https_tls13.txt \
  /opt/<app>/zapret2/blockcheck2.sh
```

Проверено (docker linux/amd64, nfqws2 linux-x86_64 из релиза): `--dry-run`, `--intercept=0`,
живой прогон через NFQUEUE по loopback (все функции отработали, lua-ошибок нет) и
`blockcheck2 SIMULATE=1 TEST=custom` (все 18×2 строк приняты). blockcheck2 нужны `hexdump` и
`nslookup`/`host`.
