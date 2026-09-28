# zapretApp

Linux-приложение (AppImage) для обхода DPI-блокировок YouTube на десктопе пользователя через zapret,
с автоподбором стратегии под провайдера. Только YouTube (Discord и прочее — не в скоупе).

## Архитектура (согласовано)

- AppImage = непривилегированный GUI. Root нужен только для установки/управления сервисом.
- Root НЕ видит файлы внутри FUSE-маунта AppImage (маунт доступен только запустившему юзеру) →
  первый запуск через `pkexec` копирует в `/opt/<app>/` статический nfqws, fake-файлы/lua,
  systemd-юнит и nft-правила. Дальше GUI рулит сервисом (polkit-правило, чтобы не спрашивать
  пароль каждый раз). Обязательна кнопка Uninstall — AppImage сам не трекает, что поставил.
- QUIC (UDP/443) к YouTube режем → браузер откатывается на TCP, десинкаем только TLS.
  Десинк QUIC — возможный этап 2, не сейчас.
- Подводные камни: firewalld/ufw/Docker, iptables-legacy vs nft, модуль `nfnetlink_queue`.

## Автоподбор стратегии

Hostlist (ЧТО десинкать) — от сервиса, общий. Стратегия (КАК) — от провайдера, подбирается.

1. **Базовая диагностика до перебора**: заблокировано ли вообще и DPI ли это. Признак DPI по SNI:
   TLS виснет, `up>0 down=0`, curl `000` за ~9с; тот же IP с невинным SNI отвечает за ~0.4с.
   Если с невинным SNI тоже висит — проблема в пути, не в DPI, подбирать нечего.
2. **Быстрый этап**: перебор готовых стратегий, вытащенных из
   https://github.com/flowseal/zapret-discord-youtube (winws/zapret1-синтаксис). Вытаскиваются
   ОДИН РАЗ при сборке в собственный JSON (не парсим .bat в рантайме), Discord-часть выкидываем.
3. **Долгий этап** (если ни одна не пробила): ограниченный `blockcheck`/`blockcheck2` из самого
   zapret (только TLS, только наши домены), приложение парсит результат. Свой перебор не пишем.

**Критерий «пробило»** — все хосты, не только youtube.com:
`www.youtube.com`, `youtubei.googleapis.com`, `i.ytimg.com`, какой-нибудь `rr*.googlevideo.com`.
Чистый тест DPI по SNI: `curl --resolve <host>:443:<IP>`.

## Грабли из опыта (шлюз автора, zapret2/nfqws2)

- Позиция сплита должна попадать на блокируемый токен SNI. `pos=midsld` рвёт SLD: для
  `youtube.com` ок, для `youtubei.googleapis.com` — нет (токен «youtubei» в сабдомене, midsld
  после него) → нужен `pos=host+1`. Разным хостам может понадобиться разная стратегия →
  несколько профилей через `--new`; профили матчатся по порядку, первый выигрывает
  (поэтому хост с особой стратегией исключают из общего профиля `--hostlist-exclude-domains`).
- nfqws2 под root делает droproot на nobody и ТОЛЬКО ПОТОМ читает `--lua-init=@...`. Если lua в
  каталоге 0700 — «LUA file ... not accessible», десинк молча не работает, процесс жив.
  Лечится `--uid=0:0` или мирочитаемым путём (0755 по всему пути, `/opt/...` ок).
- Менять IP при DPI по SNI бесполезно (у youtubei всего 4 IP, одинаковые у всех резолверов).
- TLS 1.2-клиенты (напр. телевизоры) zapret'ом не спасаются — не наш кейс, но учитывать в FAQ.
- Мобильные операторы часто требуют отличных от проводных стратегий.
- blockcheck2 в рантайме требует `hexdump` и `nslookup`/`host` (без hexdump все тесты падают,
  без резолвера не стартует) — проверять при установке. Стратегии в списках помечены
  `--comment=<id>` (nfqws2 игнорирует) — так id виден в SUMMARY.
- `fooling=ts`-стратегии требуют `net.ipv4.tcp_timestamps=1`, иначе фулинг молча не работает.
- `syndata` (ALT5): в очередь должен идти исходящий SYN, hostlist на SYN не работает.
- Семантические риски перевода winws→nfqws2 — `docs/winws-to-nfqws2.md` (ALT3 приближённый).

## Открытые вопросы

- Целевые дистрибутивы.

## Принятые решения (подробно — `docs/decisions.md`)

- Движок — только zapret2 (`nfqws2` + `blockcheck2`); zapret1 EOL. Стратегии flowseal
  переведены winws → nfqws2 ОДИН РАЗ; результат в `strategies/` под гитом — источник истины,
  дальше правится руками. Транслятор — одноразовый инструмент, в сборке не участвует,
  к flowseal не возвращаемся.
- Этап 1 = `blockcheck2 TEST=custom` с переведёнными flowseal-стратегиями; этап 2 =
  `blockcheck2` стандартный с жёсткой обрезкой. Парсим `* SUMMARY` / `* COVERAGE`.
- Лицензии: zapret, zapret2, flowseal — MIT (приложить тексты лицензий).
- GUI — Electron + electron-builder → AppImage. Electron от пользователя; всё root-овое —
  через `pkexec` helper'а в `/opt`, renderer к системе только через preload/IPC. Грабли:
  AppArmor в Ubuntu 24.04 ломает песочницу Chromium в AppImage (см. D3).
  Макет: `docs/YouTube без блокировок - макеты.html` (экспорт Claude design), разбор — `docs/design-spec.md`.

## Структура

- `docs/` — исследования и решения; `docs/ipc-api.md` — контракт renderer↔main↔helper.
- `app/` — Electron: `main/` (main, preload, ipc, `services/mock.js` | `services/real.js`), `renderer/`.
- `system/` — то, что ставится от root: install/uninstall, `ytu-helper`, systemd, nft, polkit, AppArmor.
- `strategies/` — стратегии: `nfqws2.json` + `blockcheck2/list_https_tls1{2,3}.txt` (источник
  истины, правятся руками); `extract_flowseal.py`/`translate_nfqws2.py` — одноразовые, не запускать.
