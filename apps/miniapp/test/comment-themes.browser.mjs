import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, devices } from 'playwright';
import {
  ensureMiniappDevServer,
  stopChildProcess,
} from '../../../scripts/miniapp-local-server.mjs';
import { installMaxBridgeShimInitScript } from '../../../scripts/miniapp-max-bridge-shim.mjs';
import {
  applyNativeVisualMode,
  installNativeVisualModeInitScript,
} from '../../../scripts/miniapp-native-visual-mode.mjs';

const base = process.env.COMMENT_THEMES_BASE_URL || 'http://127.0.0.1:3014/app/';
const output = await mkdtemp(path.join(tmpdir(), 'maxim-comment-themes-'));
const server = await ensureMiniappDevServer(base);
const browser = await chromium.launch();
let activePage;
const themeKey = 'maxim:comments:theme:v1';
const themes = [
  ['atlas', 'Атлас'],
  ['chrome', 'Хром'],
  ['sketch', 'Скетч'],
];
const profiles = [
  { name: 'iphone-se', device: devices['iPhone SE'], platform: 'ios', safeTop: 20, safeBottom: 0 },
  { name: 'android', device: devices['Pixel 7'], platform: 'android', safeTop: 24, safeBottom: 0 },
  { name: 'iphone', device: devices['iPhone 15'], platform: 'ios', safeTop: 59, safeBottom: 34 },
  {
    name: 'desktop',
    device: { viewport: { width: 1280, height: 900 } },
    platform: 'ios',
    safeTop: 0,
    safeBottom: 0,
  },
];

function commentsUrl(profile, extra = {}) {
  const url = new URL('channel/preview-channel/dialog/comments', base);
  url.search = new URLSearchParams({
    preview: '1',
    device: profile.name === 'desktop' ? 'iphone' : profile.name,
    token: 'preview-comments-token-0001',
    ...extra,
  }).toString();
  return url.href;
}

async function assertLayout(page) {
  const errors = await page.evaluate(() => {
    const failures = [];
    const screen = document.querySelector('.channel-dialog-screen');
    const counter = screen.querySelector('.channel-dialog-compose__meta span:last-child');
    if (
      counter &&
      getComputedStyle(counter).color !== getComputedStyle(counter.parentElement).color
    )
      failures.push('counter does not follow the theme');
    if (screen.scrollWidth > screen.clientWidth + 1) failures.push('horizontal overflow');
    const shell = document.querySelector('.channel-dialog-shell').getBoundingClientRect();
    const composer = document.querySelector('.channel-dialog-compose').getBoundingClientRect();
    if (Math.abs(composer.bottom - shell.bottom) > 2) failures.push('composer not pinned');
    for (const selector of [
      '.channel-dialog-theme-toggle',
      '.channel-dialog-comments-header__context',
      '.channel-dialog-compose__surface',
      '.comment-theme-sheet__panel',
    ]) {
      const element = document.querySelector(selector);
      if (!element) continue;
      const rect = element.getBoundingClientRect();
      if (
        rect.left < -1 ||
        rect.right > innerWidth + 1 ||
        rect.top < -1 ||
        rect.bottom > innerHeight + 1
      )
        failures.push(`outside viewport: ${selector}`);
    }
    return failures;
  });
  assert.deepEqual(errors, []);
}

