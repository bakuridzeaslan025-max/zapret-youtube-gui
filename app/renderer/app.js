import T from './i18n/ru.js';

const HELP_URL = 'https://github.com/ytunblock/ytunblock#readme';
const HOST_KEYS = ['site', 'api', 'thumbs', 'video'];
const NET_ICONS = { wifi: 'ph-wifi-high', mobile: 'ph-cell-signal-high', ethernet: 'ph-network', other: 'ph-globe-simple' };
const ONBOARDING = new Set(['welcome', 'installing', 'err-auth', 'err-missing', 'err-firewall', 'error']);

const S = {
  state: null,
  settings: null,
  screen: 'main',
  progress: null,
  selectMode: null,
  selectStartedAt: null,
  lastSelectTotal: 0,
  installStep: null,
  error: null,
  retry: null,
  strategies: null,
  log: '',
  busy: null,
  toast: null,
  hasTray: true,
  prevScreen: null,
};

const app = document.getElementById('app');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const icon = (name, extra = '') => `<i class="ph ${name}${extra ? ' ' + extra : ''}"></i>`;
const fillIcon = (name, extra = '') => `<i class="ph-fill ${name}${extra ? ' ' + extra : ''}"></i>`;

// ---------- formatting ----------

function fmtDate(iso) {
  return new Intl.DateTimeFormat(T.locale, { day: 'numeric', month: 'long' }).format(new Date(iso));
}

function fmtAgo(iso) {
  const min = Math.floor((Date.now() - new Date(iso).getTime()) / 60e3);
  if (min < 1) return T.justNow;
  if (min < 60) return T.minAgo(min);
  if (min < 24 * 60) return T.hoursAgo(Math.floor(min / 60));
  return fmtDate(iso);
}

function fmtDuration(sec) {
  if (sec < 60) return T.lessThanMinute;
  const total = Math.round(sec / 60);
  return T.duration(Math.floor(total / 60), total % 60);
}

function fmtQuickEta(sec) {
  if (sec == null) return '';
  if (sec < 60) return T.etaLeft(T.lessThanMinute);
  return T.etaLeft(T.aboutMinutes(Math.ceil(sec / 60)));
}

// ---------- building blocks ----------

function titlebar({ back = false, gear = false, title = T.appTitle } = {}) {
  return `<div class="tb${back ? ' with-back' : ''}">
    ${back ? `<button class="btn btn-icon" data-action="back" title="${esc(T.back)}">${icon('ph-caret-left')}</button>` : ''}
    <div class="tb-title">${esc(title)}</div>
    ${gear ? `<button class="btn btn-icon" data-action="settings" title="${esc(T.settings)}">${icon('ph-gear-six')}</button>` : ''}
    <button class="btn btn-icon" data-action="minimize" title="${esc(T.minimize)}">${icon('ph-minus')}</button>
    <button class="btn btn-icon" data-action="close" title="${esc(T.closeWindow)}">${icon('ph-x')}</button>
  </div>`;
}

const btn = (action, label, cls = 'btn-primary btn-lg', ico = '', disabled = false) =>
  `<button class="btn ${cls}" data-action="${action}"${disabled ? ' disabled' : ''}>${ico ? icon(ico) : ''}${esc(label)}</button>`;

const badge = (ico, cls = '') => `<div class="badge ${cls}">${icon(ico)}</div>`;
const ringBadge = (ico, pct, cls = '', ringCls = '') =>
  `<div class="badge busy ${cls}"><div class="ring ${ringCls}" data-pct="${pct}"></div>${icon(ico)}</div>`;
const warnNote = (text) => `<div class="note-warn">${icon('ph-warning')}<span>${esc(text)}</span></div>`;
const bar = (pct) => pct == null
  ? '<div class="bar indeterminate"><div></div></div>'
  : `<div class="bar"><div data-pct="${pct.toFixed(1)}"></div></div>`;
const toggle = (action, on, { shine = false, disabled = false } = {}) =>
  `<button class="switch${shine ? ' shine' : ''}" role="switch" aria-checked="${on}" data-action="${action}"${disabled ? ' disabled' : ''}></button>`;

function simple({ ico, badgeCls = 'warn', title, lead, extra = '', foot }) {
  return `${titlebar()}
    <div class="center">
      ${ico ? badge(ico, badgeCls) : ''}
      <h3>${esc(title)}</h3>
      ${lead ? `<p class="lead">${esc(lead)}</p>` : ''}
      ${extra}
    </div>
    <div class="foot">${foot}</div>`;
}

