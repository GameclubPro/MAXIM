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

const base = process.env.COMMENT_MODERATION_BASE_URL || 'http://127.0.0.1:3014/app/';
const output = await mkdtemp(path.join(tmpdir(), 'maxim-comment-moderation-'));
const server = await ensureMiniappDevServer(base);
const browser = await chromium.launch();
const profiles = [
  { name: 'iphone-se', device: devices['iPhone SE'], platform: 'ios', safeTop: 20, safeBottom: 0 },
  { name: 'android', device: devices['Pixel 7'], platform: 'android', safeTop: 24, safeBottom: 0 },
  {
    name: 'desktop',
    device: { viewport: { width: 1280, height: 900 } },
    platform: 'web',
    safeTop: 0,
    safeBottom: 0,
  },
];
let activePage;
async function layout(page) {
  const metrics = await page.evaluate(() => {
    const panel = document.querySelector('.comment-moderation-sheet__panel');
    const rect = panel.getBoundingClientRect();
    const title = panel.querySelector('h2');
    const heading = title.getBoundingClientRect();
    return {
      left: rect.left,
      right: rect.right,
      bottom: rect.bottom,
      top: rect.top,
      width: innerWidth,
      height: visualViewport.height + visualViewport.offsetTop,
      overflow: panel.scrollWidth - panel.clientWidth,
      titleVisible: title.contains(document.elementFromPoint(heading.left + 5, heading.top + 5)),
    };
  });
  assert.ok(
    metrics.left >= 0 &&
      metrics.right <= metrics.width + 1 &&
      metrics.top >= 0 &&
      metrics.bottom <= metrics.height + 1 &&
      metrics.overflow <= 1 &&
      metrics.titleVisible,
    JSON.stringify(metrics),
  );
}
async function openAuthor(page) {
  await page
    .locator('[data-message-id="chat-comments-2"] .channel-dialog-message__bubble')
    .press('Enter');
  await page.getByRole('button', { name: 'Ограничить автора', exact: true }).click();
  await page.getByRole('radio', { name: 'Мут', exact: true }).waitFor();
}
try {
  for (const device of profiles)
    for (const colorScheme of ['light', 'dark'])
      for (const profile of ['moderation', 'publisher']) {
        const context = await browser.newContext({
          ...device.device,
          colorScheme,
          reducedMotion: 'reduce',
          locale: 'ru-RU',
        });
        await context.route('https://st.max.ru/js/max-web-app.js', (route) =>
          route.fulfill({ body: '' }),
        );
        await context.route('**/src/main.tsx', (route) =>
          route.fulfill({
            contentType: 'application/javascript',
            body: `import ${JSON.stringify(new URL('test/comment-moderation.fixture.tsx', base).href)};`,
          }),
        );
        await installMaxBridgeShimInitScript(context, device, { colorScheme });
        await installNativeVisualModeInitScript(context);
        const page = await context.newPage();
        activePage = page;
        const errors = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await page.goto(`${base}?profile=${profile}`);
        await page.getByRole('button', { name: 'Ограничения участников', exact: true }).waitFor();
        await applyNativeVisualMode(page, device);
        await openAuthor(page);
        await page.getByLabel('Срок мута', { exact: true }).selectOption('3600');
        await page.getByLabel('Причина', { exact: false }).fill('Повторяющийся спам');
        await layout(page);
        const prefix = `${device.name}-${colorScheme}-${profile}`;
        await page.screenshot({ path: path.join(output, `${prefix}-form.png`) });
        if (device.name === 'iphone-se') {
          await page.evaluate(() => {
            Object.defineProperty(window.visualViewport, 'height', {
              configurable: true,
              value: 340,
            });
            window.visualViewport.dispatchEvent(new Event('resize'));
          });
          await page.waitForTimeout(100);
          await layout(page);
          await page.screenshot({ path: path.join(output, `${prefix}-keyboard.png`) });
          await page.evaluate(() => {
            delete window.visualViewport.height;
            window.visualViewport.dispatchEvent(new Event('resize'));
          });
        }
        await page.getByRole('button', { name: 'Продолжить', exact: true }).click();
        await page.getByRole('heading', { name: 'Подтверждение' }).waitFor();
        await layout(page);
        await page.screenshot({ path: path.join(output, `${prefix}-confirm.png`) });
        await page.evaluate(() => window.commentModerationTest.failNext());
        await page.getByRole('button', { name: 'Применить мут', exact: true }).click();
        await page.getByRole('alert').filter({ hasText: 'Не удалось сохранить' }).waitFor();
        assert.equal(
          await page.getByLabel('Причина', { exact: false }).inputValue(),
          'Повторяющийся спам',
        );
        await page.getByRole('button', { name: 'Продолжить', exact: true }).click();
        await page.getByRole('button', { name: 'Применить мут', exact: true }).click();
        await page.locator('.comment-moderation-sheet').waitFor({ state: 'detached' });
        await page.getByRole('button', { name: 'Ограничения участников', exact: true }).click();
        await page.getByRole('button', { name: /Марина Орлова.*Мут до/ }).waitFor();
        await layout(page);
        await page.screenshot({ path: path.join(output, `${prefix}-list.png`) });
        await page.getByRole('button', { name: /Марина Орлова.*Мут до/ }).click();
        await page.getByRole('button', { name: 'Продолжить', exact: true }).click();
        await page.getByRole('button', { name: 'Снять ограничение', exact: true }).click();
        await page.locator('.comment-moderation-sheet').waitFor({ state: 'detached' });
        await openAuthor(page);
        await page.getByRole('radio', { name: 'Бан без срока', exact: true }).check();
        await page.getByRole('button', { name: 'Продолжить', exact: true }).click();
        await page.getByRole('button', { name: 'Забанить', exact: true }).click();
        await page.locator('.comment-moderation-sheet').waitFor({ state: 'detached' });
        await page.evaluate(() => window.commentModerationTest.asReader('preview-user-8'));
        await page.locator('.channel-dialog-compose__restriction').waitFor();
        assert.equal(await page.locator('.channel-dialog-compose textarea').count(), 0);
        assert.equal(
          await page.getByRole('button', { name: 'Ограничения участников', exact: true }).count(),
          0,
        );
        await page.screenshot({ path: path.join(output, `${prefix}-restricted.png`) });
        await page
          .locator('[data-message-id="chat-comments-2"] .channel-dialog-message__bubble')
          .press('Enter');
        assert.equal(
          await page.getByRole('button', { name: 'Ответить', exact: true }).isDisabled(),
          true,
        );
        assert.equal(
          await page.getByRole('button', { name: 'Удалить', exact: true }).isEnabled(),
          true,
        );
        assert.deepEqual(errors, []);
        console.log(`PASS ${prefix}`);
        await context.close();
      }
} catch (error) {
  if (activePage) await activePage.screenshot({ path: path.join(output, 'failure.png') });
  throw error;
} finally {
  await browser.close();
  if (server) await stopChildProcess(server);
  console.log(`Screenshots: ${output}`);
}
