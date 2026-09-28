# Контракт renderer ↔ main ↔ helper

Три слоя, каждый знает только соседа:

```
renderer (UI, макет)  --window.api (preload, contextBridge)-->  main (Electron, от пользователя)
main  --pkexec /opt/ytunblock/bin/ytu-helper <cmd>-->  helper (root, POSIX sh)
```

Renderer к системе доступа не имеет (contextIsolation, sandbox, nodeIntegration=false).

## window.api (renderer → main)

Все методы — Promise. Ошибки — `{code, message}` с кодами из списка ниже.

| Метод | Результат |
|---|---|
| `getState()` | `State` (см. ниже) |
| `install()` / `uninstall()` | `void`; спрашивают пароль (pkexec) |
| `setEnabled(on: boolean)` | `void` |
| `checkNow()` | `CheckResult` |
| `startSelect(mode: 'quick'\|'deep')` | `void`; прогресс идёт событиями |
| `cancelSelect()` | `void` |
| `listStrategies()` | `{id, name, source, exact, args?: string}[]` (`args` — для «Текущие параметры») |
| `applyStrategy(id)` | `void` — ручной выбор (расширенный режим) |
| `getSettings()` / `setSettings(patch)` | `Settings` |
| `getLog(lines?)` | `string` |
| `getReport()` | `string` — отчёт для поддержки (без личных данных, кроме имени провайдера/сети) |

События (`api.on(name, cb)`, возвращает unsubscribe):

- `state` → `State` — любое изменение состояния.
- `selectProgress` → `{mode, done, total, current: string|null, etaSec: number|null, startedAt?: string,
  hosts?: {key, ok: boolean|null}[]}` — `hosts`: галочки по хостам для текущего кандидата.
  main запоминает последний `selectProgress` и повторяет его при (пере)загрузке окна.
- `installProgress` → `{step: string, done: number, total: number}` — шаги установки (необязательно).
- `selectDone` → `{mode, found: boolean, strategyId?: string, cancelled?: boolean}`.
- `networkChanged` → `{network: Network, hasStrategy: boolean}`.

### Типы

```ts
type State = {
  installed: boolean
  service: 'on' | 'off' | 'broken' | 'selecting'   // broken = включено, но проверка не проходит
  network: Network | null
  strategy: { id: string, name: string, selectedAt: string } | null  // для текущей сети
  lastCheck: CheckResult | null
  requirements: { ok: boolean, missing: string[] }  // nfnetlink_queue, nft, hexdump, nslookup, tcp_timestamps, apparmor...
}
type Network = { id: string, label: string, kind: 'wifi' | 'ethernet' | 'mobile' | 'other' }
type CheckResult = {
  at: string
  verdict: 'unblocked' | 'dpi' | 'path'   // path = проблема не в блокировке
  hosts: { key: 'site'|'api'|'thumbs'|'video', host: string, ok: boolean, ms: number | null }[]
}
type Settings = { autostart: boolean, blockQuic: boolean, perNetwork: boolean, advanced: boolean }
```

Хосты проверки: `site`=www.youtube.com, `api`=youtubei.googleapis.com, `thumbs`=i.ytimg.com,
`video`=rr*.googlevideo.com (конкретный узел выясняется в рантайме).

Коды ошибок: `AUTH_CANCELLED`, `AUTH_FAILED`, `NOT_INSTALLED`, `MISSING_REQUIREMENTS`,
`FIREWALL_CONFLICT`, `BUSY`, `HELPER_FAILED`.

## helper (main → root)

`/opt/ytunblock/bin/ytu-helper <cmd> [args]`, вызывается через `pkexec`. Polkit-action
`org.ytunblock.helper` — для активной локальной сессии без пароля для всех команд, кроме
`uninstall`. Вывод — одна JSON-строка на stdout (события прогресса — JSON-lines), код выхода ≠ 0
при ошибке с `{"error": CODE, "message": ...}`.