// ---------- screens ----------

const screens = {
  welcome: () => `${titlebar()}
    <div class="center gap-18">
      <div class="app-icon glow">${fillIcon('ph-play')}</div>
      <h2 class="h2-welcome">${esc(T.welcomeTitle)}</h2>
      <p class="lead">${esc(T.welcomeLead)}</p>
    </div>
    <div class="foot gap-10">
      ${btn('install', T.install, 'btn-primary btn-lg', 'ph-download-simple')}
      <div class="hint">${icon('ph-lock-simple')}${esc(T.installHint)}</div>
    </div>`,

  installing: () => {
    // installProgress {step, done, total}: map done/total onto the mockup's 4 steps
    const ip = S.installStep;
    const n = T.installSteps.length;
    const step = ip && ip.total > 0 ? Math.min(n, Math.floor((ip.done / ip.total) * n)) : null;
    const steps = T.installSteps.map((label, i) => {
      if (step != null && i < step) return `<div class="step">${fillIcon('ph-check-circle')}${esc(label)}</div>`;
      if (step != null ? i === step : i === 0) return `<div class="step">${icon('ph-circle-notch', 'spin')}${esc(label)}</div>`;
      return `<div class="step pending">${icon('ph-circle')}${esc(label)}</div>`;
    }).join('');
    const pct = step == null ? null : Math.min(100, ((ip.done + (ip.done < ip.total ? 0.5 : 0)) / ip.total) * 100);
    return `${titlebar()}
      <div class="top install">
        <div class="heading"><h3>${esc(T.installingTitle)}</h3><p class="sub">${esc(T.installingSub)}</p></div>
        ${bar(pct)}
        <div class="steps">${steps}</div>
      </div>`;
  },

  'err-auth': () => simple({
    ico: 'ph-lock-simple',
    title: T.authTitle,
    lead: S.error && S.error.code === 'AUTH_FAILED' ? T.authFailedLead : T.authLead,
    foot: btn('install', T.tryAgain),
  }),

  'err-missing': () => {
    const missing = (S.state && S.state.requirements.missing) || [];
    const kmod = missing.length === 0 || missing.includes('nfnetlink_queue');
    return simple({
      ico: 'ph-puzzle-piece',
      title: T.missingTitle,
      lead: kmod ? T.missingKmodLead : T.missingPkgLead(missing.join(', ')),
      extra: `<div class="cmd"><code>${esc(installCommand(missing))}</code><button class="btn btn-icon btn-copy" data-action="copy-cmd" title="${esc(T.copied)}">${icon('ph-copy')}</button></div>
        <a class="ext-link" href="${HELP_URL}" target="_blank">${esc(T.otherDistros)}${icon('ph-arrow-up-right')}</a>`,
      foot: btn('install', T.retry),
    });
  },

  'err-firewall': () => simple({
    ico: 'ph-wall',
    title: T.firewallTitle,
    lead: T.firewallLead(/ufw/i.test((S.error && S.error.message) || '') ? 'ufw' : 'firewalld'),
    foot: btn('install', T.firewallFix) + `<a class="btn btn-secondary btn-lg" href="${HELP_URL}" target="_blank">${esc(T.firewallManual)}</a>`,
  }),

  error: () => simple({
    ico: 'ph-warning-circle',
    title: T.errorTitle,
    lead: S.error ? S.error.message : '',
    extra: S.error ? `<div class="small mono selectable">${esc(S.error.code)}</div>` : '',
    foot: (S.retry ? btn('retry', T.retry) : '') + (S.state ? btn('home', T.close, S.retry ? 'btn-secondary btn-lg' : 'btn-primary btn-lg') : ''),
  }),

  checking: () => `${titlebar()}
    <div class="center">
      ${ringBadge('ph-globe-simple', 30, '', 'spin')}
      <h3>${esc(T.checkingTitle)}</h3>
      <p class="lead">${esc(T.checkingSub)}</p>
    </div>`,

  'check-ok': () => simple({
    ico: 'ph-check', badgeCls: 'accent glow', title: T.okTitle, lead: T.okLead,
    foot: btn('home', T.done) + btn('select-quick', T.selectAnyway, 'btn-secondary btn-lg'),
  }),

  'check-dpi': () => simple({
    ico: 'ph-prohibit', title: T.dpiTitle, lead: T.dpiLead,
    extra: warnNote(T.selectWarn),
    foot: btn('select-quick', T.select, 'btn-primary btn-lg', 'ph-magic-wand'),
  }),

  'check-path': () => simple({
    ico: 'ph-wifi-slash', badgeCls: '', title: T.pathTitle, lead: T.pathLead,
    extra: `<div class="tips">${[['ph-wifi-high', T.pathTips[0]], ['ph-browser', T.pathTips[1]], ['ph-arrow-clockwise', T.pathTips[2]]]
      .map(([i, t]) => `<div class="tip">${icon(i)}<span>${esc(t)}</span></div>`).join('')}</div>`,
    foot: btn('check', T.checkAgain),
  }),

  quick: () => {
    const p = S.progress && S.progress.mode === 'quick' ? S.progress : null;
    let heading = `<h3>${esc(T.quickPreparing)}</h3>`;
    let pct = null;
    if (p) {
      const hostsDone = p.hosts ? p.hosts.filter((h) => h.ok !== null).length : 0;
      pct = p.total ? Math.min(100, ((p.done + hostsDone / 4) / p.total) * 100) : 0;
      const sub = T.quickSub(p.current, fmtQuickEta(p.etaSec));
      heading = `<h3>${esc(T.quickTitle(Math.min(p.done + 1, p.total), p.total))}</h3>${sub ? `<div class="small quick-sub">${esc(sub)}</div>` : ''}`;
    }
    const hosts = (p && p.hosts) || HOST_KEYS.map((key) => ({ key, ok: null }));
    const firstPending = p && p.hosts && !p.hosts.some((h) => h.ok === false) ? p.hosts.findIndex((h) => h.ok === null) : -1;
    const rows = HOST_KEYS.map((key) => {
      const i = hosts.findIndex((h) => h.key === key);
      const h = hosts[i] || { ok: null };
      const label = `<span class="grow">${esc(T.hosts[key])}</span>`;
      if (h.ok === true) return `<div class="host-row">${fillIcon('ph-check-circle')}${label}</div>`;
      if (h.ok === false) return `<div class="host-row failed">${icon('ph-x-circle')}${label}<span class="small">${esc(T.hostFailed)}</span></div>`;
      if (i === firstPending) return `<div class="host-row">${icon('ph-circle-notch', 'spin')}${label}<span class="small">${esc(T.hostChecking)}</span></div>`;
      return `<div class="host-row pending">${icon('ph-circle')}${label}</div>`;
    }).join('');
    return `${titlebar()}
      <div class="top">
        <div class="heading"><div class="kicker">${esc(T.quickKicker)}</div>${heading}</div>
        ${bar(pct)}
        <div class="card hosts">${rows}</div>
        <div class="small">${esc(T.allFourRule)}</div>
      </div>
      <div class="foot gap-12">
        ${warnNote(T.selectWarn)}
        ${btn('cancel-select', S.busy === 'cancel' ? T.cancelling : T.cancel, 'btn-secondary btn-lg', '', S.busy === 'cancel')}
      </div>`;
  },

  found: () => {
    const net = S.state && S.state.network ? S.state.network.label : '';
    return `${titlebar()}
      <div class="center">
        ${badge('ph-check', 'accent xl')}
        <h2>${esc(T.foundTitle)}</h2>
        <p class="lead">${esc(T.foundLead(net))}</p>
        <div class="chips">${HOST_KEYS.map((k) => `<span class="chip"><i class="ph-bold ph-check"></i>${esc(T.hosts[k])}</span>`).join('')}</div>
      </div>
      <div class="foot">${btn('home', T.done)}</div>`;
  },

  'quick-fail': () => simple({
    ico: 'ph-magnifying-glass', badgeCls: '', title: T.quickFailTitle, lead: T.quickFailLead(S.lastSelectTotal || 18),
    foot: btn('deep-confirm', T.startDeep) + btn('home', T.notNow, 'btn-secondary btn-lg'),
  }),

  'deep-confirm': () => simple({
    ico: 'ph-hourglass-medium', badgeCls: 'accent', title: T.deepConfirmTitle,
    extra: `<div class="tips gap-12">${T.deepConfirmTips.map(([i, t]) => (i === 'ph-tray-arrow-down' && !S.hasTray ? [i, T.deepTipNoTray] : [i, t])).map(([i, t]) =>
      `<div class="tip">${icon(i, i === 'ph-warning' ? 'warn' : '')}<span>${esc(t)}</span></div>`).join('')}</div>`,
    foot: btn('select-deep', T.deepStart) + btn('home', T.deepCancelConfirm, 'btn-secondary btn-lg'),
  }),

  deep: () => {
    const p = S.progress && S.progress.mode === 'deep' ? S.progress : null;
    const pct = p && p.total ? (p.done / p.total) * 100 : null;
    const started = p && p.startedAt ? new Date(p.startedAt).getTime() : S.selectStartedAt;
    const elapsed = started ? (Date.now() - started) / 1000 : null;
    return `${titlebar()}
      <div class="top deep">
        <div class="heading"><div class="kicker">${esc(T.deepKicker)}</div>
          <h3>${esc(p && p.etaSec != null ? T.deepEta(fmtDuration(p.etaSec)) : T.deepEtaUnknown)}</h3></div>
        <div class="bar-block">
          ${bar(pct)}
          <div class="bar-legend"><span>${pct == null ? '' : Math.floor(pct) + '%'}</span><span>${elapsed == null ? '' : esc(T.deepElapsed(fmtDuration(elapsed)))}</span></div>
        </div>
        <div class="card stats">
          <div class="stat"><div class="num">${p ? T.num(p.done) : '—'}</div><div class="small">${esc(T.deepChecked)}</div></div>
          <div class="stat"><div class="num">${p && p.total ? '~' + T.num(p.total) : '—'}</div><div class="small">${esc(T.deepTotal)}</div></div>
        </div>
        ${warnNote(T.deepWarn)}
      </div>
      <div class="foot">
        ${S.hasTray ? btn('to-tray', T.toTray, 'btn-primary btn-lg', 'ph-tray-arrow-down') : btn('minimize', T.minimizeWindow, 'btn-primary btn-lg', 'ph-minus')}
        ${btn('cancel-select', S.busy === 'cancel' ? T.cancelling : T.cancel, 'btn-secondary btn-lg', '', S.busy === 'cancel')}
      </div>`;
  },

  'deep-fail': () => {
    const option = (action, ico, title, sub, ext = false) =>
      `<button class="btn btn-secondary btn-option" data-action="${action}">${icon(ico)}<span class="opt-text"><span>${esc(title)}</span><span class="opt-sub">${esc(sub)}</span></span>${ext ? icon('ph-arrow-up-right') : ''}</button>`;
    return simple({
      title: T.deepFailTitle, lead: T.deepFailLead(S.lastSelectTotal || 0),
      extra: `<div class="options">
        ${option('remind', 'ph-clock-clockwise', T.remind, T.remindSub)}
        ${option('send-report', 'ph-paper-plane-tilt', T.sendReport, T.sendReportSub)}
        ${option('help', 'ph-lifebuoy', T.help, T.helpSub, true)}
      </div>`,
      foot: btn('home', T.close),
    });
  },

  'close-warn': () => simple({
    ico: 'ph-hourglass-medium', badgeCls: 'accent', title: T.closeWarnTitle, lead: T.closeWarnLead,
    foot: btn('force-close', T.closeAnyway) + btn('cancel-close', T.keepOpen, 'btn-secondary btn-lg'),
  }),

  main: () => {
    const st = S.state;
    const svc = st.service;
    const net = st.network;
    const noStrategy = !st.strategy;
    const selecting = svc === 'selecting';
    const on = svc === 'on' || svc === 'broken';
    let center;
    if (svc === 'on') {
      center = `<div class="center main glow">${badge('ph-check', 'lg accent glow')}<h1>${esc(T.statusOn)}</h1><p class="lead">${esc(T.statusOnLead)}</p></div>`;
    } else if (svc === 'broken') {
      center = `<div class="center main">${badge('ph-warning', 'lg warn')}<h1>${esc(T.statusBroken)}</h1><p class="lead">${esc(T.statusBrokenLead)}</p>
        ${btn('recheck-select', T.recheckAndSelect, 'btn-primary btn-inline', 'ph-magic-wand')}</div>`;
    } else if (selecting) {
      const p = S.progress;
      let sub = T.selectingUnknown;
      let pct = 28;
      if (p && p.total) {
        pct = (p.done / p.total) * 100;
        sub = p.mode === 'quick'
          ? T.selectingQuick(Math.min(p.done + 1, p.total), p.total, p.etaSec != null ? (p.etaSec < 60 ? T.lessThanMinute : T.aboutMinutes(Math.ceil(p.etaSec / 60))) : '')
          : T.selectingDeep(Math.floor(pct), p.etaSec != null ? T.etaLeft(fmtDuration(p.etaSec)) : '');
      }
      center = `<div class="center main">${ringBadge('ph-magic-wand', pct.toFixed(1), 'lg', 'shine')}<h1>${esc(T.statusSelecting)}</h1><p class="lead">${esc(sub)}</p>
        ${btn('show-progress', T.showProgress, 'btn-primary btn-inline')}</div>`;
    } else {
      center = `<div class="center main">${badge('ph-pause', 'lg')}<h1>${esc(T.statusOff)}</h1><p class="lead">${esc(noStrategy ? T.statusOffNoStrategy : T.statusOffLead)}</p></div>`;
    }

    let netSub;
    if (selecting) netSub = T.selectingNet;
    else if (noStrategy) netSub = T.noStrategy;
    else {
      netSub = T.strategyPicked(fmtDate(st.strategy.selectedAt));
      if (svc === 'broken' && st.lastCheck) netSub += ' · ' + T.checkedAgo(fmtAgo(st.lastCheck.at));
    }
    const netIcon = NET_ICONS[net ? net.kind : 'other'] || NET_ICONS.other;
    const protection = selecting
      ? `<div class="card-row dim"><span class="stack tight"><span class="t strong">${esc(T.protection)}</span><span class="s">${esc(T.protectionPaused)}</span></span>${toggle('toggle', false, { disabled: true })}</div>`
      : `<div class="card-row"><span class="label strong">${esc(T.protection)}</span>${toggle('toggle', on, { shine: true, disabled: S.busy === 'toggle' })}</div>`;
    const banner = noStrategy && net && !selecting
      ? `<div class="banner">${icon(netIcon)}<span class="stack"><span class="t">${esc(T.newNetTitle)}</span><span class="s">${esc(T.newNetSub(net.label))}</span></span>${btn('select-quick', T.selectShort, 'btn-primary')}</div>`
      : '';
    const actions = svc === 'broken' || selecting ? '' : `<div class="row-btns">
        ${btn('check', T.checkNow, 'btn-secondary btn-md', 'ph-arrows-clockwise')}
        ${btn('select-quick', noStrategy ? T.selectShort : T.reselect, 'btn-secondary btn-md', 'ph-magic-wand')}
      </div>`;
    return `${titlebar({ gear: true })}${banner}${center}
      <div class="main-foot">
        <div class="card">
          ${protection}
          <div class="sep"></div>
          <div class="card-row net">${icon(netIcon)}<span class="stack tight"><span class="t">${esc(net ? net.label : T.unknownNetwork)}</span><span class="s">${esc(netSub)}</span></span></div>
        </div>
        ${actions}
      </div>`;
  },

  settings: () => {
    const set = S.settings || {};
    const st = S.state;
    const row = (key, title, sub) => `<div class="card-row set"><span class="stack"><span class="t">${esc(title)}</span>${sub ? `<span class="s">${esc(sub)}</span>` : ''}</span>${toggle('set:' + key, !!set[key])}</div>`;
    let adv = '';
    if (set.advanced) {
      const current = st.strategy ? st.strategy.id : '';
      const list = S.strategies || [];
      const options = (current ? '' : `<option value="" selected>${esc(T.strategyNone)}</option>`) + list.map((s) => {
        const notes = [s.id === current && T.strategyCurrent, s.exact === false && T.strategyApprox].filter(Boolean).join(', ');
        return `<option value="${esc(s.id)}"${s.id === current ? ' selected' : ''}>${esc(s.name)}${notes ? ' — ' + esc(notes) : ''}</option>`;
      }).join('');
      const cur = list.find((s) => s.id === current);
      adv = `<div class="adv">
        <div class="field"><label for="strategy">${esc(T.strategyFor(st.network && st.network.label))}</label>
          <div class="select-wrap"><select id="strategy" class="input" data-change="apply-strategy"${st.service === 'selecting' ? ' disabled' : ''}>${options}</select>${icon('ph-caret-up-down')}</div></div>
        ${cur && cur.args ? `<div class="field"><label>${esc(T.params)}</label><div class="sunk">${esc(cur.args)}</div></div>` : ''}
        <div class="field"><label>${esc(T.log)}</label><div class="sunk log" id="log">${esc(S.log || T.logEmpty)}</div></div>
        ${btn('copy-report', T.copyReport, 'btn-secondary btn-md', 'ph-copy')}
      </div>`;
    }
    return `${titlebar({ back: true, title: T.settings })}
      <div class="scroll" id="scroll"><div class="settings">
        <div class="card">
          ${row('autostart', T.autostart)}
          <div class="sep"></div>
          ${row('blockQuic', T.blockQuic, T.blockQuicSub)}
          <div class="sep"></div>
          ${row('perNetwork', T.perNetwork, T.perNetworkSub)}
        </div>
        <div class="card">
          <div class="card-row set link" data-action="limits">${icon('ph-info')}<span class="label">${esc(T.limitsLink)}</span>${icon('ph-caret-right', 'chev')}</div>
          <div class="sep"></div>
          <div class="card-row set link" data-action="advanced">${icon('ph-sliders-horizontal')}<span class="label">${esc(T.advanced)}</span>${icon(set.advanced ? 'ph-caret-up' : 'ph-caret-down', 'chev')}</div>
        </div>
        ${adv}
        <div class="spacer"></div>
        <div class="danger-zone">
          ${btn('uninstall', S.busy === 'uninstall' ? T.uninstalling : T.uninstall, 'btn-danger', 'ph-trash', S.busy === 'uninstall' || st.service === 'selecting')}
          <div class="small">${esc(T.uninstallHint)}</div>
        </div>
      </div></div>`;
  },

  limits: () => `${titlebar({ back: true, title: T.limits })}
    <div class="limits">
      <h3>${esc(T.limitsTitle)}</h3>
      ${T.limitItems.map(([i, t, s]) => `<div class="limit">${icon(i)}<div class="stack"><div class="t">${esc(t)}</div><div class="s">${esc(s)}</div></div></div>`).join('')}
      <div class="spacer"></div>
      <a class="ext-link big" href="${HELP_URL}" target="_blank">${esc(T.fullHelp)}${icon('ph-arrow-up-right')}</a>
    </div>`,
};

