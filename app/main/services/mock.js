'use strict';

// Imitation of the service from docs/ipc-api.md for UI development and screenshots.
// YTU_MOCK_SCENARIO picks the starting point and the outcomes (see SCENARIOS),
// YTU_MOCK_SPEED scales every delay (2 = twice as fast, 0.01 = practically frozen).

const { EventEmitter } = require('events');

// same order as the real helper checks them (hardest first)
const HOSTS = [
  { key: 'api', host: 'youtubei.googleapis.com' },
  { key: 'site', host: 'www.youtube.com' },
  { key: 'video', host: 'rr3---sn-n8v7kn7r.googlevideo.com' },
  { key: 'thumbs', host: 'i.ytimg.com' },
];

const STRATEGIES = [
  ['flowseal-general-alt', 'ALT', 'fake,fakedsplit'],
  ['flowseal-general-alt2', 'ALT 2', 'multisplit:pos=2'],
  ['flowseal-general-alt3', 'ALT 3', 'fake:repeats=6 multisplit:pos=midsld'],
  ['flowseal-general-alt4', 'ALT 4', 'fake:tcp_md5 multisplit'],
  ['flowseal-general-alt5', 'ALT 5', 'syndata multidisorder'],
  ['flowseal-general-alt6', 'ALT 6', 'multisplit:pos=1:seqovl=681'],
  ['flowseal-general-alt7', 'ALT 7', 'multisplit:pos=2:seqovl=652'],
  ['flowseal-general-alt8', 'ALT 8', 'fake:badsum multisplit'],
  ['flowseal-general-alt9', 'ALT 9', 'hostfakesplit'],
  ['flowseal-general-alt10', 'ALT 10', 'fake:tcp_ts=-600000'],
  ['flowseal-general-alt11', 'ALT 11', 'fake,multisplit:pos=host+1'],
  ['flowseal-general-alt12', 'ALT 12', 'fakedsplit:pos=midsld'],
  ['flowseal-general-alt13', 'ALT 13', 'fake:autottl multisplit'],
  ['flowseal-general-fake-tls-auto', 'FAKE TLS AUTO', 'fake:blob=tls_auto multisplit:pos=midsld'],
  ['flowseal-general-fake-tls-auto-alt', 'FAKE TLS AUTO ALT', 'fake:blob=tls_auto fakedsplit'],
  ['flowseal-general-fake-tls-auto-alt2', 'FAKE TLS AUTO ALT 2', 'fake:blob=tls_auto:tcp_ts multisplit'],
  ['flowseal-general-fake-tls-auto-alt3', 'FAKE TLS AUTO ALT 3', 'fake:blob=tls_auto multidisorder'],
  ['flowseal-general-simple-fake-alt', 'SIMPLE FAKE ALT', 'fake:repeats=6'],
].map(([id, name, desync]) => ({
  id,
  name,
  source: 'flowseal',
  exact: id !== 'flowseal-general-alt3',
  args: `nfqws2 --filter-tcp=443 --hostlist=youtube.txt ${desync.split(' ').map((d) => '--lua-desync=' + d).join(' ')}`,
}));

const INSTALL_STEPS = ['copy', 'requirements', 'firewall', 'service'];

const NET_HOME = { id: 'wifi:home', label: 'Домашний Wi-Fi', kind: 'wifi' };
const NET_MOBILE = { id: 'mobile:mts', label: 'Мобильный интернет', kind: 'mobile' };

const SCENARIOS = {
  fresh: {},
  'auth-cancel': { installError: 'AUTH_CANCELLED' },
  missing: { installError: 'MISSING_REQUIREMENTS' },
  firewall: { installError: 'FIREWALL_CONFLICT' },
  unblocked: { verdict: 'unblocked' },
  path: { verdict: 'path' },
  on: { installed: true, service: 'on' },
  off: { installed: true, service: 'off' },
  broken: { installed: true, service: 'broken' },
  'selecting-on-start': { installed: true, service: 'on', running: 'quick' },
  'deep-running': { installed: true, service: 'on', running: 'deep' },
  deep: { installed: true, service: 'broken', quickFound: false, deepFound: true },
  'deep-fail': { installed: true, service: 'broken', quickFound: false, deepFound: false },
  'new-network': { installed: true, service: 'on', networkChangeAfter: 4000 },
  offline: { installed: true, service: 'on', offlineAfter: 1500, offlineFor: 8000 },
  'helper-fail': { installed: true, service: 'broken', selectError: 'HELPER_FAILED' },
  // first getState calls fail (main + renderer init) → renderer error screen with retry
  'state-fail': { installed: true, service: 'on', getStateFailures: 2 },
};

