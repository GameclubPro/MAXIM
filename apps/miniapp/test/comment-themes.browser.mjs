import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
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
  ['neon', 'Неон'],
  ['obsidian', 'Обсидиан'],
  ['avant', 'Авангард'],
];
const selectedDevices = process.env.COMMENT_THEMES_DEVICES?.split(',');
const selectedSchemes = process.env.COMMENT_THEMES_SCHEMES?.split(',') ?? ['light', 'dark'];
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
    const screenRect = screen.getBoundingClientRect();
    const header = screen.querySelector('.channel-dialog-comments-header').getBoundingClientRect();
    if (
      Math.abs(header.left - screenRect.left) > 1 ||
      Math.abs(header.right - screenRect.right) > 1
    )
      failures.push('header is not full width');
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
    const submit = screen.querySelector('.channel-dialog-submit').getBoundingClientRect();
    if (submit.height > 48 || submit.height < 44)
      failures.push('send button changes height with the draft');
    const themeOptions = screen.querySelector('.comment-theme-sheet__options');
    if (themeOptions && innerHeight >= 560) {
      const bounds = themeOptions.getBoundingClientRect();
      for (const label of themeOptions.querySelectorAll('.comment-theme-sheet__label')) {
        const rect = label.getBoundingClientRect();
        if (rect.top < bounds.top - 1 || rect.bottom > bounds.bottom + 1)
          failures.push('theme label is clipped at full height');
      }
    }
    for (const selector of [
      '.channel-dialog-theme-toggle',
      '.channel-dialog-comments-header__context',
      '.channel-dialog-compose__surface',
      '.comment-theme-sheet__panel',
      '.channel-dialog-compose__emoji-panel',
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
      if (selector === '.channel-dialog-compose__emoji-panel' && rect.top < header.bottom - 1)
        failures.push('emoji picker overlaps the header');
    }
    return failures;
  });
  assert.deepEqual(errors, []);
}

async function assertThemeContrast(page) {
  const failures = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    const colors = new Map();
    const rgba = (color) => {
      if (!colors.has(color)) {
        context.clearRect(0, 0, 1, 1);
        context.fillStyle = color;
        context.fillRect(0, 0, 1, 1);
        colors.set(color, [...context.getImageData(0, 0, 1, 1).data]);
      }
      return colors.get(color);
    };
    const blend = (front, back) =>
      front
        .slice(0, 3)
        .map((value, index) => (value * front[3]) / 255 + back[index] * (1 - front[3] / 255));
    const luminance = (rgb) =>
      rgb
        .map((value) => {
          const channel = value / 255;
          return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
        })
        .reduce((total, value, index) => total + value * [0.2126, 0.7152, 0.0722][index], 0);
    const selectors =
      '.channel-dialog-comments-header h1, .channel-dialog-message__bubble p, .channel-dialog-message__bubble a, .channel-dialog-message__meta strong, .channel-dialog-message__meta time, .channel-dialog-message__grouped-time, .channel-dialog-day time, .channel-dialog-compose__meta span, .channel-dialog-compose__field textarea, .comment-theme-sheet__label, .comment-theme-sheet__done, .comment-theme-sheet__head h2, .channel-dialog-notification-sheet :is(button, strong, span)';
    const failures = [];
    for (const element of document.querySelectorAll(selectors)) {
      if (!element.textContent.trim() && element.tagName !== 'TEXTAREA') continue;
      if (
        element.closest('[inert]') ||
        !element.getBoundingClientRect().height ||
        element.matches(':disabled')
      )
        continue;
      const layers = [];
      for (let parent = element; parent; parent = parent.parentElement) {
        const color = rgba(getComputedStyle(parent).backgroundColor);
        layers.push(color);
        if (color[3] === 255) break;
      }
      let background = [255, 255, 255];
      for (const layer of layers.reverse()) background = blend(layer, background);
      const style = getComputedStyle(element);
      const foreground = blend(rgba(style.color), background);
      const a = luminance(foreground);
      const b = luminance(background);
      const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      const large =
        parseFloat(style.fontSize) >= 24 ||
        (parseFloat(style.fontSize) >= 18.66 && Number(style.fontWeight) >= 700);
      if (ratio < (large ? 3 : 4.5))
        failures.push({ element: element.className || element.tagName, ratio });
    }
    return failures;
  });
  assert.deepEqual(failures, [], 'theme text contrast');
}