function installCommand(missing) {
  const pkgs = {
    nfnetlink_queue: 'linux-modules-extra-$(uname -r)',
    nft: 'nftables',
    hexdump: 'bsdextrautils',
    nslookup: 'bind9-dnsutils',
  };
  const list = missing.map((m) => pkgs[m]).filter(Boolean);
  return `sudo apt install ${(list.length ? list : [pkgs.nfnetlink_queue]).join(' ')}`;
}

// ---------- rendering ----------

const STATELESS = new Set(['welcome', 'error']);

function render() {
  if (!S.state && !STATELESS.has(S.screen)) return;
  const scroll = document.getElementById('scroll');
  const scrollTop = scroll ? scroll.scrollTop : 0;
  const prevScreen = app.dataset.screen;
  app.innerHTML = screens[S.screen]() + (S.toast ? `<div class="toast">${esc(S.toast)}</div>` : '');
  app.dataset.screen = S.screen;
  // CSP forbids inline style attributes; dynamic values go through CSSOM
  for (const el of app.querySelectorAll('[data-pct]')) el.style.setProperty('--pct', el.dataset.pct);
  const newScroll = document.getElementById('scroll');
  if (newScroll && prevScreen === S.screen) newScroll.scrollTop = scrollTop;
  const log = document.getElementById('log');
  if (log) log.scrollTop = log.scrollHeight;
}

