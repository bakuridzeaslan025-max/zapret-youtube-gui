'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');
const { app, BrowserWindow, Tray, Menu, Notification, nativeImage, nativeTheme, ipcMain, shell, session } = require('electron');
const ipc = require('./ipc');

const RENDERER_INDEX = path.join(__dirname, '..', 'renderer', 'index.html');
const ASSETS = path.join(__dirname, '..', 'assets');
const EXTERNAL_HOSTS = new Set(['github.com']);
// Autotests: offscreen window that is never shown, no tray icon, no notifications, no Dock icon.
const HEADLESS = process.env.YTU_HEADLESS === '1';
// Offscreen rendering defaults to DPR 1; pin it so screenshots match the regular (HiDPI) ones.
const HEADLESS_DPR = parseFloat(process.env.YTU_HEADLESS_DPR || '2');
if (HEADLESS) {
  if (app.dock) app.dock.hide();
  // isolated profile: parallel test runs don't hit the single-instance lock or the user's data
  app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'ytunblock-test-')));
}

// Tray exists iff a StatusNotifierWatcher owns its name on the session bus (docs/ipc-api.md,
// «Закрытие окна»). XEmbed-only panels give a false negative — acceptable, the GUI just quits.
// Not Linux or no D-Bus tools → assume a tray; a tool that fails (no session bus, timeout) → no tray.
// YTU_TRAY=0|1 overrides (testing).
function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 2000 }, (err, stdout) => resolve({ missing: !!err && err.code === 'ENOENT', out: err ? null : String(stdout) }));
  });
}

async function detectTray() {
  if (process.env.YTU_TRAY === '0' || process.env.YTU_TRAY === '1') return process.env.YTU_TRAY === '1';
  if (process.platform !== 'linux') return true;
  const name = 'org.kde.StatusNotifierWatcher';
  const gdbus = await run('gdbus', ['call', '--session', '--dest', 'org.freedesktop.DBus', '--object-path', '/org/freedesktop/DBus',
    '--method', 'org.freedesktop.DBus.NameHasOwner', name]);
  if (!gdbus.missing) return gdbus.out !== null && /true/.test(gdbus.out);
  const dbusSend = await run('dbus-send', ['--session', '--print-reply', '--dest=org.freedesktop.DBus', '/org/freedesktop/DBus',
    'org.freedesktop.DBus.NameHasOwner', `string:${name}`]);
  if (!dbusSend.missing) return dbusSend.out !== null && /boolean true/.test(dbusSend.out);
  return true;
}