try {
  for (const profile of profiles) {
    for (const mode of ['light', 'dark']) {
      const context = await browser.newContext({
        ...profile.device,
        colorScheme: mode,
        reducedMotion: 'reduce',
        locale: 'ru-RU',
      });
      await context.route('https://st.max.ru/js/max-web-app.js', (route) =>
        route.fulfill({ contentType: 'application/javascript', body: '' }),
      );
      await installMaxBridgeShimInitScript(context, profile, {
        colorScheme: mode,
        userId: 'preview-admin',
      });
      await installNativeVisualModeInitScript(context);
      const page = await context.newPage();
      activePage = page;
      const errors = [];
      const wallpapers = new Set();
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('response', (response) => {
        if (/comments-(atlas|chrome|sketch)-.*webp/u.test(response.url()))
          wallpapers.add(response.url());
      });
      await page.goto(commentsUrl(profile));
      await page.locator('.channel-dialog-message').first().waitFor();
      await applyNativeVisualMode(page, profile);
      await page.waitForFunction(() =>
        getComputedStyle(
          document.querySelector('.channel-dialog-screen__backdrop'),
        ).backgroundImage.includes('atlas'),
      );
      assert.equal(
        await page.locator('[data-comment-theme]').getAttribute('data-comment-theme'),
        'atlas',
      );
      await page.waitForTimeout(200);
      assert.equal(wallpapers.size, 1, 'a cold dialog loads only its active wallpaper');
      const draft = 'Тема меняется, черновик остаётся.';
      await page.locator('.channel-dialog-compose__field textarea').fill(draft);
      for (const [id, label] of themes) {
        await page.getByRole('button', { name: 'Оформление комментариев', exact: true }).click();
        const dialog = page.getByRole('dialog', { name: 'Оформление', exact: true });
        await dialog.waitFor();
        await page.getByRole('radio', { name: label, exact: true }).click();
        assert.equal(
          await page.locator('[data-comment-theme]').getAttribute('data-comment-theme'),
          id,
        );
        assert.equal(await page.evaluate((key) => localStorage.getItem(key), themeKey), id);
        assert.equal(
          await page.locator('.channel-dialog-compose__field textarea').inputValue(),
          draft,
        );
        await assertLayout(page);
        await page.screenshot({
          path: path.join(output, `${profile.name}-${mode}-${id}-sheet.png`),
        });
        await dialog.getByRole('button', { name: 'Готово', exact: true }).click();
        await page.screenshot({ path: path.join(output, `${profile.name}-${mode}-${id}.png`) });
      }
      await page.getByRole('button', { name: 'Отправить', exact: true }).click();
      await page.locator('.channel-dialog-message.is-own').filter({ hasText: draft }).waitFor();
      assert.equal(await page.locator('.channel-dialog-compose__field textarea').inputValue(), '');
      const sentMessage = page.locator('.channel-dialog-message.is-own').filter({ hasText: draft });
      await sentMessage.locator('.channel-dialog-message__bubble').press('Enter');
      const actions = page.getByRole('dialog', { name: 'Действия с комментарием', exact: true });
      await actions.waitFor();
      await actions.getByRole('button', { name: 'Ответить', exact: true }).click();
      await page.locator('.channel-dialog-compose__reply').waitFor();
      await page.getByRole('button', { name: 'Отменить ответ', exact: true }).click();
      await sentMessage.locator('.channel-dialog-message__bubble').press('Enter');
      await actions.waitFor();
      await actions.locator('.channel-dialog-reaction-popover__emoji').first().click();
      await sentMessage.locator('.channel-dialog-reaction-pill.is-active').waitFor();
      await page.getByRole('button', { name: 'Настройки уведомлений', exact: true }).click();
      await page.getByRole('dialog', { name: 'Уведомления', exact: true }).waitFor();
      await page.screenshot({
        path: path.join(output, `${profile.name}-${mode}-notifications.png`),
      });
      await page.getByRole('button', { name: 'Отмена', exact: true }).click();
      await page.reload();
      await page.locator('[data-comment-theme="sketch"]').waitFor();
      await applyNativeVisualMode(page, profile);
      await page.getByRole('button', { name: 'Оформление комментариев', exact: true }).click();
      await page.getByRole('dialog', { name: 'Оформление', exact: true }).waitFor();
      await page.getByRole('radio', { name: 'Скетч', exact: true }).focus();
      await page.keyboard.press('ArrowLeft');
      assert.equal(
        await page.getByRole('radio', { name: 'Хром', exact: true }).getAttribute('aria-checked'),
        'true',
      );
      await page.keyboard.press('Escape');
      assert.equal(await page.getByRole('dialog', { name: 'Оформление', exact: true }).count(), 0);
      await page.getByRole('button', { name: 'Оформление комментариев', exact: true }).click();
      await page.getByRole('dialog', { name: 'Оформление', exact: true }).waitFor();
      await page.evaluate(() => window.__MAXIM_VISUAL_BRIDGE_PRESS_BACK__());
      await page.waitForFunction(() => !document.querySelector('.comment-theme-sheet'));
      assert.equal(
        await page.evaluate(() => Boolean(window.__MAXIM_VISUAL_BRIDGE_CLOSED__)),
        false,
      );
      const viewport = page.viewportSize();
      await page.setViewportSize({
        width: viewport.width,
        height: Math.max(320, viewport.height - 280),
      });
      await page
        .locator('.channel-dialog-compose__field textarea')
        .fill('Комментарий с открытой клавиатурой');
      await page.waitForTimeout(150);
      await assertLayout(page);
      await page.screenshot({ path: path.join(output, `${profile.name}-${mode}-keyboard.png`) });
      await page.setViewportSize(viewport);
      await page.goto(commentsUrl(profile, { profile: 'publisher' }));
      await page.locator('.channel-dialog-message').first().waitFor();
      await applyNativeVisualMode(page, profile);
      assert.equal(
        await page.getByRole('button', { name: 'Оформление комментариев', exact: true }).count(),
        1,
      );
      assert.equal(
        await page.locator('[data-comment-theme]').getAttribute('data-comment-theme'),
        'chrome',
      );
      const suggestUrl = new URL(commentsUrl(profile));
      suggestUrl.pathname = suggestUrl.pathname.replace('/comments', '/suggest');
      await page.evaluate((url) => {
        history.pushState({}, '', url);
        window.dispatchEvent(new PopStateEvent('popstate'));
      }, suggestUrl.href);
      await page.locator('.channel-dialog-screen--suggest').waitFor();
      assert.equal(await page.locator('[data-comment-theme]').count(), 0);
      assert.equal(await page.locator('.channel-dialog-theme-toggle').count(), 0);
      assert.deepEqual(errors, []);
      await context.close();
      console.log(
        `PASS ${profile.name} ${mode}: themes, persistence, drafts, keyboard, native Back, profile boundaries`,
      );
    }
  }
  console.log(`Screenshots: ${output}`);
} catch (error) {
  if (activePage && !activePage.isClosed()) {
    await activePage.screenshot({ path: path.join(output, 'failure.png') });
  }
  console.error(`Failure screenshot: ${output}/failure.png`);
  throw error;
} finally {
  await browser.close();
  await stopChildProcess(server);
}