function go(screen) {
  S.screen = screen;
  render();
}

function home() {
  go(S.state && S.state.installed ? 'main' : 'welcome');
}

let toastTimer = null;
function toast(text) {
  S.toast = text;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { S.toast = null; render(); }, 2600);
  render();
}

function showError(e, retry) {
  S.error = { code: (e && e.code) || 'HELPER_FAILED', message: (e && e.message) || String(e) };
  S.retry = retry || null;
  go('error');
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    console.error('clipboard', e);
    return false;
  }
}

// ---------- flows ----------

async function doInstall() {
  S.installStep = null;
  S.error = null;
  go('installing');
  try {
    await window.api.install();
  } catch (e) {
    S.error = e;
    S.state = await window.api.getState();
    const screen = { AUTH_CANCELLED: 'err-auth', AUTH_FAILED: 'err-auth', MISSING_REQUIREMENTS: 'err-missing', FIREWALL_CONFLICT: 'err-firewall' }[e.code];
    if (screen) return go(screen);
    return showError(e, doInstall);
  }
  S.state = await window.api.getState();
  runCheck('onboarding');
}

async function runCheck(origin) {
  go('checking');
  let res;
  try {
    res = await window.api.checkNow();
    S.state = await window.api.getState();
  } catch (e) {
    return showError(e, () => runCheck(origin));
  }
  const svc = S.state.service;
  if (origin === 'main' && (svc === 'on' || svc === 'broken')) {
    go('main');
    return toast(res.verdict === 'unblocked' ? T.checkPassed : T.checkFailed);
  }
  go({ unblocked: 'check-ok', dpi: 'check-dpi', path: 'check-path' }[res.verdict] || 'check-dpi');
}

