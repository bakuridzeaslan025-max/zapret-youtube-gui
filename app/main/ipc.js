'use strict';

// Bridges window.api (preload) to the service object. The service contract is
// docs/ipc-api.md: async methods below + EventEmitter-style on(event, cb).
// Errors thrown by the service carry {code, message}; code must be one of ERROR_CODES.

const { ipcMain, BrowserWindow } = require('electron');

const ERROR_CODES = new Set([
  'AUTH_CANCELLED', 'AUTH_FAILED', 'NOT_INSTALLED', 'MISSING_REQUIREMENTS',
  'FIREWALL_CONFLICT', 'BUSY', 'HELPER_FAILED',
]);

const isBool = (v) => typeof v === 'boolean';
const SETTINGS_KEYS = ['autostart', 'blockQuic', 'perNetwork', 'advanced'];

// method -> argument validator (returns true when args are acceptable)
const METHODS = {
  getState: (a) => a.length === 0,
  install: (a) => a.length === 0,
  uninstall: (a) => a.length === 0,
  setEnabled: (a) => a.length === 1 && isBool(a[0]),
  checkNow: (a) => a.length === 0,
  startSelect: (a) => a.length === 1 && (a[0] === 'quick' || a[0] === 'deep'),
  cancelSelect: (a) => a.length === 0,
  listStrategies: (a) => a.length === 0,
  applyStrategy: (a) => a.length === 1 && typeof a[0] === 'string' && /^[a-z0-9-]{1,64}$/.test(a[0]),
  getSettings: (a) => a.length === 0,
  setSettings: (a) => a.length === 1 && a[0] !== null && typeof a[0] === 'object'
    && Object.entries(a[0]).every(([k, v]) => SETTINGS_KEYS.includes(k) && isBool(v)),
  getLog: (a) => a.length === 0 || (a.length === 1 && (a[0] === undefined || (Number.isInteger(a[0]) && a[0] > 0 && a[0] <= 10000))),
  getReport: (a) => a.length === 0,
};

// installProgress is not in docs/ipc-api.md yet — proposed, see docs/design-spec.md
const EVENTS = ['state', 'selectProgress', 'selectDone', 'networkChanged', 'installProgress'];

function toError(e) {
  const code = e && ERROR_CODES.has(e.code) ? e.code : 'HELPER_FAILED';
  const message = (e && e.message) || String(e);
  return { code, message };
}

function register(service, { isTrustedSender }) {
  ipcMain.handle('ytu:call', async (event, method, args) => {
    if (!isTrustedSender(event)) return { ok: false, error: { code: 'HELPER_FAILED', message: 'untrusted sender' } };
    if (!Object.hasOwn(METHODS, method) || !Array.isArray(args) || !METHODS[method](args)) {
      return { ok: false, error: { code: 'HELPER_FAILED', message: `bad call: ${method}` } };
    }
    try {
      return { ok: true, value: await service[method](...args) };
    } catch (e) {
      if (!e || !ERROR_CODES.has(e.code)) console.error(`[ipc] ${method} failed:`, e);
      return { ok: false, error: toError(e) };
    }
  });

  // State has no selection progress, so a window (re)loaded mid-selection gets the last event replayed
  let lastProgress = null;
  service.on('selectProgress', (p) => { lastProgress = p; });
  service.on('selectDone', () => { lastProgress = null; });
  service.on('state', (s) => { if (s.service !== 'selecting') lastProgress = null; });

  for (const name of EVENTS) {
    service.on(name, (payload) => {
      for (const w of BrowserWindow.getAllWindows()) {
        if (!w.isDestroyed()) w.webContents.send('ytu:event', name, payload);
      }
    });
  }

  return {
    attach(webContents) {
      webContents.on('did-finish-load', () => {
        if (lastProgress) webContents.send('ytu:event', 'selectProgress', lastProgress);
      });
    },
  };
}

module.exports = { register, METHODS: Object.keys(METHODS), EVENTS };
