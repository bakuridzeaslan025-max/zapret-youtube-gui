'use strict';

// Real service (docs/ipc-api.md): root actions via `pkexec /opt/ytunblock/bin/ytu-helper`,
// availability check and network detection without root.

const { EventEmitter } = require('events');
const { spawn, execFile } = require('child_process');
const crypto = require('crypto');
const dns = require('dns').promises;
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const readline = require('readline');
const tls = require('tls');

const ROOT = '/opt/ytunblock';
const HELPER = `${ROOT}/bin/ytu-helper`;
const LOG_DIR = '/var/log/ytunblock';
const PKEXEC_CANDIDATES = ['/usr/bin/pkexec', '/bin/pkexec'];
const SYS_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

// Same hosts and order semantics as YTU_CHECK_HOSTS in system/lib/common.sh
const HOSTS = [
  { key: 'site', host: 'www.youtube.com' },
  { key: 'api', host: 'youtubei.googleapis.com' },
  { key: 'thumbs', host: 'i.ytimg.com' },
  { key: 'video', host: 'redirector.googlevideo.com' },
];
const KEY_BY_HOST = Object.fromEntries(HOSTS.map((h) => [h.host, h.key]));
// Served by the same Google front ends, not blocked: tells DPI (SNI) apart from a dead path
const INNOCENT_SNI = 'www.google.com';
const TARGET_TIMEOUT_MS = 8000;
const INNOCENT_TIMEOUT_MS = 4000;

const POLL_MS = 10000;
// after a selection ends its unit may still be deactivating: do not re-attach to it
const REATTACH_GRACE_MS = 15000;

// Runs as root from argv (fixed at exec, nothing is read from the user-writable staging as code):
// copies the staging into a root-only dir without following links, refuses links/special files
// and files outside the manifest, verifies sha256 of every file, then runs install.sh from the copy.
const INSTALL_BOOTSTRAP = `set -u
S=$1; M=$2; shift 2
fail() { printf '{"error":"HELPER_FAILED","message":"%s"}\\n' "$1"; exit 1; }
R=$(mktemp -d) || fail "mktemp failed"
trap 'rm -rf "$R"' EXIT
cp -RP "$S/system" "$S/strategies" "$R/" || fail "copy failed"
[ -z "$(find "$R" ! -type f ! -type d)" ] || fail "staging contains links or special files"
cd "$R" || fail "cd failed"
[ "$(find system strategies -type f | LC_ALL=C sort)" = "$(printf '%s\\n' "$M" | sed 's/^[0-9a-f]*  //' | LC_ALL=C sort)" ] ||
  fail "staging does not match the manifest"
printf '%s\\n' "$M" | sha256sum -c --quiet --strict >/dev/null 2>&1 || fail "staging checksum mismatch"
/bin/sh "$R/system/install.sh" "$@"`;
const DEFAULT_SETTINGS = { autostart: true, blockQuic: true, perNetwork: true, advanced: false };

function svcError(code, message) {
  return Object.assign(new Error(message || code), { code });
}

function execFileP(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 5000, env: { ...process.env, PATH: SYS_PATH, LC_ALL: 'C' }, ...opts },
      (err, stdout, stderr) => (err ? reject(Object.assign(err, { stderr })) : resolve(String(stdout))));
  });
}

function sha(s) {
  return crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
}

function nowStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getDate())}.${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// flowseal "general (FAKE TLS AUTO ALT2).bat" -> "FAKE TLS AUTO ALT 2"; own strategies keep their id
function strategyName(s) {
  const src = (s.sources && s.sources[0]) || '';
  const m = /^general \(([^)]+)\)\.bat$/.exec(src);
  return m ? m[1].replace(/([A-Z])(\d+)$/, '$1 $2') : s.id;
}

function strategySource(id) {
  if (id.startsWith('flowseal-')) return 'flowseal';
  if (id.startsWith('bc2-')) return 'blockcheck2';
  return 'own';
}

// nmcli -t escapes ':' and '\' inside values
function splitNmcli(line) {
  const out = [];
  let cur = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '\\' && i + 1 < line.length) cur += line[++i];
    else if (c === ':') { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur);
  return out;
}

function kindByNmType(t) {
  if (t === '802-11-wireless' || t === 'wifi') return 'wifi';
  if (t === '802-3-ethernet' || t === 'ethernet') return 'ethernet';
  if (t === 'gsm' || t === 'cdma' || t === 'wwan') return 'mobile';
  return 'other';
}

function kindByDev(dev) {
  if (/^wl/.test(dev)) return 'wifi';
  if (/^(ww|usb|rmnet)/.test(dev)) return 'mobile';
  if (/^(en|eth)/.test(dev)) return 'ethernet';
  return 'other';
}