async function recheckAndSelect() {
  go('checking');
  let res;
  try {
    res = await window.api.checkNow();
    S.state = await window.api.getState();
  } catch (e) {
    return showError(e, recheckAndSelect);
  }
  if (res.verdict === 'unblocked') return go('check-ok');
  if (res.verdict === 'path') return go('check-path');
  startSelect('quick');
}

async function startSelect(mode) {
  S.progress = null;
  S.selectMode = mode;
  S.selectStartedAt = Date.now();
  S.busy = null;
  try {
    await window.api.startSelect(mode);
  } catch (e) {
    if (e.code !== 'BUSY') return showError(e, () => startSelect(mode));
  }
  go(mode);
}

async function setSetting(key, value) {
  try {
    S.settings = await window.api.setSettings({ [key]: value });
  } catch (e) {
    return showError(e);
  }
  if (key === 'advanced' && value) await loadAdvanced();
  render();
}

async function loadAdvanced() {
  try {
    const [strategies, log] = await Promise.all([window.api.listStrategies(), window.api.getLog(200)]);
    S.strategies = strategies;
    S.log = log;
  } catch (e) {
    console.error('advanced', e);
  }
}

const actions = {
  minimize: () => window.appWindow.minimize(),
  close: () => window.appWindow.close(),
  'to-tray': () => window.appWindow.hideToTray(),
  'force-close': () => window.appWindow.forceClose(),
  'cancel-close': () => go(S.prevScreen || 'main'),
  back: () => go(S.screen === 'limits' && S.cameFromSettings ? 'settings' : 'main'),
  settings: async () => {
    S.settings = await window.api.getSettings();
    if (S.settings.advanced) await loadAdvanced();
    go('settings');
  },
  limits: () => { S.cameFromSettings = true; go('limits'); },
  advanced: () => setSetting('advanced', !(S.settings && S.settings.advanced)),
  home,
  install: doInstall,
  retry: () => S.retry && S.retry(),
  check: () => runCheck(S.screen === 'main' ? 'main' : 'check'),
  'recheck-select': recheckAndSelect,
  'select-quick': () => startSelect('quick'),
  'select-deep': () => startSelect('deep'),
  'deep-confirm': () => go('deep-confirm'),
  'show-progress': () => go(S.progress ? S.progress.mode : S.selectMode || 'quick'),
  'cancel-select': async () => {
    S.busy = 'cancel';
    render();
    try {
      await window.api.cancelSelect();
    } catch (e) {
      S.busy = null;
      showError(e);
    }
  },
  toggle: async () => {
    const st = S.state;
    const on = st.service === 'on' || st.service === 'broken';
    if (!on && !st.strategy) return runCheck('toggle');
    S.busy = 'toggle';
    render();
    try {
      await window.api.setEnabled(!on);
    } catch (e) {
      S.busy = null;
      return showError(e);
    }
    S.busy = null;
    render();
  },
  'copy-cmd': async () => {
    if (await copy(installCommand((S.state.requirements && S.state.requirements.missing) || []))) toast(T.copied);
  },
  'copy-report': async () => {
    if (await copy(await window.api.getReport())) toast(T.copied);
  },
  'send-report': async () => {
    if (await copy(await window.api.getReport())) toast(T.reportCopied);
  },
  remind: () => {
    setTimeout(() => new Notification(T.appTitle, { body: T.remindNotice }), 24 * 3600e3);
    toast(T.remindToast);
  },
  help: () => window.open(HELP_URL, '_blank'),
  uninstall: async () => {
    S.busy = 'uninstall';
    render();
    try {
      await window.api.uninstall();
    } catch (e) {
      S.busy = null;
      if (e.code === 'AUTH_CANCELLED') return render();
      return showError(e);
    }
    S.busy = null;
    S.state = await window.api.getState();
    go('welcome');
  },
};