try {
  assert.ok(
    selectedSchemes.length > 0 && selectedSchemes.every((mode) => ['light', 'dark'].includes(mode)),
    'unknown color scheme',
  );
  assert.ok(
    !selectedDevices ||
      selectedDevices.every((name) => profiles.some((profile) => profile.name === name)),
    'unknown device',
  );
  for (const profile of profiles) {
    if (selectedDevices && !selectedDevices.includes(profile.name)) continue;
    for (const mode of selectedSchemes) {
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
      });
      await installNativeVisualModeInitScript(context);
      const page = await context.newPage();
      activePage = page;
      const errors = [];
      const wallpapers = new Set();
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('response', (response) => {
        if (/comments-(atlas|chrome|sketch|neon|obsidian|avant)-.*webp/u.test(response.url()))
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
      const draftPrefix = 'Тема меняется, черновик остаётся.';
      const draft = `${draftPrefix}\nВторая строка.\nТретья строка.\nhttps://example.org/${'x'.repeat(110)}`;
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
        await assertThemeContrast(page);
        assert.equal(await dialog.getByRole('radio').count(), 6);
        if (id === 'neon' || id === 'obsidian') {
          assert.equal(
            await page
              .locator('[data-comment-theme]')
              .evaluate((element) => getComputedStyle(element).colorScheme),
            'dark',
          );
        }
        await page.screenshot({
          path: path.join(output, `${profile.name}-${mode}-${id}-sheet.png`),
        });
        await dialog.getByRole('button', { name: 'Готово', exact: true }).click();
        await assertThemeContrast(page);
        await page.screenshot({ path: path.join(output, `${profile.name}-${mode}-${id}.png`) });
        await page.getByRole('button', { name: 'Настройки уведомлений', exact: true }).click();
        await page.getByRole('dialog', { name: 'Уведомления', exact: true }).waitFor();
        await assertThemeContrast(page);
        await page.getByRole('button', { name: 'Отмена', exact: true }).click();
      }
      const photoInput = page.locator(
        '.channel-dialog-compose input[type="file"][accept="image/*"]',
      );
      const photo = {
        name: 'layout-test.webp',
        mimeType: 'image/webp',
        buffer: await readFile(
          new URL('../src/assets/wallpapers/comments-neon-dark.webp', import.meta.url),
        ),
      };
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await photoInput.setInputFiles(photo);
        await page.locator('.channel-dialog-compose__image-chip').waitFor();
        await assertLayout(page);
        await page.locator('.channel-dialog-compose__image-chip-dismiss').click();
      }
      const fileInput = page.locator('.channel-dialog-compose input[type="file"]:not([accept])');
      await fileInput.setInputFiles({
        name: 'layout-check.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from('Comment attachment fixture'),
      });
      await page.locator('.channel-dialog-compose__attachment').waitFor();
      await assertLayout(page);
      await assertThemeContrast(page);
      await page.locator('.channel-dialog-compose__attachment-dismiss').click();
      if (profile.platform === 'android') {
        assert.equal(await photoInput.getAttribute('tabindex'), '0');
        assert.equal(await fileInput.getAttribute('tabindex'), '0');
      }
      await page.getByRole('button', { name: 'Отправить', exact: true }).click();
      await page
        .locator('.channel-dialog-message.is-own')
        .filter({ hasText: draftPrefix })
        .waitFor();
      assert.equal(await page.locator('.channel-dialog-compose__field textarea').inputValue(), '');
      const sentMessage = page
        .locator('.channel-dialog-message.is-own')
        .filter({ hasText: draftPrefix });
      await assertThemeContrast(page);
      await assertLayout(page);
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
      await page.locator('.channel-dialog-message__image-tile').first().click();
      await page.getByRole('dialog', { name: 'Просмотр фото', exact: true }).waitFor();
      await page.getByRole('button', { name: 'Закрыть просмотр', exact: true }).click();
      await page.reload();
      await page.locator('[data-comment-theme="avant"]').waitFor();
      await applyNativeVisualMode(page, profile);
      await page.getByRole('button', { name: 'Оформление комментариев', exact: true }).click();
      await page.getByRole('dialog', { name: 'Оформление', exact: true }).waitFor();
      await page.waitForFunction(
        () => document.activeElement === document.querySelector('.comment-theme-sheet__close'),
      );
      await page.getByRole('radio', { name: 'Авангард', exact: true }).focus();
      await page.keyboard.press('ArrowLeft');
      await page.locator('[data-comment-preview="obsidian"][aria-checked="true"]').waitFor();
      assert.equal(
        await page
          .getByRole('radio', { name: 'Обсидиан', exact: true })
          .getAttribute('aria-checked'),
        'true',
      );
      await page.keyboard.press('Escape');
      await page
        .getByRole('dialog', { name: 'Оформление', exact: true })
        .waitFor({ state: 'hidden' });
      await page.waitForFunction(
        () =>
          document.activeElement ===
          document.querySelector('[aria-label="Оформление комментариев"]'),
      );
      assert.equal(
        await page
          .getByRole('button', { name: 'Оформление комментариев', exact: true })
          .evaluate((element) => element === document.activeElement),
        true,
        'closing the sheet restores focus',
      );
      await page.getByRole('button', { name: 'Оформление комментариев', exact: true }).click();
      await page.getByRole('dialog', { name: 'Оформление', exact: true }).waitFor();
      await page.evaluate(() => window.__MAXIM_VISUAL_BRIDGE_PRESS_BACK__());
      await page.waitForFunction(() => !document.querySelector('.comment-theme-sheet'));
      assert.equal(
        await page.evaluate(() => Boolean(window.__MAXIM_VISUAL_BRIDGE_CLOSED__)),
        false,
      );
      const viewport = page.viewportSize();
      if (profile.platform === 'ios') {
        await page.locator('.channel-dialog-compose__field textarea').fill('Проверка клавиатуры');
        await page.evaluate(() => {
          Object.defineProperty(window.visualViewport, 'height', {
            configurable: true,
            value: 320,
          });
          window.visualViewport.dispatchEvent(new Event('resize'));
        });
        await page.getByRole('button', { name: 'Эмодзи', exact: true }).click();
        await page.locator('.channel-dialog-compose__emoji-panel').waitFor();
        await page.waitForFunction(
          () =>
            document.querySelector('.channel-dialog-compose__emoji-panel').getBoundingClientRect()
              .bottom <=
            window.visualViewport.height + window.visualViewport.offsetTop + 1,
        );
        await page.getByRole('button', { name: 'Закрыть эмодзи', exact: true }).click();
        await page.evaluate(() => {
          delete window.visualViewport.height;
          window.visualViewport.dispatchEvent(new Event('resize'));
        });
      }
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
      await page.getByRole('button', { name: 'Эмодзи', exact: true }).click();
      const emojiPanel = page.locator('.channel-dialog-compose__emoji-panel');
      await emojiPanel.waitFor();
      await assertLayout(page);
      assert.equal(
        await page
          .locator('.channel-dialog-compose__field textarea')
          .evaluate((element) => element === document.activeElement),
        false,
      );
      await emojiPanel.locator('.channel-dialog-compose__emoji-tab').nth(1).click();
      const emoji = await emojiPanel
        .locator('.channel-dialog-compose__emoji')
        .first()
        .textContent();
      await emojiPanel.locator('.channel-dialog-compose__emoji').first().click();
      assert.ok(
        (await page.locator('.channel-dialog-compose__field textarea').inputValue()).endsWith(
          emoji.trim(),
        ),
      );
      await emojiPanel.waitFor();
      await assertLayout(page);
      await page.screenshot({
        path: path.join(output, `${profile.name}-${mode}-emoji-keyboard.png`),
      });
      await page.getByRole('button', { name: 'Закрыть эмодзи', exact: true }).click();
      await page.locator('.channel-dialog-compose__field textarea').fill('x'.repeat(2000));
      await page.getByRole('button', { name: 'Эмодзи', exact: true }).click();
      await emojiPanel.locator('.channel-dialog-compose__emoji').first().click();
      assert.equal(
        (await page.locator('.channel-dialog-compose__field textarea').inputValue()).length,
        2000,
      );
      await page.keyboard.press('Escape');
      await page
        .locator('.channel-dialog-compose__field textarea')
        .fill('Комментарий с открытой клавиатурой');
      await page.getByRole('button', { name: 'Оформление комментариев', exact: true }).click();
      const smallDialog = page.getByRole('dialog', { name: 'Оформление', exact: true });
      await smallDialog.waitFor();
      await page.getByRole('radio', { name: 'Авангард', exact: true }).click();
      await assertLayout(page);
      await smallDialog.getByRole('button', { name: 'Готово', exact: true }).click();
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
        'avant',
      );
      await page.evaluate(() => {
        Object.defineProperty(window.visualViewport, 'offsetTop', {
          configurable: true,
          value: 18,
        });
        window.visualViewport.dispatchEvent(new Event('scroll'));
      });
      await page.waitForFunction(
        () =>
          document.querySelector('[aria-label="Оформление комментариев"]').getBoundingClientRect()
            .top >= 23,
      );
      await assertLayout(page);
      await page.evaluate(() => {
        delete window.visualViewport.offsetTop;
        window.visualViewport.dispatchEvent(new Event('scroll'));
      });
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
