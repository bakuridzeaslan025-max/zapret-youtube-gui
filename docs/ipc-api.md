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
| `listStrategies()` | `{id, name, source, exact}[]` |
| `applyStrategy(id)` | `void` — ручной выбор (расширенный режим) |
| `getSettings()` / `setSettings(patch)` | `Settings` |
| `getLog(lines?)` | `string` |
| `getReport()` | `string` — отчёт для поддержки (без личных данных, кроме имени провайдера/сети) |

События (`api.on(name, cb)`, возвращает unsubscribe):

- `state` → `State` — любое изменение состояния.
- `selectProgress` → `{mode, done, total, current: string|null, etaSec: number|null}`.
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

Установку (`install`) main выполняет иначе: `pkexec` запускает скрипт-установщик, скопированный
из AppImage во временный каталог с правами 0755 (root не читает FUSE-маунт AppImage).

| Команда | Что делает |
|---|---|
| `status` | состояние сервиса, текущая стратегия, requirements |
| `start` / `stop` | systemd-юнит `ytunblock.service` + nft-таблица `inet ytunblock` |
| `apply <strategy-id>` | записать активную стратегию (для `default` или сети), перезапустить сервис |
| `select quick\|deep [--network ID]` | остановить сервис, прогнать blockcheck2, JSON-lines прогресса, в конце результат; сервис вернуть в прежнее состояние |
| `cancel` | прервать идущий подбор |
| `set-quic on\|off` | правило nft: drop UDP/443 к hostlist (ipset/nft set по резолву) |
| `uninstall` | удалить всё поставленное (юнит, nft, /opt, polkit, AppArmor-профиль) |

Проверка доступности (`checkNow`) и определение сети — в main, без root (curl/Node https с
`--resolve`, nmcli/`ip route`).