const ERROR_TEXT = {
  AUTH_CANCELLED: 'Запрос пароля отменён',
  AUTH_FAILED: 'Неверный пароль',
  NOT_INSTALLED: 'Приложение не установлено в систему',
  MISSING_REQUIREMENTS: 'Не хватает компонентов: nfnetlink_queue',
  FIREWALL_CONFLICT: 'firewalld блокирует очередь NFQUEUE',
  BUSY: 'Уже идёт подбор',
  HELPER_FAILED: 'ytu-helper завершился с ошибкой (код 1)',
};

function fail(code) {
  const e = new Error(ERROR_TEXT[code] || code);
  e.code = code;
  throw e;
}

function pad(n) {
  return String(n).padStart(2, '0');
}

class MockService extends EventEmitter {
  constructor(name, speed) {
    super();
    this.sc = { ...(SCENARIOS[name] || SCENARIOS.fresh) };
    this.speed = speed > 0 ? speed : 1;
    this.installFailuresLeft = this.sc.installError ? 1 : 0;
    this.pathChecksLeft = this.sc.verdict === 'path' ? 1 : 0;
    this.settings = { autostart: true, blockQuic: true, perNetwork: true, advanced: false };
    this.strategyByNet = {};
    this.logLines = [];
    this.run = null;

    const installed = !!this.sc.installed;
    this.network = NET_HOME;
    if (installed) {
      this.strategyByNet[NET_HOME.id] = {
        id: 'flowseal-general-alt3',
        name: 'ALT 3',
        selectedAt: '2026-09-12T18:30:00.000Z',
      };
    }
    this.st = {
      installed,
      service: installed ? this.sc.service : 'off',
      network: this.network,
      online: true,
      strategy: null,
      lastCheck: null,
      requirements: { ok: true, missing: [] },
    };
    if (this.sc.service === 'broken') {
      this.st.lastCheck = this.makeCheck('dpi', Date.now() - 5 * 60e3);
    }
    this.syncStrategy();
    this.log(`сеть: ${this.network.label}`);
    if (installed && this.st.service === 'on') this.log('служба запущена, способ ALT 3');

    if (this.sc.running) {
      setTimeout(() => this.startSelect(this.sc.running, true).catch(() => {}), 0);
    }
    if (this.sc.offlineAfter) {
      setTimeout(() => {
        this.log('сеть пропала');
        this.update({ network: null, online: false, lastCheck: null });
        setTimeout(() => {
          this.log('сеть появилась, перепроверяем');
          this.update({ network: this.network, online: true });
          this.checkNow().catch(() => {});
        }, this.sc.offlineFor / this.speed);
      }, this.sc.offlineAfter / this.speed);
    }
    if (this.sc.networkChangeAfter) {
      setTimeout(() => this.changeNetwork(NET_MOBILE), this.sc.networkChangeAfter);
    }
  }

  delay(ms) {
    return new Promise((r) => setTimeout(r, ms / this.speed));
  }

  log(msg) {
    const d = new Date();
    this.logLines.push(`${pad(d.getDate())}.${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}  ${msg}`);
    if (this.logLines.length > 500) this.logLines.shift();
  }

  syncStrategy() {
    this.st.strategy = this.network ? this.strategyByNet[this.network.id] || null : null;
  }

  update(patch) {
    Object.assign(this.st, patch);
    this.emit('state', this.getStateSync());
  }

  getStateSync() {
    return JSON.parse(JSON.stringify(this.st));
  }

  makeCheck(verdict, at = Date.now()) {
    const ok = verdict === 'unblocked';
    const hosts = HOSTS.map((h) => {
      if (ok) return { ...h, ok: true, ms: 180 + Math.round(Math.random() * 250) };
      if (verdict === 'path') return { ...h, ok: false, ms: null };
      // DPI: the site sometimes leaks through, the rest hangs on the TLS handshake
      return h.key === 'thumbs' ? { ...h, ok: true, ms: 420 } : { ...h, ok: false, ms: null };
    });
    return { at: new Date(at).toISOString(), verdict, hosts };
  }

  changeNetwork(net) {
    this.network = net;
    this.syncStrategy();
    this.log(`сеть сменилась: ${net.label}`);
    const hasStrategy = !!this.st.strategy;
    if (!hasStrategy) this.log('способ для сети не найден');
    this.update({
      network: net,
      service: hasStrategy || this.st.service === 'selecting' ? this.st.service : 'off',
      lastCheck: null,
    });
    this.emit('networkChanged', { network: net, hasStrategy });
  }