function loadService() {
  const realPath = path.join(__dirname, 'services', 'real.js');
  const wanted = process.env.YTU_SERVICE || (fs.existsSync(realPath) ? 'real' : 'mock');
  if (wanted !== 'real' && wanted !== 'mock') throw new Error(`YTU_SERVICE=${wanted}: expected mock|real`);
  const mod = require(path.join(__dirname, 'services', wanted + '.js'));
  const service = typeof mod.create === 'function' ? mod.create({ app }) : mod;
  console.log(`[main] service: ${wanted}`);
  return service;
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let win = null;
  let tray = null;
  let hasTray = true;
  let quitting = false;
  let service = null;
  let state = null;
  let progress = null;
  let bridge = null;
  let closeConfirmed = false;

  const isTrustedSender = (event) => !!win && event.sender === win.webContents
    && !!event.senderFrame && event.senderFrame.parent === null && event.senderFrame.url.startsWith('file://');

  function createWindow() {
    win = new BrowserWindow({
      width: 440,
      height: 640,
      minWidth: 400,
      minHeight: 600,
      resizable: false,
      maximizable: false,
      fullscreenable: false,
      frame: false,
      show: false,
      focusable: !HEADLESS,
      title: 'YouTube без блокировок',
      icon: path.join(ASSETS, 'icon.png'),
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#161826' : '#f3f5fe',
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
        spellcheck: false,
        offscreen: HEADLESS ? { deviceScaleFactor: HEADLESS_DPR } : false,
      },
    });

    win.webContents.on('will-navigate', (e) => e.preventDefault());
    win.webContents.setWindowOpenHandler(({ url }) => {
      try {
        const u = new URL(url);
        if (u.protocol === 'https:' && EXTERNAL_HOSTS.has(u.hostname)) shell.openExternal(u.href);
      } catch { /* ignore malformed */ }
      return { action: 'deny' };
    });
    win.on('close', (e) => {
      if (quitting) return;
      if (hasTray) {
        e.preventDefault();
        hideToTray();
      } else if (state && state.service === 'selecting' && !closeConfirmed) {
        e.preventDefault();
        showWindow();
        win.webContents.send('win:confirm-close');
      }
    });
    win.once('ready-to-show', () => {
      if (HEADLESS) return;
      if (!tray || !process.argv.includes('--hidden')) win.show();
    });
    bridge.attach(win.webContents);
    win.loadFile(RENDERER_INDEX);
  }

  function showWindow() {
    if (HEADLESS) return;
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }

  function hideToTray() {
    win.hide();
    const flag = path.join(app.getPath('userData'), 'tray-hint-shown');
    if (fs.existsSync(flag)) return;
    notify('Свёрнуто в трей', 'Обход работает. Окно откроется по щелчку на значке в трее.');
    try {
      fs.mkdirSync(path.dirname(flag), { recursive: true });
      fs.writeFileSync(flag, '');
    } catch (e) {
      console.error('[main] tray hint flag', e);
    }
  }

  function trayImage() {
    let name = 'off';
    if (state && state.online === false && state.service !== 'selecting') name = 'off';
    else if (state && state.service === 'on') name = 'on';
    else if (state && state.service === 'broken') name = 'error';
    else if (state && state.service === 'selecting') {
      const pct = progress && progress.total ? progress.done / progress.total : 0;
      name = `selecting-${Math.min(10, Math.round(pct * 10))}`;
    }
    return nativeImage.createFromPath(path.join(ASSETS, 'tray', `${name}.png`));
  }

  function statusLine() {
    if (!state || !state.installed) return 'Не установлено';
    if (state.online === false && state.service !== 'selecting') return 'Нет сети';
    const net = state.network ? ` · ${state.network.label}` : '';
    const label = { on: 'Работает', off: 'Выключено', broken: 'Не работает', selecting: 'Идёт подбор' }[state.service];
    return label + net;
  }

  function updateTray() {
    if (!tray) return;
    tray.setImage(trayImage());
    tray.setToolTip(`YouTube без блокировок — ${statusLine()}`);
    const installed = state && state.installed;
    const on = state && state.service === 'on';
    const busy = state && state.service === 'selecting';
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: statusLine(), enabled: false },
      { type: 'separator' },
      {
        label: on || (state && state.service === 'broken') ? 'Выключить' : 'Включить',
        enabled: !!installed && !busy && !!(state.strategy || on),
        click: () => service.setEnabled(!(on || state.service === 'broken')).catch((e) => console.error('[tray]', e)),
      },
      { label: 'Открыть окно', click: showWindow },
      {
        label: 'Проверить сейчас',
        enabled: !!installed && !busy,
        click: () => service.checkNow().catch((e) => console.error('[tray]', e)),
      },
      { type: 'separator' },
      { label: 'Выход', click: () => { quitting = true; app.quit(); } },
    ]));
  }

  function notify(title, body) {
    if (HEADLESS || !Notification.isSupported()) return;
    const n = new Notification({ title, body, icon: nativeImage.createFromPath(path.join(ASSETS, 'icon.png')) });
    n.on('click', showWindow);
    n.show();
  }

  app.on('second-instance', showWindow);
  app.on('before-quit', () => { quitting = true; });
  app.on('window-all-closed', () => app.quit());

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => {
      cb(permission === 'clipboard-sanitized-write' || permission === 'notifications');
    });
    session.defaultSession.setPermissionCheckHandler((_wc, permission) =>
      permission === 'clipboard-sanitized-write' || permission === 'notifications');

    service = loadService();
    bridge = ipc.register(service, { isTrustedSender });

    ipcMain.on('win:minimize', (e) => { if (isTrustedSender(e)) win.minimize(); });
    ipcMain.on('win:close', (e) => { if (isTrustedSender(e)) win.close(); });
    ipcMain.on('win:hide', (e) => { if (isTrustedSender(e)) (hasTray ? hideToTray() : win.minimize()); });
    ipcMain.on('win:force-close', (e) => {
      if (!isTrustedSender(e)) return;
      closeConfirmed = true;
      win.close();
    });
    ipcMain.handle('win:info', (e) => (isTrustedSender(e) ? { hasTray } : null));

    service.on('state', (s) => {
      state = s;
      if (s.service !== 'selecting') progress = null;
      updateTray();
    });
    service.on('selectProgress', (p) => {
      const prevStep = progress && progress.total ? Math.round((progress.done / progress.total) * 10) : -1;
      progress = p;
      if (Math.round((p.done / (p.total || 1)) * 10) !== prevStep) updateTray();
    });
    service.on('selectDone', (d) => {
      if (d.cancelled || (win && !win.isDestroyed() && win.isVisible() && win.isFocused())) return;
      if (d.found) notify('Подбор завершён', 'Способ найден — YouTube снова работает');
      else notify('Подбор завершён', 'Не удалось подобрать способ');
    });

    hasTray = await detectTray();
    console.log(`[main] tray: ${hasTray ? 'yes' : 'no'}`);
    if (hasTray && !HEADLESS) {
      try {
        tray = new Tray(trayImage());
        tray.on('click', () => (win.isVisible() && win.isFocused() ? win.hide() : showWindow()));
      } catch (e) {
        console.error('[main] tray unavailable', e);
        tray = null;
        hasTray = false;
      }
    }
    try {
      state = await service.getState();
    } catch (e) {
      console.error('[main] getState failed', e);
    }
    updateTray();
    createWindow();
  });
}