async function detectNetwork() {
  let route;
  try {
    const def = async (v) => (await execFileP('ip', [v, 'route', 'show', 'default'])).split('\n').find((l) => l.startsWith('default'));
    route = (await def('-4')) || (await def('-6'));
  } catch (e) {
    // no usable `ip`: networks cannot be told apart, but that is not "offline"
    return e.code === 'ENOENT' ? { id: 'n-unknown', label: 'Сеть', kind: 'other' } : null;
  }
  if (!route) return null;
  const dev = (/ dev (\S+)/.exec(route) || [])[1];
  const via = (/ via (\S+)/.exec(route) || [])[1];
  if (!dev) return null;

  try {
    const out = await execFileP('nmcli', ['-t', '-f', 'NAME,UUID,TYPE,DEVICE', 'connection', 'show', '--active']);
    for (const line of out.split('\n')) {
      if (!line) continue;
      const [name, uuid, type, device] = splitNmcli(line);
      if (device === dev && uuid) return { id: 'n-' + sha('nm:' + uuid), label: name || dev, kind: kindByNmType(type) };
    }
  } catch { /* no NetworkManager */ }

  let mac = '';
  if (via) {
    try {
      mac = (/lladdr (\S+)/.exec(await execFileP('ip', ['neigh', 'show', via, 'dev', dev])) || [])[1] || '';
    } catch { /* ignore */ }
  }
  return { id: 'n-' + sha(`gw:${dev}|${mac || via || ''}`), label: dev, kind: kindByDev(dev) };
}

// TLS handshake + first HTTP bytes to `ip` with SNI `servername`
function probe(ip, servername, timeoutMs, wantHttp) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let finished = false;
    let tcp = false;
    const sock = tls.connect({
      host: ip, port: 443, servername, rejectUnauthorized: false, ALPNProtocols: ['http/1.1'],
    });
    const done = (r) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      sock.destroy();
      resolve({ ms: Date.now() - t0, tcp, ...r });
    };
    const timer = setTimeout(() => done({ ok: false, err: 'timeout' }), timeoutMs);
    sock.once('connect', () => { tcp = true; });
    sock.once('secureConnect', () => {
      if (!wantHttp) return done({ ok: true, tls: true });
      sock.write(`HEAD / HTTP/1.1\r\nHost: ${servername}\r\nUser-Agent: Mozilla/5.0\r\nConnection: close\r\n\r\n`);
    });
    sock.once('data', () => done({ ok: true, tls: true }));
    sock.once('error', (e) => done({ ok: false, err: e.code || e.message, alert: /SSL|TLS/i.test(String(e.code || e.message)) }));
    sock.once('close', () => done({ ok: false, err: 'closed' }));
  });
}

// resolver answers that cannot be the real host: DNS-level blocking, not DPI (198.18/15 is left
// alone: local fake-ip proxies use it)
function bogusAddress(ip) {
  return /^(0\.|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip) || ip === '::1' || ip === '::';
}

async function checkFamily(host, family) {
  let ip;
  try {
    ip = (await dns.lookup(host, { family })).address;
  } catch {
    return family === 6 ? null : { ok: false, why: 'dns' };
  }
  if (bogusAddress(ip)) return { ok: false, why: 'dns' };
  const t = await probe(ip, host, TARGET_TIMEOUT_MS, true);
  if (t.ok) return { ok: true, ms: t.ms };
  // server reachable with a harmless SNI (handshake or at least a TLS alert) => the SNI is what's blocked
  const i = await probe(ip, INNOCENT_SNI, INNOCENT_TIMEOUT_MS, false);
  return { ok: false, why: i.ok || i.alert ? 'dpi' : 'path' };
}

// IPv4 always; IPv6 too when v6 actually works, since browsers then prefer it.
// A v6 failure that is not DPI (path) does not fail the host while v4 works: browsers fall back.
async function checkHost({ key, host }, { v6 = false } = {}) {
  const [a, b] = await Promise.all([checkFamily(host, 4), v6 ? checkFamily(host, 6) : null]);
  const bad = [a, b].find((r) => r && !r.ok && !(r === b && a.ok && r.why !== 'dpi'));
  if (bad) return { key, host, ok: false, ms: null, why: bad.why, family: bad === a ? 4 : 6 };
  return { key, host, ok: true, ms: a.ms };
}

// a v6 default route (RA, VPN) is not v6 connectivity: require a handshake with an unblocked host
async function hasV6() {
  try {
    if (!/^default/m.test(await execFileP('ip', ['-6', 'route', 'show', 'default']))) return false;
    const ip = (await dns.lookup(INNOCENT_SNI, { family: 6 })).address;
    const p = await probe(ip, INNOCENT_SNI, INNOCENT_TIMEOUT_MS, false);
    return p.ok || !!p.alert;
  } catch {
    return false;
  }
}