app.addEventListener('click', (ev) => {
  const el = ev.target.closest('[data-action]');
  if (!el || el.disabled) return;
  const a = el.dataset.action;
  if (a.startsWith('set:')) return setSetting(a.slice(4), el.getAttribute('aria-checked') !== 'true');
  const fn = actions[a];
  if (fn) Promise.resolve(fn()).catch((e) => showError(e));
});

app.addEventListener('change', async (ev) => {
  if (ev.target.dataset.change !== 'apply-strategy' || !ev.target.value) return;
  try {
    await window.api.applyStrategy(ev.target.value);
    S.state = await window.api.getState();
    S.log = await window.api.getLog(200);
    toast(T.applied);
  } catch (e) {
    showError(e);
  }
});

document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && (S.screen === 'settings' || S.screen === 'limits')) actions.back();
});

// ---------- events from main ----------

const LOST_DONE_GRACE_MS = 15e3;
let lostDoneTimer = null;

window.api.on('state', (st) => {
  const wasSelecting = S.state && S.state.service === 'selecting';
  const prevScreen = S.screen;
  S.state = st;
  if (!st.installed && !ONBOARDING.has(S.screen) && S.screen !== 'settings') S.screen = 'welcome';
  // Selection ended: selectDone normally follows within seconds (the service restarts first, via pkexec).
  // If it never comes (helper killed, event lost) — leave the progress screen after a grace period.
  if (wasSelecting && st.service !== 'selecting' && !lostDoneTimer) {
    lostDoneTimer = setTimeout(() => {
      lostDoneTimer = null;
      if (!['quick', 'deep', 'close-warn'].includes(S.screen)) return;
      S.busy = null;
      S.progress = null;
      go('main');
    }, LOST_DONE_GRACE_MS);
  }
  if (st.service === 'selecting') {
    clearTimeout(lostDoneTimer);
    lostDoneTimer = null;
  }
  if (st.service !== 'selecting' && S.screen === 'main') S.progress = null;
  if (S.screen !== prevScreen || ['main', 'settings'].includes(S.screen)) render();
});

