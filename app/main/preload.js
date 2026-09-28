'use strict';

// Sandboxed preload: may only require('electron'), so method/event lists are
// duplicated from ipc.js — keep them in sync.
const { contextBridge, ipcRenderer } = require('electron');

const METHODS = [
  'getState', 'install', 'uninstall', 'setEnabled', 'checkNow', 'startSelect', 'cancelSelect',
  'listStrategies', 'applyStrategy', 'getSettings', 'setSettings', 'getLog', 'getReport',
];
const EVENTS = ['state', 'selectProgress', 'selectDone', 'networkChanged', 'installProgress'];

const api = {};
for (const m of METHODS) {
  api[m] = async (...args) => {
    const res = await ipcRenderer.invoke('ytu:call', m, args);
    if (!res.ok) throw { code: res.error.code, message: res.error.message };
    return res.value;
  };
}

const listeners = new Map(EVENTS.map((e) => [e, new Set()]));
ipcRenderer.on('ytu:event', (_e, name, payload) => {
  const set = listeners.get(name);
  if (set) for (const cb of set) cb(payload);
});

api.on = (name, cb) => {
  const set = listeners.get(name);
  if (!set || typeof cb !== 'function') throw new Error(`unknown event: ${name}`);
  set.add(cb);
  return () => set.delete(cb);
};

contextBridge.exposeInMainWorld('api', api);

// Window chrome of the frameless window — not part of the system API.
contextBridge.exposeInMainWorld('appWindow', {
  minimize: () => ipcRenderer.send('win:minimize'),
  close: () => ipcRenderer.send('win:close'),
  hideToTray: () => ipcRenderer.send('win:hide'),
  forceClose: () => ipcRenderer.send('win:force-close'),
  info: () => ipcRenderer.invoke('win:info'),
  onConfirmClose: (cb) => {
    const listener = () => cb();
    ipcRenderer.on('win:confirm-close', listener);
    return () => ipcRenderer.removeListener('win:confirm-close', listener);
  },
});
