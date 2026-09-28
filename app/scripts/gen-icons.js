'use strict';

// Renders tray icons and the app icon from the Phosphor glyphs used in the mockup.
// Run: npm run icons (writes assets/tray/*.png, assets/icon.png, build/icon.png).

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow } = require('electron');

const ROOT = path.join(__dirname, '..');
const ACCENT = '#9184d9';
const NEUTRAL = '#9397ab';
const WARN = '#e3a667';

function trayHtml(kind, s, pct = 0) {
  const u = s / 22;
  if (kind === 'on') return `<div class="box" style="width:${s}px;height:${s}px;color:${ACCENT};font-size:${s}px"><i class="ph-fill ph-play-circle"></i></div>`;
  if (kind === 'off') return `<div class="box" style="width:${s}px;height:${s}px;color:${NEUTRAL};font-size:${s}px"><i class="ph ph-play-circle"></i></div>`;
  if (kind === 'error') {
    return `<div class="box" style="width:${s}px;height:${s}px;color:${NEUTRAL};font-size:${s}px"><i class="ph ph-play-circle"></i>
      <span style="position:absolute;right:0;bottom:0;width:${9 * u}px;height:${9 * u}px;border-radius:50%;background:${WARN}"></span></div>`;
  }
  const r = 20 * u;
  const mask = `radial-gradient(farthest-side,transparent calc(100% - ${2 * u}px),#000 calc(100% - ${1.5 * u}px))`;
  return `<div class="box" style="width:${s}px;height:${s}px">
    <span style="width:${r}px;height:${r}px;border-radius:50%;position:relative;display:grid;place-items:center;color:${ACCENT};font-size:${9 * u}px;box-shadow:inset 0 0 0 ${1.5 * u}px color-mix(in srgb, ${NEUTRAL} 55%, transparent)">
      <span style="position:absolute;inset:0;border-radius:50%;background:conic-gradient(${ACCENT} 0 ${pct}%,transparent 0);-webkit-mask:${mask};mask:${mask}"></span>
      <i class="ph-fill ph-play"></i>
    </span></div>`;
}

function appIconHtml(s) {
  const u = s / 128;
  return `<div class="box" style="width:${s}px;height:${s}px;border-radius:${30 * u}px;background:linear-gradient(160deg,#2d3042,#161826);box-shadow:inset 0 0 0 ${1.5 * u}px #796cbf;color:#b5abfc;font-size:${60 * u}px">
    <i class="ph-fill ph-play" style="filter:drop-shadow(0 0 ${12 * u}px #9184d9)"></i></div>`;
}

async function shot(win, html, size, out) {
  await win.webContents.executeJavaScript(`document.getElementById('stage').innerHTML = ${JSON.stringify(html)}; document.fonts.ready.then(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))`);
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: size, height: size });
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, img.resize({ width: size, height: size }).toPNG());
  console.log(path.relative(ROOT, out));
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 600, height: 600, show: false, transparent: true, frame: false,
    webPreferences: { offscreen: true, sandbox: true, contextIsolation: true },
  });
  win.webContents.setFrameRate(1);
  await win.loadFile(path.join(__dirname, 'icon-canvas.html'));
  const tray = path.join(ROOT, 'assets', 'tray');
  for (const [s, suffix] of [[22, ''], [44, '@2x']]) {
    for (const kind of ['on', 'off', 'error']) await shot(win, trayHtml(kind, s), s, path.join(tray, `${kind}${suffix}.png`));
    for (let i = 0; i <= 10; i++) await shot(win, trayHtml('selecting', s, i * 10), s, path.join(tray, `selecting-${i}${suffix}.png`));
  }
  await shot(win, appIconHtml(256), 256, path.join(ROOT, 'assets', 'icon.png'));
  await shot(win, appIconHtml(512), 512, path.join(ROOT, 'build', 'icon.png'));
  app.quit();
});