class RealService extends EventEmitter {
  constructor({ app } = {}) {
    super();
    this.app = app;
    this.configDir = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'ytunblock');
    this.settingsFile = path.join(this.configDir, 'settings.json');
    this.settings = { ...DEFAULT_SETTINGS, ...this.readJson(this.settingsFile) };
    this.status = null;
    this.network = null;
    this.lastCheck = null;
    this.checkWhileOn = false;
    this.select = null;
    this.logLines = [];
    this.lastStateJson = '';
    this.queue = Promise.resolve();
    this.syncedNetwork = undefined;
    this.catalog = null;
    this.pollTimer = setInterval(() => this.refresh().catch(() => {}), POLL_MS);
    if (this.pollTimer.unref) this.pollTimer.unref();
    this.refresh().catch(() => {});
    this.watchRoutes();
  }

  // ---- infrastructure ----

  readJson(file) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return {};
    }
  }

  log(msg) {
    this.logLines.push(`${nowStamp()}  ${msg}`);
    if (this.logLines.length > 1000) this.logLines.shift();
  }

  payloadDir() {
    if (this.app && this.app.isPackaged) return path.join(process.resourcesPath, 'payload');
    return path.resolve(__dirname, '..', '..', '..');
  }

  pkexec() {
    const p = PKEXEC_CANDIDATES.find((c) => fs.existsSync(c));
    if (!p) throw svcError('HELPER_FAILED', 'pkexec не найден (нужен пакет polkit/pkexec)');
    return p;
  }

  installed() {
    return fs.existsSync(HELPER);
  }

  // Spawns a helper-style process, parses JSON lines. Resolves with the last JSON object.
  run(cmd, argv, { onLine, viaPkexec } = {}) {
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn(cmd, argv, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PATH: SYS_PATH } });
      } catch (e) {
        reject(svcError('HELPER_FAILED', e.message));
        return;
      }
      let last = null;
      let stderr = '';
      child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
      readline.createInterface({ input: child.stdout }).on('line', (line) => {
        let obj;
        try {
          obj = JSON.parse(line);
        } catch {
          return;
        }
        last = obj;
        if (onLine) onLine(obj);
      });
      child.on('error', (e) => reject(svcError('HELPER_FAILED', e.message)));
      child.on('close', (code) => {
        if (code === 0 && !(last && last.error)) return resolve(last || {});
        if (last && last.error) return reject(svcError(last.error, last.message));
        // 126/127 also come from a missing/unexecutable target, so look at pkexec's own message
        if (viaPkexec && (code === 126 || code === 127)) {
          if (/dismissed/i.test(stderr)) return reject(svcError('AUTH_CANCELLED', 'Запрос пароля отменён'));
          if (/not authorized|authentication|authoriz|polkit/i.test(stderr)) {
            return reject(svcError('AUTH_FAILED', stderr.trim() || 'Не удалось получить права'));
          }
        }
        reject(svcError('HELPER_FAILED', `код ${code}: ${stderr.trim().split('\n').slice(-3).join(' ')}`));
      });
    });
  }

  helper(args, opts = {}) {
    if (!this.installed()) return Promise.reject(svcError('NOT_INSTALLED', 'Приложение не установлено в систему'));
    return this.run(this.pkexec(), [HELPER, ...args], { ...opts, viaPkexec: true });
  }

  // root helper calls are serialized: the helper itself answers BUSY to concurrent ones
  exclusive(fn) {
    const p = this.queue.then(fn, fn);
    this.queue = p.catch(() => {});
    return p;
  }

  async readStatus() {
    if (this.installed()) return this.run(HELPER, ['status']);
    const payloadHelper = path.join(this.payloadDir(), 'system', 'bin', 'ytu-helper');
    if (fs.existsSync(payloadHelper)) return this.run('/bin/sh', [payloadHelper, 'status']);
    return { installed: false, service: 'off', requirements: { ok: false, missing: [] }, strategies: {}, custom: [] };
  }

  loadCatalog() {
    if (this.catalog) return this.catalog;
    const files = [`${ROOT}/strategies/nfqws2.json`, path.join(this.payloadDir(), 'strategies', 'nfqws2.json')];
    for (const f of files) {
      const j = this.readJson(f);
      if (Array.isArray(j.strategies)) {
        this.catalog = j.strategies.map((s) => ({
          id: s.id,
          name: strategyName(s),
          source: strategySource(s.id),
          exact: s.exact !== false,
          args: s.nfqws2.join(' ').split('{FAKE}').join(`${ROOT}/zapret2/files/fake`),
        }));
        return this.catalog;
      }
    }
    return [];
  }

  strategyName(id) {
    const s = this.loadCatalog().find((x) => x.id === id);
    if (s) return s.name;
    return id.startsWith('bc2-') ? `blockcheck2 #${id.slice(4)}` : id;
  }

  ownNetworkStrategy() {
    const st = (this.status && this.status.strategies) || {};
    return this.settings.perNetwork && this.network ? (st.networks || {})[this.network.id] || null : st.default || null;
  }

  // the strategy the service actually runs here: the network's own, else the shared default
  // (`shared: true`) — the same fallback as effective_strategy_file in the helper
  networkStrategy() {
    const st = (this.status && this.status.strategies) || {};
    const own = this.ownNetworkStrategy();
    const rec = own || st.default;
    if (!rec) return null;
    const r = { id: rec.id, name: this.strategyName(rec.id), selectedAt: rec.selectedAt };
    if (!own) r.shared = true;
    return r;
  }

  // helper keeps the "current network" to pick the per-network strategy for the root service.
  // locked: caller already holds exclusive(). BUSY is retried on the next poll; other failures
  // are not, so a missing polkit agent does not prompt every 10 s.
  async syncNetwork({ locked = false } = {}) {
    if (!this.status || !this.status.installed || this.select) return;
    const want = this.settings.perNetwork && this.network ? this.network.id : null;
    if ((this.status.network || null) === want || this.syncedNetwork === want) return;
    const call = () => this.helper(want ? ['apply', '-', '--network', want] : ['apply', '-']);
    try {
      await (locked ? call() : this.exclusive(call));
    } catch (e) {
      if (e.code !== 'BUSY') this.syncedNetwork = want;
      throw e;
    }
    this.syncedNetwork = want;
    this.status = await this.readStatus();
  }

  // settings are the source of truth; a change refused as BUSY during selection lands here later
  async syncQuic() {
    const st = this.status;
    if (!st || !st.installed || this.select || typeof st.quic !== 'boolean') return;
    if (st.quic === this.settings.blockQuic || this.quicSyncFailed === this.settings.blockQuic) return;
    try {
      await this.exclusive(() => this.helper(['set-quic', this.settings.blockQuic ? 'on' : 'off']));
      this.status = await this.readStatus();
    } catch (e) {
      this.quicSyncFailed = this.settings.blockQuic;
      this.log(`не удалось переключить QUIC: ${e.message}`);
    }
  }

  async refresh() {
    const [status, network] = await Promise.all([this.readStatus().catch(() => this.status), detectNetwork()]);
    if (status) this.status = status;
    if (this.status && this.status.service === 'selecting' && !this.select
      && Date.now() - (this.selectEndedAt || 0) > REATTACH_GRACE_MS) this.attachSelect();
    const prev = this.network;
    this.network = network;
    const wasOnline = this.online;
    this.online = !!network;
    if (wasOnline === true && !this.online) {
      this.log('сеть пропала');
      this.lastCheck = null;
      this.checkWhileOn = false;
    }
    const lastId = this.lastNetworkId;
    if (network) this.lastNetworkId = network.id;
    // compare with the last known network, not the previous poll: it may have been offline in between
    if (network && lastId && lastId !== network.id) {
      this.log(`сеть сменилась: ${network.label}`);
      this.lastCheck = null;
      this.checkWhileOn = false;
      await this.syncNetwork().catch((e) => this.log(`не удалось переключить сеть: ${e.message}`));
      const hasStrategy = !!this.ownNetworkStrategy();
      if (!hasStrategy) this.log('способ для сети не подобран');
      this.emit('networkChanged', { network, hasStrategy });
    } else if (network && !prev) {
      if (!this.restoreTried) {
        this.restoreTried = true;
        await this.restoreStrategies().catch((e) => this.log(`восстановление способов: ${e.message}`));
        // installs made before the copy existed get one now
        const st = (this.status && this.status.strategies) || {};
        if (st.default || Object.keys(st.networks || {}).length) await this.backupStrategies();
      }
      await this.syncNetwork().catch(() => {});
    }
    await this.syncQuic();
    this.emitState();
    if (wasOnline === false && this.online) {
      this.log('сеть появилась, перепроверяем');
      if (this.status && this.status.installed && !this.select) this.checkNow().catch(() => {});
    }
  }

  // react to route changes right away instead of waiting for the 10 s poll (no root needed)
  watchRoutes() {
    try {
      const mon = this.routeMon = spawn('ip', ['monitor', 'route'], { stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, PATH: SYS_PATH } });
      mon.on('error', () => {});
      mon.stdout.on('data', () => {
        clearTimeout(this.routeTimer);
        this.routeTimer = setTimeout(() => this.refresh().catch(() => {}), 1500);
      });
      if (mon.unref) mon.unref();
    } catch { /* polling still works */ }
  }

  dispose() {
    clearInterval(this.pollTimer);
    clearTimeout(this.routeTimer);
    if (this.routeMon) this.routeMon.kill();
    this.routeMon = null;
  }

  buildState() {
    const s = this.status || {};
    let service = 'off';
    if (this.select || s.service === 'selecting') service = 'selecting';
    else if (s.service === 'failed') service = 'broken';
    else if (s.service === 'on') service = this.checkWhileOn && this.lastCheck && this.lastCheck.verdict !== 'unblocked' ? 'broken' : 'on';
    return {
      installed: !!s.installed,
      service,
      network: this.network,
      online: !!this.network,
      strategy: this.networkStrategy(),
      lastCheck: this.lastCheck,
      requirements: s.requirements || { ok: false, missing: [] },
    };
  }

  emitState() {
    const st = this.buildState();
    const j = JSON.stringify(st);
    if (j !== this.lastStateJson) {
      this.lastStateJson = j;
      this.emit('state', st);
    }
    return st;
  }

  async refreshNow() {
    this.status = await this.readStatus().catch(() => this.status);
    return this.emitState();
  }

  // ---- window.api ----

  async getState() {
    if (!this.status) await this.refresh().catch(() => {});
    return this.buildState();
  }

  async install() {
    if (this.select) throw svcError('BUSY', 'Идёт подбор');
    const src = this.payloadDir();
    // root cannot read the user's FUSE mount of the AppImage: hand it a world-readable copy
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'ytunblock-install-'));
    try {
      await fsp.chmod(tmp, 0o755);
      for (const d of ['system', 'strategies']) {
        await fsp.cp(path.join(src, d), path.join(tmp, d), {
          recursive: true,
          filter: (p) => !p.split(path.sep).includes('test'),
        });
      }
      await chmodTree(tmp);
      // hashes come from the read-only AppImage, not from the staging copy
      const manifest = await makeManifest(src);
      const args = ['--exec-name', path.basename(process.execPath)];
      if (process.env.APPIMAGE) args.push('--appimage', process.env.APPIMAGE);
      const argv = ['/bin/sh', '-c', INSTALL_BOOTSTRAP, 'ytunblock-install', tmp, manifest, ...args];
      const res = await this.exclusive(() => this.run(this.pkexec(), argv, {
        viaPkexec: true,
        onLine: (o) => {
          if (o.event === 'step') this.emit('installProgress', { step: o.step, done: o.done, total: o.total });
        },
      }).catch((e) => {
        if (e.code === 'MISSING_REQUIREMENTS') this.refreshNow().catch(() => {});
        throw e;
      }));
      this.emit('installProgress', { step: 'done', done: 1, total: 1 });
      this.log(`установлено в ${ROOT} (${res.version || ''}, AppArmor: ${res.apparmor || '-'})`);
      if (res.apparmorNote) this.log(`AppArmor: ${res.apparmorNote}`);
      this.restoreTried = true;
      this.catalog = null;
      this.syncedNetwork = undefined;
      await this.refreshNow();
      await this.syncNetwork().catch(() => {});
      await this.restoreStrategies().catch((e) => this.log(`восстановление способов: ${e.message}`));
      await this.syncQuic();
      await this.applyAutostart().catch((e) => this.log(`автозапуск: ${e.message}`));
    } finally {
      fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
    this.emitState();
  }

  async uninstall() {
    if (this.select) throw svcError('BUSY', 'Идёт подбор');
    if (!this.installed()) throw svcError('NOT_INSTALLED', 'Приложение не установлено в систему');
    // own polkit action (auth_admin) bound to this path
    await this.exclusive(() => this.run(this.pkexec(), [`${ROOT}/uninstall.sh`], { viaPkexec: true }));
    await fsp.rm(this.autostartFile(), { force: true });
    this.lastCheck = null;
    this.checkWhileOn = false;
    this.log('удалено из системы');
    await this.refreshNow();
  }

  async setEnabled(on) {
    if (this.select) throw svcError('BUSY', 'Идёт подбор');
    await this.exclusive(async () => {
      await this.syncNetwork({ locked: true });
      await this.helper([on ? 'start' : 'stop']);
    });
    this.lastCheck = null;
    this.checkWhileOn = false;
    this.log(on ? `служба запущена, способ ${(this.networkStrategy() || {}).name || '-'}` : 'служба остановлена');
    await this.refreshNow();
  }

  async checkNow() {
    const v6 = await hasV6();
    const hosts = await Promise.all(HOSTS.map((h) => checkHost(h, { v6 })));
    let verdict = 'unblocked';
    if (hosts.some((h) => !h.ok)) verdict = hosts.some((h) => h.why === 'dpi') ? 'dpi' : 'path';
    const res = { at: new Date().toISOString(), verdict, hosts: hosts.map(({ key, host, ok, ms }) => ({ key, host, ok, ms })) };
    this.lastCheck = res;
    this.checkWhileOn = !!(this.status && this.status.service === 'on');
    const names = { site: 'сайт', api: 'API', thumbs: 'превью', video: 'видео' };
    this.log(`проверка (${verdict}${v6 ? ', с IPv6' : ''}): `
      + hosts.map((h) => `${names[h.key]} ${h.ok ? '✓' : `✗${h.why ? ` ${h.why}/v${h.family}` : ''}`}`).join(' '));
    await this.refreshNow();
    return res;
  }

  selectLineHandler(sel) {
    return (o) => {
      if (o.event === 'progress') {
        sel.mode = o.mode;
        sel.started = true;
        if (sel.onStarted) sel.onStarted();
        this.emit('selectProgress', {
          mode: o.mode,
          done: o.done,
          total: o.total,
          current: o.current,
          etaSec: o.etaSec,
          startedAt: o.startedAt,
          hosts: (o.hosts || []).map((h) => ({ key: KEY_BY_HOST[h.host] || h.host, ok: h.ok })),
        });
      } else if (o.event === 'done') {
        sel.mode = o.mode || sel.mode;
        sel.result = o;
      }
    };
  }

  // The selection runs in the root unit ytunblock-select; this process only follows it,
  // so closing the GUI does not stop it (docs/ipc-api.md).
  async startSelect(mode) {
    if (this.select) throw svcError('BUSY', 'Уже идёт подбор');
    if (!this.installed()) throw svcError('NOT_INSTALLED', 'Приложение не установлено в систему');
    const args = ['select', mode];
    if (this.settings.perNetwork && this.network) args.push('--network', this.network.id);
    const sel = { mode, result: null, started: false };
    this.select = sel;
    this.log(`подбор (${mode === 'quick' ? 'быстрый' : 'глубокий'}) начат, служба остановлена`);
    this.emitState();

    const started = new Promise((resolve) => { sel.onStarted = resolve; });
    const proc = this.helper(args, { onLine: this.selectLineHandler(sel) });
    const outcome = proc.then(() => null, (e) => e);
    outcome.then((e) => this.finishSelect(sel, e));
    await Promise.race([started, outcome]);
    if (!sel.started) {
      const e = await outcome;
      throw e || svcError('HELPER_FAILED', 'подбор завершился, не начавшись');
    }
  }

  // GUI (re)started while a selection is running: follow it without root
  attachSelect() {
    if (this.select || !this.installed()) return;
    const sel = { mode: null, result: null, started: true, attached: true };
    this.select = sel;
    this.log('подключились к идущему подбору');
    this.run(HELPER, ['select-follow'], { onLine: this.selectLineHandler(sel) })
      .then(() => null, (e) => e)
      .then((e) => this.finishSelect(sel, e));
  }

  async finishSelect(sel, err) {
    if (err) sel.error = err;
    this.select = null;
    this.selectEndedAt = Date.now();
    const r = sel.result || {};
    if (sel.started && (err || r.reason === 'interrupted')) {
      // unit killed without its trap: blockcheck2 tables and a stopped service may be left;
      // `cancel` runs the helper's recovery (status is read without root and cannot)
      await this.helper(['cancel']).catch((e) => this.log(`восстановление после подбора: ${e.message}`));
    }
    if (!sel.started) {
      this.log(`подбор не запустился: ${err ? err.message : '?'}`);
      await this.refreshNow().catch(() => {});
      return;
    }
    const done = { mode: sel.mode, found: !!r.found };
    if (r.cancelled) {
      done.cancelled = true;
      this.log('подбор отменён');
    } else if (r.found) {
      done.strategyId = r.strategyId;
      this.catalog = null;
      this.lastCheck = null;
      this.checkWhileOn = false;
      this.log(`способ найден: ${this.strategyName(r.strategyId)}`);
      await this.refreshNow().catch(() => {});
      await this.backupStrategies();
      for (let i = 0; i < 30 && this.status && this.status.service === 'selecting'; i++) {
        await new Promise((r2) => setTimeout(r2, 500));
        await this.refreshNow().catch(() => {});
      }
      if (this.status && this.status.service !== 'on') {
        await this.exclusive(() => this.helper(['start']))
          .then(() => this.log('служба запущена'))
          .catch((e) => this.log(`служба не запустилась: ${e.message}`));
      }
    } else if (err) {
      this.log(`подбор прерван ошибкой: ${err.message}`);
    } else {
      this.log(`подбор не нашёл рабочего способа${r.reason ? ` (${r.reason})` : ''}`);
    }
    await this.refreshNow().catch(() => {});
    await this.syncNetwork().catch(() => {});
    await this.syncQuic();
    this.emit('selectDone', done);
  }

  async cancelSelect() {
    if (!this.select) return;
    await this.helper(['cancel']);
  }

  async listStrategies() {
    const list = this.loadCatalog().map((s) => ({ ...s }));
    for (const c of (this.status && this.status.custom) || []) {
      list.push({ id: c.id, name: this.strategyName(c.id), source: 'blockcheck2', exact: true, args: c.args });
    }
    return list;
  }

  async applyStrategy(id) {
    if (this.select) throw svcError('BUSY', 'Идёт подбор');
    const args = ['apply', id];
    if (this.settings.perNetwork && this.network) args.push('--network', this.network.id);
    await this.exclusive(async () => {
      await this.helper(args);
      this.status = await this.readStatus();
      if (this.status.service !== 'on') await this.helper(['start']);
    });
    this.syncedNetwork = undefined;
    this.lastCheck = null;
    this.checkWhileOn = false;
    this.log(`способ выбран вручную: ${this.strategyName(id)}`);
    await this.backupStrategies();
    await this.refreshNow();
  }

  publicSettings() {
    return Object.fromEntries(Object.keys(DEFAULT_SETTINGS).map((k) => [k, this.settings[k]]));
  }

  async getSettings() {
    return this.publicSettings();
  }

  async saveSettings() {
    await fsp.mkdir(this.configDir, { recursive: true });
    await fsp.writeFile(this.settingsFile, JSON.stringify(this.settings, null, 2));
  }

  // uninstall wipes /var/lib/ytunblock: keep a copy of the selected strategies in the user's settings
  async backupStrategies() {
    const st = this.status && this.status.strategies;
    if (!st) return;
    const pick = (r) => (r && r.id ? { id: r.id, selectedAt: r.selectedAt } : null);
    const networks = {};
    for (const [n, r] of Object.entries(st.networks || {})) if (pick(r)) networks[n] = pick(r);
    this.settings.strategyBackup = { default: pick(st.default), networks };
    await this.saveSettings().catch((e) => this.log(`не удалось сохранить копию стратегий: ${e.message}`));
  }

  // after (re)install, or on start when the helper has none: re-apply catalog strategies from the copy.
  // bc2-* (deep) ones lived in /var/lib/ytunblock/custom and the helper takes no raw args: skipped.
  restoreStrategies() {
    if (!this.restoring) this.restoring = this.doRestoreStrategies().finally(() => { this.restoring = null; });
    return this.restoring;
  }

  async doRestoreStrategies() {
    const b = this.settings.strategyBackup;
    const st = (this.status && this.status.strategies) || {};
    if (!b || !this.installed() || this.select) return false;
    if (st.default || Object.keys(st.networks || {}).length) return false;
    const known = new Set(this.loadCatalog().map((x) => x.id));
    const items = [];
    const idOf = (r) => (r && typeof r === 'object' && typeof r.id === 'string' ? r.id : null);
    if (typeof b !== 'object') return false;
    if (idOf(b.default)) items.push([null, idOf(b.default)]);
    const nets = b.networks && typeof b.networks === 'object' ? b.networks : {};
    for (const [n, r] of Object.entries(nets)) if (idOf(r)) items.push([n, idOf(r)]);
    let restored = 0;
    for (const [net, id] of items) {
      if (!known.has(id)) {
        this.log(`способ ${id} не восстановлен: его нет в каталоге (найден глубоким подбором)`);
        continue;
      }
      try {
        await this.exclusive(() => this.helper(net ? ['apply', id, '--network', net] : ['apply', id]));
        restored++;
      } catch (e) {
        this.log(`способ ${id} не восстановлен: ${e.message}`);
      }
    }
    if (!restored) return false;
    this.log(`восстановлено способов из копии: ${restored}`);
    this.syncedNetwork = undefined;
    this.status = await this.readStatus();
    await this.syncNetwork().catch(() => {});
    if (this.networkStrategy() && this.status.service !== 'on') {
      await this.exclusive(() => this.helper(['start']))
        .then(() => this.log('служба запущена'))
        .catch((e) => this.log(`служба не запустилась: ${e.message}`));
    }
    await this.refreshNow().catch(() => {});
    return true;
  }

  async setSettings(patch) {
    const prev = { ...this.settings };
    for (const k of Object.keys(DEFAULT_SETTINGS)) {
      if (typeof patch[k] === 'boolean') this.settings[k] = patch[k];
    }
    await this.saveSettings();
    const inst = this.installed();
    if (inst && prev.blockQuic !== this.settings.blockQuic) {
      this.quicSyncFailed = undefined;
      await this.syncQuic();
    }
    if (inst && prev.perNetwork !== this.settings.perNetwork) {
      this.syncedNetwork = undefined;
      // the setting is saved either way; a BUSY helper gets it on a later poll
      await this.syncNetwork().catch((e) => this.log(`не удалось переключить режим сетей: ${e.message}`));
    }
    if (prev.autostart !== this.settings.autostart) await this.applyAutostart();
    this.emitState();
    return this.publicSettings();
  }

  autostartFile() {
    return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'autostart', 'ytunblock.desktop');
  }

  // autostart = tray app at login (the root service itself persists via `systemctl enable` on start/stop)
  async applyAutostart() {
    const file = this.autostartFile();
    const exe = process.env.APPIMAGE;
    if (!this.settings.autostart || !exe) {
      await fsp.rm(file, { force: true });
      return;
    }
    const q = exe.replace(/(["`$\\])/g, '\\$1');
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, [
      '[Desktop Entry]',
      'Type=Application',
      'Name=YouTube без блокировок',
      `Exec="${q}" --hidden`,
      'X-GNOME-Autostart-enabled=true',
      'Terminal=false',
      '',
    ].join('\n'));
  }

  async getLog(lines = 200) {
    const parts = [];
    const helperLog = await fsp.readFile(path.join(LOG_DIR, 'helper.log'), 'utf8').catch(() => '');
    if (helperLog) parts.push('# helper', ...helperLog.trimEnd().split('\n').slice(-lines));
    const journal = await execFileP('journalctl', ['-u', 'ytunblock', '-n', String(lines), '--no-pager', '-o', 'short-iso'])
      .catch(() => '');
    if (journal.trim()) parts.push('# service', ...journal.trimEnd().split('\n'));
    parts.push('# app', ...this.logLines.slice(-lines));
    return parts.join('\n');
  }

  async getReport() {
    const s = this.buildState();
    const st = this.status || {};
    const osRel = await fsp.readFile('/etc/os-release', 'utf8').catch(() => '');
    const distro = (/^PRETTY_NAME="?([^"\n]*)/m.exec(osRel) || [])[1] || '-';
    const summaries = [];
    for (const m of ['quick', 'deep']) {
      const t = await fsp.readFile(path.join(LOG_DIR, `select-${m}.log`), 'utf8').catch(() => '');
      const sums = t.split('\n').filter((l) => /^curl_test_\S+ ipv\d \S+ : /.test(l) || /^===== /.test(l));
      if (sums.length) summaries.push(`## select ${m}`, ...sums.slice(-60));
    }
    return [
      'ytunblock report',
      `app: ${this.app ? this.app.getVersion() : '-'}, engine: ${st.version || '-'}`,
      `os: ${distro}, kernel ${os.release()}, ${process.arch}`,
      `installed: ${s.installed}, service: ${s.service} (helper: ${st.service || '-'})`,
      `network: ${s.network ? `${s.network.kind} "${s.network.label}"` : '-'}`,
      `strategy: ${s.strategy ? `${s.strategy.id} (${s.strategy.selectedAt})` : '-'}`,
      `quic block: ${st.quic}, settings: ${JSON.stringify(this.settings)}`,
      `requirements: ${s.requirements.ok ? 'ok' : 'FAIL'} ${(s.requirements.missing || []).join(',')}`,
      `last check: ${s.lastCheck ? `${s.lastCheck.verdict} ${s.lastCheck.hosts.map((h) => `${h.key}=${h.ok ? h.ms + 'ms' : 'fail'}`).join(' ')}` : '-'}`,
      '',
      ...summaries,
      '',
      await this.getLog(80),
    ].join('\n');
  }
}

// "sha256  relative/path" lines for system/ and strategies/ (the same files install() copies)
async function makeManifest(root) {
  const lines = [];
  const walk = async (rel) => {
    for (const e of await fsp.readdir(path.join(root, rel), { withFileTypes: true })) {
      const r = path.posix.join(rel, e.name);
      if (e.isDirectory()) {
        if (e.name !== 'test') await walk(r);
      } else if (e.isFile()) {
        const h = crypto.createHash('sha256').update(await fsp.readFile(path.join(root, r))).digest('hex');
        lines.push(`${h}  ${r}`);
      } else {
        throw svcError('HELPER_FAILED', `unexpected file type in payload: ${r}`);
      }
    }
  };
  await walk('system');
  await walk('strategies');
  return lines.join('\n');
}

async function chmodTree(dir) {
  for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      await fsp.chmod(p, 0o755);
      await chmodTree(p);
    } else if (e.isFile()) {
      await fsp.chmod(p, 0o644);
    }
  }
}

function create(opts) {
  return new RealService(opts);
}

module.exports = { create, RealService, detectNetwork, checkHost, makeManifest, INSTALL_BOOTSTRAP };
