# dpi-stand — стенд с фейковым DPI

```
client (lan 10.66.1.10) ──> isp (10.66.1.2 | 10.66.2.2) ──> server (wan 10.66.2.10)
 Ubuntu 24.04, nfqws2,       форвардинг + MASQUERADE,         nginx, TLS 1.2/1.3 :443,
 blockcheck2, репо в /repo   dnsmasq, фейковый DPI             один SAN-серт на все имена
```

- DNS клиента — dnsmasq на isp: `www.youtube.com`, `youtubei.googleapis.com`, `i.ytimg.com`,
  `*.googlevideo.com` (проверяем `rr1---sn-test.googlevideo.com`) и невинный `example.org` → IP
  server. Интернета на стенде нет (он и не нужен).
- server генерирует CA в volume `pki`, client ему доверяет (`update-ca-certificates`), т.е. curl и
  blockcheck2 ходят без `-k`. Ответ: `ok sni=<SNI> proto=<TLS>` — видно, какой SNI дошёл.
- zapret2 (версия и sha256 — из единственного пина `system/fetch-zapret2.sh`) качается в
  `.cache/zapret2` (в гит не идёт; маркер `.sha256`, при смене пина кэш пересобирается) и копируется
  внутри client в `/opt/zapret2` (nfqws2 делает droproot, lua должны быть мирочитаемыми).
  Бинари — по `uname -m` (arm64 на Apple Silicon, x86_64 иначе).
- client и isp — `cap_add: NET_ADMIN, NET_RAW` (NFQUEUE, nft/iptables, маршруты, raw-сокеты
  nfqws2) и `init: true` (реапинг nfqws2/python); server — без добавленных прав. Не `--privileged`.
  Репо монтируется в client только на чтение (весь — под будущие e2e с `system/` и `app/`).

## Запуск

```sh
tests/dpi-stand/run.sh            # = all: smoke, dpi, (blockcheck, apply) × BC_MODES, path
tests/dpi-stand/run.sh dpi        # один сценарий
tests/dpi-stand/run.sh blockcheck sni-drop    # сценарий 2 в другом режиме DPI
STRATEGY=flowseal-general-alt6 tests/dpi-stand/run.sh apply sni-drop-reasm
tests/dpi-stand/run.sh down       # снести контейнеры и volume
```

Каждый сценарий печатает `PASS`/`FAIL`, в конце `ALL PASS` (exit 0) или список провалов (exit 1);
2 — стенд не поднялся. Стенд поднимается сам (`up` = fetch + build + up -d), между сценариями не
пересоздаётся; режим DPI переключается на лету: `docker compose exec isp dpi-mode <mode>`.

Переменные: `ZAPRET2_TARBALL` (взять релиз из локального файла вместо скачивания), `BC_MODES`
(режимы DPI для сценариев 2–3 в `all`, по умолчанию `sni-drop-reasm sni-drop`), `BC_MODE` (режим для
`blockcheck`/`apply` без аргумента, по умолчанию `sni-drop-reasm`), `STRATEGY` (id для сценария 3 вместо
первого найденного), `PROBE_TIMEOUT` (с, по умолчанию 3), `REASM_TRACK_ISN` (см. ниже).
Логи blockcheck2 — `.cache/logs/blockcheck-<mode>.log`.