Установку (`install`) main выполняет иначе: весь payload (установщик, nfqws2, lua, files/fake,
strategies, unit, polkit, AppArmor-профиль) копируется из AppImage во временный каталог с правами
0755, и `pkexec` запускает установщик оттуда (root не читает FUSE-маунт AppImage).

| Команда | Что делает |
|---|---|
| `status` | состояние сервиса, текущая стратегия, requirements |
| `start` / `stop` | systemd-юнит `ytunblock.service` + nft-таблица `inet ytunblock` |
| `apply <strategy-id>` | записать активную стратегию (для `default` или сети), перезапустить сервис |
| `select quick\|deep [--network ID]` | остановить сервис, прогнать blockcheck2, JSON-lines прогресса, в конце результат; сервис вернуть в прежнее состояние |
| `select-follow` | подключиться к идущему подбору: отдать уже накопленный прогресс и дальше JSON-lines до конца; если подбора нет — последний результат |
| `cancel` | прервать идущий подбор |
| `set-quic on\|off` | вкл/выкл профиль nfqws2 `--filter-udp=443 --filter-l7=quic --hostlist=<youtube> --lua-desync=drop` (по SNI в QUIC Initial; nft-set по резолву не годится — `rr*.googlevideo.com` не перечислить) |
| `uninstall` | удалить всё поставленное (юнит, nft, /opt, polkit, AppArmor-профиль) |

Проверка доступности (`checkNow`) и определение сети — в main, без root (curl/Node https с
`--resolve`, nmcli/`ip route`).

## Подбор живёт отдельно от GUI

`select` запускается helper'ом отвязанно от вызывающего процесса (transient systemd-unit
`ytunblock-select` через `systemd-run`), прогресс пишется в `/run/ytunblock/select.jsonl`,
итог — в `/var/lib/ytunblock/last-select.json`. GUI можно закрыть — подбор продолжится.
При старте main видит `service: 'selecting'` и переподключается через `select-follow`.

## Закрытие окна

Трей есть ⇔ на session bus есть владелец `org.kde.StatusNotifierWatcher`
(на XEmbed-only окружениях это ложноотрицательно — допустимо: GUI просто закроется).
- Трей есть: закрытие прячет окно в трей (при первом разе — уведомление «свёрнуто в трей»).
- Трея нет: закрытие завершает GUI; обход продолжает работать в systemd. Если идёт подбор —
  перед закрытием предупреждение «подбор продолжится, результат увидите при следующем запуске».

## Безопасность helper'а

Команды без пароля доступны любому процессу пользователя в активной сессии → helper считает
аргументы враждебными:
- `strategy-id`, `--network ID` — только `^[a-z0-9-]{1,64}$`; стратегия ищется только в root-owned
  `/opt/ytunblock/strategies/nfqws2.json`. Сырые nfqws2-аргументы, пути, файлы извне не принимаются.
- Всё состояние — root-owned `/var/lib/ytunblock` (0755/0644); из `$HOME` и `/tmp` helper ничего
  не читает. Настройки GUI (`~/.config/ytunblock`) root-стороне не передаются, кроме валидированных
  значений через аргументы.
- `uninstall` — только с паролем (`auth_admin`).

## Состояния и восстановление

- Во время `selecting` команды `start`/`stop`/`apply`/`set-quic`/`select` → `BUSY`
  (в UI: `setEnabled`/`applyStrategy` отклоняются с `BUSY`).
- `cancel`: останавливает unit подбора (вся группа процессов), удаляет nft-таблицы blockcheck2,
  возвращает сервис в состояние до подбора. Это же делает сам `select` при любом завершении (trap).
- Если подбор умер аварийно (kill -9, перезагрузка): `status` и `start` находят хвосты
  (таблицы blockcheck2 с `queue` без слушателя, неактивный unit подбора при `selecting` в
  состоянии), чистят их и восстанавливают сервис. Иначе трафик к тестовым IP висит.