  async getState() {
    if (this.sc.getStateFailures > 0) {
      this.sc.getStateFailures--;
      fail('HELPER_FAILED');
    }
    return this.getStateSync();
  }

  async install() {
    if (this.st.installed) return;
    await this.delay(900); // pkexec password prompt
    if (this.installFailuresLeft > 0) {
      this.installFailuresLeft--;
      if (this.sc.installError === 'MISSING_REQUIREMENTS') {
        this.update({ requirements: { ok: false, missing: ['nfnetlink_queue'] } });
      }
      fail(this.sc.installError);
    }
    for (let step = 0; step < INSTALL_STEPS.length; step++) {
      this.emit('installProgress', { step: INSTALL_STEPS[step], done: step, total: INSTALL_STEPS.length });
      await this.delay(700);
    }
    this.emit('installProgress', { step: 'done', done: INSTALL_STEPS.length, total: INSTALL_STEPS.length });
    this.log('установлено в /opt/ytunblock');
    this.update({ installed: true, service: 'off', requirements: { ok: true, missing: [] } });
  }

  async uninstall() {
    if (this.run) fail('BUSY');
    await this.delay(1500);
    this.strategyByNet = {};
    this.syncStrategy();
    this.log('удалено из системы');
    this.update({ installed: false, service: 'off', strategy: null, lastCheck: null });
  }

  async setEnabled(on) {
    if (!this.st.installed) fail('NOT_INSTALLED');
    if (this.run) fail('BUSY');
    if (on && !this.st.strategy) fail('HELPER_FAILED');
    await this.delay(1500); // pkexec + systemd
    this.log(on ? `служба запущена, способ ${this.st.strategy.name}` : 'служба остановлена');
    this.update({ service: on ? 'on' : 'off' });
  }

  async checkNow() {
    await this.delay(2500);
    let verdict;
    if (this.pathChecksLeft > 0) {
      this.pathChecksLeft--;
      verdict = 'path';
    } else if (this.st.service === 'on') {
      verdict = 'unblocked';
    } else if (this.st.service === 'broken') {
      verdict = 'dpi';
    } else {
      verdict = this.sc.verdict === 'unblocked' ? 'unblocked' : 'dpi';
    }
    const res = this.makeCheck(verdict);
    const names = { site: 'сайт', api: 'API', thumbs: 'превью', video: 'видео' };
    this.log('проверка: ' + res.hosts.map((h) => `${names[h.key]} ${h.ok ? '✓' : '✗'}`).join(' '));
    this.update({ lastCheck: res });
    return res;
  }

  async startSelect(mode, resume = false) {
    if (mode !== 'quick' && mode !== 'deep') throw Object.assign(new Error('bad mode'), { code: 'HELPER_FAILED' });
    if (!this.st.installed) fail('NOT_INSTALLED');
    if (this.run) fail('BUSY');
    if (this.sc.selectError) {
      await this.delay(800);
      fail(this.sc.selectError);
    }
    const prev = this.st.service === 'selecting' ? 'off' : this.st.service;
    const run = { mode, cancelled: false, prev, startedAt: Date.now() };
    this.run = run;
    this.log(`подбор (${mode === 'quick' ? 'быстрый' : 'глубокий'}) начат, служба остановлена`);
    this.update({ service: 'selecting' });
    const loop = mode === 'quick' ? this.quickLoop(run, resume) : this.deepLoop(run, resume);
    loop.catch((e) => console.error('[mock] select loop', e));
  }

  finish(run, found, strategy) {
    this.run = null;
    const done = { mode: run.mode, found };
    if (run.cancelled) {
      done.cancelled = true;
      this.log('подбор отменён');
      this.update({ service: run.prev });
    } else if (found) {
      this.strategyByNet[this.network.id] = { ...strategy, selectedAt: new Date().toISOString() };
      this.syncStrategy();
      done.strategyId = strategy.id;
      this.log(`способ найден: ${strategy.name}; служба запущена`);
      this.update({ service: 'on', lastCheck: this.makeCheck('unblocked') });
    } else {
      this.log('подбор не нашёл рабочего способа');
      this.update({ service: run.prev === 'on' ? 'broken' : run.prev });
    }
    this.emit('selectDone', done);
  }