Руками: `docker compose exec client bash`, внутри `bypass start '<аргументы nfqws2>'` /
`bypass stop` (nft-очередь как у zapret: postrouting `tcp dport 443`, первые 12 пакетов, +
SYN-ACK в prerouting; строка eval'ится как у blockcheck2, `$ZAPRET_BASE` раскрывается).
Логи: client `/var/log/nfqws2.log`, isp `/var/log/reasm_dpi.log`, `/var/log/dnsmasq.log`.

## Сценарии

Вердикт считается как `CheckResult` в `docs/ipc-api.md`: все целевые хосты 200 → `unblocked`;
невинный SNI (`example.org`) не отвечает → `path`; иначе `dpi`. Каждый хост — TLS 1.2 и 1.3. Негативные
ожидания строже вердикта: `dpi` = все цели 000 и example.org 200, `path` = всё 000. Если проб
вернул не все строки с HTTP-кодом — FAIL, а не вердикт.

| # | Сценарий | Ожидание |
|---|---|---|
| smoke | DPI `none`, без обхода | `unblocked` |
| 1 | `sni-drop`, без обхода | `dpi`: цели висят (curl 000 за таймаут), example.org 200 |
| 1b–1d | самопроверка DPI: простой сплит `multisplit:pos=host+1,midsld` | проходит `sni-drop`, не проходит `sni-drop-reasm`; без обхода reasm = `dpi` |
| 2 | `blockcheck2 BATCH=1 TEST=custom` со списками `strategies/blockcheck2/` по 4 доменам | ≥1 стратегия в `* COMMON` и для TLS 1.2, и для 1.3 |
| 3 | первая такая стратегия (или `STRATEGY`) через `bypass start` | `unblocked` |
| 4 | `blackhole` | `path` |

## Режимы DPI (`DPI_MODE` / `dpi-mode`)

Это **не ТСПУ**, а три упрощённые модели. Токены: `youtube youtubei ytimg googlevideo`
(`DPI_TOKENS`). Смотрится только client→server tcp/443.

- `none` — ничего.
- `sni-drop` — stateless: iptables `-m string` дропает любой пакет, в котором токен целиком.
  Ретрансмиты тоже дропаются → соединение висит. Проходят только стратегии, где **ни один реально
  доставляемый сегмент** не содержит токен целиком: сплит внутри каждого токена. Фейки бесполезны
  (реальный ClientHello всё равно дропается), seqovl бесполезен, сплит по `pos=1/2`, `sniext+1`,
  `midsld` для `youtubei.googleapis.com` — бесполезен (midsld режет `googleapis`, а `youtubei`
  остаётся целым — та же грабля, что в `CLAUDE.md`).
- `sni-drop-reasm` — Python-обработчик NFQUEUE (`isp/reasm_dpi.py`): собирает поток до конца
  первой TLS-записи, парсит SNI, защёлкивает вердикт на поток (block = дроп этого и всех следующих
  пакетов потока). Модель:
  - начало потока = ISN+1 из SYN (`REASM_TRACK_ISN=1`, по умолчанию) либо seq первого сегмента с
    данными (`REASM_TRACK_ISN=0`); данные в SYN игнорируются;
  - перекрытия: побеждает первый записанный байт; TCP timestamps, checksum, окна не проверяются;
  - не TLS / не парсится → пропустить (fail-open);
  - SYN на потоке без вердикта (например, при частично собранном ClientHello) сбрасывает буфер
    и начинает поток заново — уклонение «SYN посреди недособранного CH» модель пропускает;
  - SNI сравнивается без учёта регистра (в `sni-drop` — `-m string --icase`);
  - повторный SYN на том же 4-tuple не сбрасывает вынесенный вердикт, пока поток активен
    (простой > 10 с — считается новым соединением);
  - IP-фрагменты и битые пакеты пропускаются (не моделируются). Обработчик без `--queue-bypass`:
    если он упал, весь tcp/443 дропается, а `dpi-mode` при старте проверяет, что он жив.

  Отсюда: простые сплиты и disorder **не проходят** (сборка); фейк с тем же seq и `tcp_ts`-фулингом
  **проходит** (DPI принимает фейк как начало потока, сервер его отбрасывает по PAWS);
  `hostfakesplit` проходит (фейковый хост ложится первым); badseq-фейк со сдвигом +2 проходит
  случайно (сборка превращается в мусор → fail-open), с −10000/+1000 — нет; чистый seqovl (данные
  до ISN+1) — нет, т.к. DPI знает ISN. С `REASM_TRACK_ISN=0` проходят и seqovl, и disorder, и все
  badseq — DPI принимает первый увиденный сегмент за начало потока.
- `blackhole` — дроп всего к IP server (любой порт, любой SNI) → вердикт `path`.

## Результаты (Mac M-series, Docker Desktop 28.5, linuxkit 6.10, nfqws2 linux-arm64)

`run.sh all`: все PASS, **~9 мин** на тёплом стенде (smoke 5с, dpi 15с, blockcheck reasm ~3 мин,
blockcheck sni-drop ~5.5 мин — почти всё таймауты по 2с, apply ×2 ~15с, path 5с); холодная сборка
образов добавляет ~1 мин. `BC_MODES=sni-drop-reasm` — ~3.5 мин. `REASM_TRACK_ISN=0` blockcheck — ~1 мин.

blockcheck2 по 20 стратегиям `strategies/blockcheck2/` (хостов из 4, TLS 1.2 = TLS 1.3 везде):

| стратегия | sni-drop | reasm (ISN) | reasm (first seg) |
|---|---|---|---|
| own-wssize-multidisorder, own-multidisorder-hostmid (multidisorder `host+1,midsld`) | **4** | 0 | 4 |
| alt, alt10, alt3 (fake + `tcp_ts`) | 0 | 4 | 4 |
| alt11, fake-tls-auto-alt3 (fake `tcp_ts` + seqovl) | 0 | 4 | 4 |
| alt9, alt12, alt13 (hostfakesplit `tcp_ts`) | 0 | 4 | 4 |
| alt8, fake-tls-auto-alt, simple-fake-alt (fake badseq +2) | 0 | 4 | 4 |
| alt4 (fake badseq +1000 + split) | 0 | 0 | 4 |
| fake-tls-auto-alt2 (fake badseq +10⁷ + seqovl) | 0 | 0 | 4 |
| fake-tls-auto (fake badseq −10000 + multidisorder `1,midsld`) | 3 (кроме youtubei) | 0 | 4 |
| alt2, alt6, alt7 (чистый seqovl) | 0 | 0 | 4 |
| alt5 (syndata + multidisorder) | 0 | 0 | 4 |

Выводы:
- `sni-drop-reasm`: 11/20 пробивают все хосты (только flowseal-фейки/hostfakesplit), сценарий 3 —
  `flowseal-general-alt`.
- `sni-drop`: все хосты пробивают только own-* — сплит `host+1` рвёт `youtubei` в сабдомене,
  `midsld` — остальные токены. flowseal-стратегии максимум 3/4 (youtubei: `midsld` режет
  `googleapis`, та же грабля, что в `CLAUDE.md`). Сценарий 3 — `own-multidisorder-hostmid`.
- Непересекающиеся множества: ни одна стратегия не проходит обе модели — поэтому порядок в
  списке (own-* первыми) важен только для скорости, а подбор должен идти по всему списку.
- wssize на стенде ничего не решает (DPI не смотрит ответ сервера); проверено tcpdump, что
  SYN уходит с `win 1 wscale 6`, сегменты ClientHello — с `win 1`.

## Ограничения

- Модели DPI игрушечные: нет IP/ASN-логики, нет подмены/RST-инъекций, нет троттлинга, нет
  проверки ответа сервера, нет QUIC. Реальный ТСПУ может вести себя иначе в любую сторону —
  PASS на стенде не гарантирует PASS у провайдера и наоборот (например, чистый seqovl на ТСПУ
  обычно работает, а в `reasm (ISN)` — нет).
- Всё в одном ядре Docker VM (разные netns): TTL/hop-зависимые трюки (`autottl`, `ip_ttl`-фулинг)
  по сути не проверяются — между client и server один хоп.
- Сервер — Linux: фейки с `tcp_ts` отбрасываются через PAWS, как у реальных Linux-серверов; на
  сервере с выключенными timestamps результат был бы другим.
- Только IPv4. blockcheck2 без проверки DNS (`SKIP_DNSCHECK=1`), IP-block тест — на `example.org`.

## Точки расширения (не реализовано)

- **install/helper e2e** (когда будут `system/install.sh` и `ytu-helper`): сценарий в client
  (нужен systemd — отдельный образ с `systemd` как PID 1 или запуск юнита руками):
  `install.sh` → `ytu-helper status` (requirements ok) → `ytu-helper select quick` (JSON-lines,
  в конце `found: true` под `sni-drop-reasm`, `found: false` под `sni-drop`/`blackhole` с верным
  вердиктом) → `apply <id>` → `start` → `probe_all` = `unblocked` → `stop` → `uninstall` →
  проверка чистоты: нет `/opt/ytunblock`, юнита, nft-таблицы `inet ytunblock`, polkit-правила,
  AppArmor-профиля; `nft list ruleset` и `systemctl list-units` как до установки.
- **UI e2e в real-режиме**: Electron (`app/`, `services/real.js`) в client под `xvfb-run`,
  Playwright/`_electron` жмёт «Подобрать» → «Включить», ассерты по экранам + `probe_all`.
  pkexec в контейнере заменить на заглушку, вызывающую helper напрямую (или polkit-агент).
- Режимы DPI добавлять в `isp/dpi-mode` (case) — сценарии их подхватят через `blockcheck <mode>`.
