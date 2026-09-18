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

const base = 'http://127.0.0.1:3014/app/';
const output = await mkdtemp(path.join(tmpdir(), 'maxim-publisher-comments-'));
const server = await ensureMiniappDevServer(base);
const browser = await chromium.launch();
async function select(locator) {
  if (!(await locator.isChecked())) await locator.click();
  await locator
    .page()
    .waitForFunction(
      (element) => element.checked && !element.disabled,
      await locator.elementHandle(),
    );
}
try {
  for (const profile of [
    {
      name: 'iphone-se',
      device: devices['iPhone SE'],
      platform: 'ios',
      safeTop: 20,
      safeBottom: 0,
    },
    {
      name: 'android',
      device: devices['Pixel 7'],
      platform: 'android',
      safeTop: 24,
      safeBottom: 0,
    },
    {
      name: 'desktop',
      device: { viewport: { width: 1280, height: 900 } },
      platform: 'web',
      safeTop: 0,
      safeBottom: 0,
    },
  ])
    for (const colorScheme of ['light', 'dark']) {
      const context = await browser.newContext({
        ...profile.device,
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
          body: `import ${JSON.stringify(new URL('test/publisher-comments.fixture.tsx', base).href)};`,
        }),
      );
      await installMaxBridgeShimInitScript(context, profile, { colorScheme });
      await installNativeVisualModeInitScript(context);
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(base);
      const toggle = page.getByRole('button', { name: 'Комментарии', exact: true });
      await toggle.waitFor();
      await applyNativeVisualMode(page, profile);
      assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
      assert.equal(await page.getByRole('radio').count(), 0);
      await page.screenshot({
        path: path.join(output, `${profile.name}-${colorScheme}-collapsed.png`),
      });
      await select(page.getByLabel('Включить комментарии', { exact: true }));
      await toggle.click();
      await select(page.getByLabel('Комментарии для сообщений администраторов', { exact: true }));
      const replacement = page.getByRole('radio', { name: 'От имени бота', exact: true });
      await select(replacement);
      await page.waitForFunction(
        () =>
          window.publisherCommentsTest.changes.at(-1)?.chatComments
            ?.commentsReplaceOriginalEnabled === true,
      );
      await page.getByRole('button', { name: 'Обновить данные', exact: true }).click();
      assert.equal(await replacement.isChecked(), true);
      await page.screenshot({
        path: path.join(output, `${profile.name}-${colorScheme}-expanded.png`),
      });
      const metrics = await page
        .locator('[data-publisher-module="comments"]')
        .evaluate((element) => ({
          overflow: element.scrollWidth - element.clientWidth,
          outside: [...element.querySelectorAll('label, button')].some((control) => {
            const rect = control.getBoundingClientRect();
            return rect.left < 0 || rect.right > innerWidth + 1;
          }),
        }));
      assert.ok(metrics.overflow <= 1 && !metrics.outside, JSON.stringify(metrics));
      await page.getByRole('button', { name: 'О режиме «От имени бота»', exact: true }).click();
      await page.getByRole('dialog').waitFor();
      const dialogLayout = await page.getByRole('dialog').evaluate((dialog) => {
        const rect = dialog.getBoundingClientRect();
        const copy = dialog.querySelector('p');
        const text = copy.getBoundingClientRect();
        return {
          inside:
            rect.left >= 0 &&
            rect.right <= innerWidth + 1 &&
            rect.top >= 0 &&
            rect.bottom <= innerHeight + 1,
          textVisible: copy.contains(document.elementFromPoint(text.left + 5, text.top + 5)),
          overflow: dialog.scrollWidth - dialog.clientWidth,
        };
      });
      assert.ok(
        dialogLayout.inside && dialogLayout.textVisible && dialogLayout.overflow <= 1,
        JSON.stringify(dialogLayout),
      );
      await page.screenshot({ path: path.join(output, `${profile.name}-${colorScheme}-info.png`) });
      await page.keyboard.press('Escape');
      await page.getByRole('dialog').waitFor({ state: 'hidden' });
      await page.evaluate(() => window.publisherCommentsTest.failNext());
      await page.getByRole('radio', { name: 'Кнопка к сообщению', exact: true }).click();
      await page.getByText('Не удалось сохранить', { exact: true }).waitFor();
      assert.equal(await replacement.isChecked(), true);
      await toggle.click();
      await toggle.click();
      assert.equal(await replacement.isChecked(), true);
      await page.goto(`${base}?channel=1`);
      await toggle.waitFor();
      assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
      await toggle.click();
      await page.getByRole('button', { name: 'О комментариях канала', exact: true }).click();
      await page.getByRole('dialog').waitFor();
      assert.deepEqual(errors, []);
      await context.close();
    }
  console.log(`Publisher comments browser checks passed. Screenshots: ${output}`);
} finally {
  await browser.close();
  await stopChildProcess(server);
}