  async quickLoop(run, resume) {
    const total = STRATEGIES.length;
    const winner = this.sc.quickFound === false ? -1 : 4;
    const perHostMs = 900;
    const startedAt = new Date(run.startedAt).toISOString();
    const progress = (i, hosts) => this.emit('selectProgress', {
      mode: 'quick', done: i, total, current: STRATEGIES[i] ? STRATEGIES[i].name : null,
      etaSec: Math.round((total - i) * 8.5), startedAt,
      ...(hosts && { hosts: hosts.map((h) => ({ ...h })) }),
    });
    for (let i = resume ? 4 : 0; i < total; i++) {
      const failAt = i === winner ? -1 : (i * 7) % 4;
      const hosts = HOSTS.map((h) => ({ key: h.key, ok: null }));
      let k = 0;
      if (resume) {
        hosts[0].ok = hosts[1].ok = true;
        k = 2;
        resume = false;
      }
      for (; k < 4; k++) {
        progress(i, hosts);
        await this.delay(perHostMs);
        if (run.cancelled) return this.finish(run, false);
        hosts[k].ok = k !== failAt;
        if (!hosts[k].ok) break;
      }
      progress(i, hosts);
      if (i === winner) {
        const s = STRATEGIES[i];
        return this.finish(run, true, { id: s.id, name: s.name });
      }
    }
    progress(total, null);
    this.finish(run, false);
  }

  async deepLoop(run, resume) {
    const total = 3312;
    const secPerVariant = 2.3;
    const foundAt = this.sc.deepFound === false ? Infinity : 1520;
    let done = resume ? 1240 : 0;
    if (resume) run.startedAt = Date.now() - 48 * 60e3;
    const techniques = ['multisplit', 'multidisorder', 'fakedsplit', 'fake', 'hostfakesplit', 'syndata'];
    const positions = ['1', '2', 'midsld', 'host+1', 'sniext+1', 'method+2'];
    while (done < total) {
      if (run.cancelled) return this.finish(run, false);
      const current = `${techniques[done % techniques.length]}:pos=${positions[(done >> 3) % positions.length]}`;
      this.emit('selectProgress', {
        mode: 'deep',
        done,
        total,
        current,
        etaSec: Math.round((total - done) * secPerVariant),
        startedAt: new Date(run.startedAt).toISOString(),
      });
      if (done >= foundAt) {
        return this.finish(run, true, { id: 'blockcheck2-multisplit-host1', name: 'multisplit host+1' });
      }
      await this.delay(250);
      done = Math.min(total, done + 20);
    }
    this.emit('selectProgress', { mode: 'deep', done: total, total, current: null, etaSec: 0, startedAt: new Date(run.startedAt).toISOString() });
    this.finish(run, false);
  }

  async cancelSelect() {
    if (!this.run) return;
    this.run.cancelled = true;
  }

  async listStrategies() {
    return STRATEGIES.map((s) => ({ ...s }));
  }

  async applyStrategy(id) {
    if (!this.st.installed) fail('NOT_INSTALLED');
    if (this.run) fail('BUSY');
    const s = STRATEGIES.find((x) => x.id === id);
    if (!s) fail('HELPER_FAILED');
    await this.delay(1200);
    this.strategyByNet[this.network.id] = { id: s.id, name: s.name, selectedAt: new Date().toISOString() };
    this.syncStrategy();
    this.log(`способ выбран вручную: ${s.name}`);
    this.update({ service: 'on' });
  }

  async getSettings() {
    return { ...this.settings };
  }

  async setSettings(patch) {
    for (const k of Object.keys(patch)) {
      if (k in this.settings && typeof patch[k] === 'boolean') this.settings[k] = patch[k];
    }
    return { ...this.settings };
  }

  async getLog(lines = 200) {
    return this.logLines.slice(-lines).join('\n');
  }

  async getReport() {
    const s = this.st;
    return [
      'ytunblock report (mock)',
      `installed: ${s.installed}, service: ${s.service}`,
      `network: ${s.network ? `${s.network.kind} "${s.network.label}"` : '-'}`,
      `strategy: ${s.strategy ? s.strategy.id : '-'}`,
      `last check: ${s.lastCheck ? `${s.lastCheck.verdict} ${s.lastCheck.hosts.map((h) => `${h.key}=${h.ok ? h.ms + 'ms' : 'fail'}`).join(' ')}` : '-'}`,
      `requirements: ${s.requirements.ok ? 'ok' : s.requirements.missing.join(',')}`,
      '',
      ...this.logLines.slice(-50),
    ].join('\n');
  }
}

function create() {
  return new MockService(process.env.YTU_MOCK_SCENARIO || 'fresh', parseFloat(process.env.YTU_MOCK_SPEED || '1'));
}

module.exports = { create, SCENARIOS: Object.keys(SCENARIOS) };
