# Тестирование

| # | Уровень | Где | Среда | Статус |
|---|---|---|---|---|
| 1 | Unit: парсер SUMMARY/COVERAGE blockcheck2, JSON-lines helper'а, вердикты `checkNow` на фейковых таймингах, определение сети по фикстурам `nmcli`/`ip route` | `tests/unit/` | `node:test`, мак/Linux | после `app/` + `system/` |
| 2 | Контрактные: один набор тестов против `mock.js` и `real.js` (real — с фейковыми `pkexec`/helper через env) → mock не расходится с реальностью | `tests/contract/` | `node:test` | после `app/` + `system/` |
| 3 | Стратегии: консистентность json ↔ списки blockcheck2, наличие блобов, `nfqws2 --dry-run` и `--intercept=0` на каждую | `tests/strategies/` | docker linux/amd64 | готово: `tests/strategies/run.sh` |
| 4 | Системные: shellcheck; install/uninstall (идемпотентность, ничего не остаётся), start/stop/apply, select в SIMULATE | `tests/system/` | docker Ubuntu 24.04, Fedora, `--privileged` | после `system/` |
| 5 | Стенд с фейковым DPI: client → isp (DPI) → server, полный путь: вердикт `dpi`/`path`, быстрый подбор находит стратегию, после применения все хосты открываются | `tests/dpi-stand/` | docker compose, `--privileged` | в работе |
| 6 | E2E UI: Playwright + Electron в mock-режиме, сценарии `YTU_MOCK_SCENARIO`, скриншоты | `tests/e2e/` | мак (без пиксельного сравнения) / Linux-контейнер с xvfb (эталоны) | после `app/` |
| 7 | Ручная проверка на живом провайдере (город и 4G) | `docs/manual-testing.md` | реальное железо | готово: чек-лист |

## Принципы

- Стенд с фейковым DPI ≠ реальный ТСПУ: он ловит поломки цепочки (nft → очередь → nfqws2 →
  подбор → применение), а не доказывает, что стратегии пробивают конкретного провайдера. Это — п. 7.
- Эталонные скриншоты — только из Linux-контейнера: рендер шрифтов на маке и Linux разный.
- `real.js` (pkexec, nft, nmcli) на маке не запускается; его e2e — в Linux-контейнере с xvfb
  поверх стенда из п. 5 (позже).
- Версия zapret2 и sha256 релиза пинятся в одном месте — `system/fetch-zapret2.sh`; релиз
  скачивается в кэш (`~/.cache/zapretApp`), не коммитится.
- nfqws2 в docker без `NET_ADMIN` (x86_64 и arm64) падает rc=1 на `setpcap: Operation not
  permitted` при любых аргументах → ложный FAIL на всех стратегиях; всегда `--cap-add=NET_ADMIN`.
  Коды выхода проверять без пайпов (`| tail` маскирует rc). Аргументы lua-функций nfqws2 не валидирует (опечатка
  `tcp_tss=5` проходит `--intercept=0`) — ловит только живой прогон.
- Каждый уровень запускается одной командой с кодом выхода ≠ 0 при падении.
