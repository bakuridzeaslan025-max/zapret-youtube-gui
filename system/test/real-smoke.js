'use strict';
// Smoke test of app/main/services/real.js inside the systemd test container, run as root
// (pkexec then needs no agent). Usage: node real-smoke.js <repo>
const path = require('path');
const { create } = require(path.join(process.argv[2], 'app/main/services/real.js'));

let fail = 0;
const ok = (c, name, extra = '') => {
  console.log(`${c ? 'PASS' : 'FAIL'} ${name}${extra ? ': ' + extra : ''}`);
  if (!c) fail = 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms) => {
  const t = Date.now();
  while (Date.now() - t < ms) {
    if (fn()) return true;
    await sleep(200);
  }
  return false;
};

(async () => {
  const svc = create({ app: { isPackaged: false, getVersion: () => 'test' } });
  const events = { state: [], selectProgress: [], selectDone: [], installProgress: [] };
  for (const k of Object.keys(events)) svc.on(k, (p) => events[k].push(p));

  let st = await svc.getState();
  ok(st.installed === false && Array.isArray(st.requirements.missing), 'state before install', JSON.stringify(st.requirements));

  await svc.install();
  st = await svc.getState();
  ok(st.installed, 'install');
  ok(events.installProgress.length >= 8 && events.installProgress.every((e) => typeof e.step === 'string' && e.total > 0), 'installProgress events', events.installProgress.map((e) => e.step).join(','));

  const list = await svc.listStrategies();
  ok(list.length >= 18 && list.every((s) => s.id && s.name && s.source && typeof s.args === 'string'), 'listStrategies', list.slice(0, 3).map((s) => `${s.id}=${s.name}/${s.source}`).join(' '));
  ok(list.some((s) => s.name === 'ALT 11'), 'flowseal names');

  try {
    await svc.setEnabled(true);
    ok(false, 'setEnabled without strategy fails');
  } catch (e) {
    ok(e.code === 'HELPER_FAILED', 'setEnabled without strategy fails', e.code);
  }

  await svc.applyStrategy('flowseal-general-alt11');
  st = await svc.getState();
  ok(st.service === 'on' && st.strategy && st.strategy.id === 'flowseal-general-alt11' && st.strategy.name === 'ALT 11', 'applyStrategy starts service', JSON.stringify(st.strategy) + ' ' + st.service);

  try {
    await svc.applyStrategy('../etc/passwd');
    ok(false, 'bad id refused');
  } catch (e) {
    ok(e.code === 'HELPER_FAILED', 'bad id refused', e.message);
  }

  const chk = await svc.checkNow();
  ok(['unblocked', 'dpi', 'path'].includes(chk.verdict) && chk.hosts.length === 4, 'checkNow', `${chk.verdict} ${chk.hosts.map((h) => `${h.key}:${h.ok}:${h.ms}`).join(' ')}`);

  await svc.setSettings({ blockQuic: false });
  st = svc.status;
  ok(st.quic === false, 'setSettings blockQuic=false -> helper');
  await svc.setSettings({ blockQuic: true });
  ok(svc.status.quic === true, 'setSettings blockQuic=true -> helper');

  await svc.setEnabled(false);
  st = await svc.getState();
  ok(st.service === 'off', 'setEnabled(false)');
  await svc.setEnabled(true);
  st = await svc.getState();
  ok(st.service === 'on', 'setEnabled(true)');

  // real (not simulated) quick select through the container network, cancelled after some progress
  await svc.startSelect('quick');
  st = await svc.getState();
  ok(st.service === 'selecting', 'startSelect -> selecting');
  try {
    await svc.startSelect('quick');
    ok(false, 'second startSelect BUSY');
  } catch (e) {
    ok(e.code === 'BUSY', 'second startSelect BUSY');
  }
  try {
    await svc.setEnabled(false);
    ok(false, 'setEnabled BUSY while selecting');
  } catch (e) {
    ok(e.code === 'BUSY', 'setEnabled BUSY while selecting');
  }
  await waitFor(() => events.selectProgress.length >= 3, 60000);
  const p = events.selectProgress[events.selectProgress.length - 1];
  ok(p && p.mode === 'quick' && p.total > 0 && p.hosts && p.hosts.length === 4 && p.hosts.every((h) => ['site', 'api', 'thumbs', 'video'].includes(h.key)) && p.startedAt, 'selectProgress shape', JSON.stringify(p));

  // a second GUI instance attaches to the running selection
  const svc2 = create({ app: { isPackaged: false, getVersion: () => 'test' } });
  const p2 = [];
  const d2 = [];
  svc2.on('selectProgress', (x) => p2.push(x));
  svc2.on('selectDone', (x) => d2.push(x));
  await svc2.getState();
  await waitFor(() => p2.length > 0, 15000);
  ok(p2.length > 0, 'second instance attaches via select-follow', String(p2.length));

  await svc.cancelSelect();
  await waitFor(() => events.selectDone.length > 0 && d2.length > 0, 30000);
  ok(events.selectDone[0] && events.selectDone[0].cancelled === true, 'selectDone cancelled', JSON.stringify(events.selectDone[0]));
  ok(d2[0] && d2[0].cancelled === true, 'attached instance gets selectDone', JSON.stringify(d2[0]));
  await sleep(2000);
  st = await svc.refreshNow();
  ok(st.service === 'on', 'service restored after cancel', st.service);

  const log = await svc.getLog(50);
  ok(log.includes('# helper') && log.includes('# app'), 'getLog');
  const rep = await svc.getReport();
  ok(rep.includes('strategy: flowseal-general-alt11') && rep.includes('## select quick'), 'getReport');

  await svc.uninstall();
  st = await svc.getState();
  ok(!st.installed, 'uninstall');

  svc.dispose();
  svc2.dispose();
  console.log(fail ? 'SOME FAILED (real.js)' : 'ALL PASS (real.js)');
  process.exit(fail);
})().catch((e) => {
  console.log('FAIL exception', e.code, e.message);
  process.exit(1);
});
