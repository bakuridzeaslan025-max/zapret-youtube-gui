'use strict';

// Drives the app in mock mode through every screen and saves screenshots in both themes.
// Run: npm run screenshots [-- <id-filter>]   → ../docs/screenshots/<id>-<theme>.png
// Headless (offscreen, no windows/tray/Dock) by default; YTU_HEADLESS=0 shows the windows.

const path = require('path');
const fs = require('fs');
const { _electron: electron } = require('playwright-core');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, '..', 'docs', 'screenshots');

const click = (action) => async (page) => page.click(`[data-action="${action}"]`);
const waitText = (text) => async (page) => page.getByText(text, { exact: false }).first().waitFor({ timeout: 20000 });

const SHOTS = [
  { id: '1a-welcome', scenario: 'fresh', steps: [] },
  { id: '1c-installing', scenario: 'fresh', speed: 0.5, steps: [click('install'), async (p) => p.locator('.step .ph-check-circle').nth(1).waitFor()] },
  { id: '1d-auth-cancelled', scenario: 'auth-cancel', speed: 4, steps: [click('install'), waitText('Установка не началась')] },
  { id: '1e-missing', scenario: 'missing', speed: 4, steps: [click('install'), waitText('не хватает компонента')] },
  { id: '1f-firewall', scenario: 'firewall', speed: 4, steps: [click('install'), waitText('Мешает файрвол')] },
  { id: '2a-checking', scenario: 'on', speed: 0.2, steps: [click('check'), waitText('Проверяем, есть ли')] },
  { id: '2b-unblocked', scenario: 'unblocked', speed: 4, steps: [click('install'), waitText('работает без блокировок')] },
  { id: '2c-dpi', scenario: 'fresh', speed: 4, steps: [click('install'), waitText('Провайдер блокирует')] },
  { id: '2d-path', scenario: 'path', speed: 4, steps: [click('install'), waitText('Проблема не в блокировке')] },
  { id: '3a-quick', scenario: 'selecting-on-start', speed: 0.01, steps: [waitText('Проверяем способ 5')] },
  { id: '3b-found', scenario: 'on', speed: 20, steps: [click('select-quick'), waitText('YouTube работает')] },
  { id: '3c-quick-fail', scenario: 'deep', speed: 20, steps: [click('recheck-select'), waitText('Быстрый подбор не помог')] },
  { id: '4a-deep-confirm', scenario: 'deep', speed: 20, steps: [click('recheck-select'), waitText('Быстрый подбор не помог'), click('deep-confirm')] },
  { id: '4b-deep', scenario: 'deep-running', speed: 0.01, steps: [waitText('Осталось примерно')] },
  { id: '4c-deep-fail', scenario: 'deep-fail', speed: 50, steps: [click('recheck-select'), waitText('Быстрый подбор не помог'), click('deep-confirm'), click('select-deep'), waitText('Не удалось подобрать способ')] },
  { id: '5a-on', scenario: 'on', steps: [] },
  { id: '5b-off', scenario: 'off', steps: [] },
  { id: '5c-broken', scenario: 'broken', steps: [] },
  { id: '5e-new-network', scenario: 'new-network', steps: [waitText('Новая сеть')] },
  { id: '6a-settings', scenario: 'on', steps: [click('settings'), waitText('Запускать при старте')] },
  {
    id: '6b-advanced', scenario: 'on', steps: [click('settings'), click('advanced'), waitText('Журнал событий'),
      async (p) => p.evaluate(() => { const s = document.getElementById('scroll'); s.scrollTop = document.querySelector('.adv').offsetTop - 60; })],
  },
  { id: '8a-limits', scenario: 'on', steps: [click('settings'), click('limits'), waitText('Что приложение не умеет')] },
  { id: 'x-close-warn', scenario: 'selecting-on-start', speed: 0.01, env: { YTU_TRAY: '0' }, steps: [waitText('Проверяем способ 5'), click('close'), waitText('Подбор продолжится')] },
  { id: 'x-error', scenario: 'helper-fail', speed: 4, steps: [click('recheck-select'), waitText('Что-то пошло не так')] },
];

async function run(shot, theme) {
  const app = await electron.launch({
    executablePath: require('electron'),
    args: [ROOT],
    env: { ...process.env, YTU_HEADLESS: process.env.YTU_HEADLESS || '1', ...shot.env, YTU_SERVICE: 'mock', YTU_MOCK_SCENARIO: shot.scenario, YTU_MOCK_SPEED: String(shot.speed || 1) },
  });
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ nativeTheme }, t) => { nativeTheme.themeSource = t; }, theme);
    // Playwright emulates prefers-color-scheme: light by default, overriding nativeTheme
    await page.emulateMedia({ colorScheme: theme });
    await page.waitForSelector('#app[data-screen]');
    await page.evaluate(() => document.fonts.ready);
    for (const step of shot.steps) await step(page);
    await page.waitForTimeout(400);
    const file = path.join(OUT, `${shot.id}-${theme}.png`);
    await page.screenshot({ path: file, animations: 'disabled' });
    console.log(path.relative(path.join(ROOT, '..'), file));
  } finally {
    await app.close();
  }
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const filter = process.argv[2];
  for (const shot of SHOTS.filter((s) => !filter || s.id.startsWith(filter))) {
    for (const theme of ['dark', 'light']) {
      try {
        await run(shot, theme);
      } catch (e) {
        console.error(`FAILED ${shot.id}-${theme}: ${e.message.split('\n')[0]}`);
        process.exitCode = 1;
      }
    }
  }
})();