window.api.on('selectProgress', (p) => {
  S.progress = p;
  // opened mid-selection: the replayed event tells whether it is quick or deep
  if ((S.screen === 'quick' || S.screen === 'deep') && S.screen !== p.mode) S.screen = p.mode;
  S.selectMode = p.mode;
  S.lastSelectTotal = p.total;
  if (['quick', 'deep', 'main'].includes(S.screen)) render();
});

window.api.on('selectDone', async (d) => {
  clearTimeout(lostDoneTimer);
  lostDoneTimer = null;
  S.busy = null;
  try {
    S.state = await window.api.getState();
  } catch (e) {
    S.progress = null;
    return showError(e);
  }
  if (S.progress) S.lastSelectTotal = d.found ? S.progress.total : S.progress.done || S.progress.total;
  S.progress = null;
  if (!['quick', 'deep', 'main', 'close-warn'].includes(S.screen)) return render();
  if (d.cancelled) return go('main');
  if (d.found) return go('found');
  go(d.mode === 'quick' ? 'quick-fail' : 'deep-fail');
});

window.appWindow.onConfirmClose(() => {
  if (S.screen !== 'close-warn') S.prevScreen = S.screen;
  go('close-warn');
});

window.api.on('installProgress', (p) => {
  S.installStep = Number.isFinite(p.done) && Number.isFinite(p.total) ? { done: p.done, total: p.total } : null;
  if (S.screen === 'installing') render();
});

setInterval(() => {
  if (S.screen === 'deep' || S.screen === 'main') render();
}, 30e3);

async function init() {
  try {
    S.state = await window.api.getState();
    S.settings = await window.api.getSettings();
    S.hasTray = !!(await window.appWindow.info() || {}).hasTray;
  } catch (e) {
    S.state = null;
    return showError(e, init);
  }
  if (!S.state.installed) S.screen = 'welcome';
  else if (S.state.service === 'selecting') S.screen = S.selectMode || 'quick';
  else S.screen = 'main';
  render();
}

init();
