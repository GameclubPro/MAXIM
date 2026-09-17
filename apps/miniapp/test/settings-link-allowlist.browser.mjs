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

const baseUrl = 'http://127.0.0.1:3000/app/';
const server = await ensureMiniappDevServer(baseUrl);
const screenshots = await mkdtemp(path.join(tmpdir(), 'maxim-link-allowlist-'));
let browser;

try {
  browser = await chromium.launch({ headless: true });
  for (const [name, device, colorScheme] of [
    ['desktop-light', { viewport: { width: 1280, height: 900 } }, 'light'],
    ['iphone-light', devices['iPhone 15'], 'light'],
    ['iphone-dark', devices['iPhone 15'], 'dark'],
    ['android-light', devices['Pixel 7'], 'light'],
    ['android-dark', devices['Pixel 7'], 'dark'],
    ['iphone-se-light', devices['iPhone SE'], 'light'],
  ]) {
    const context = await browser.newContext({ ...device, colorScheme });
    try {
      await context.route('**/*', (route) =>
        new URL(route.request().url()).origin === new URL(baseUrl).origin
          ? route.continue()
          : route.abort(),
      );
      await installMaxBridgeShimInitScript(context, {}, { colorScheme });
      await installNativeVisualModeInitScript(context);
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(`${baseUrl}chat/preview-chat/settings?preview=1&focus=links`);
      const input = page.getByRole('textbox', { name: 'Адрес разрешённого сайта', exact: true });
      await input.waitFor();
      await applyNativeVisualMode(page, {
        safeTop: name.startsWith('iphone') ? 59 : name.startsWith('android') ? 24 : 0,
        safeBottom: name.startsWith('iphone') ? 34 : 0,
      });
      assert.equal(await page.locator('#settings-links-content').count(), 1);
      await input.fill('mailto:admin@example.com');
      await input.press('Enter');
      const error = page.locator('#allowlist-input-error');
      await error.waitFor();
      assert.equal(await input.getAttribute('aria-invalid'), 'true');
      assert.equal(await input.inputValue(), 'mailto:admin@example.com');
      assert.equal(await input.getAttribute('aria-describedby'), 'allowlist-input-error');
      await error.scrollIntoViewIfNeeded();
      assert.equal(
        await error.evaluate((element) => element.scrollWidth <= element.clientWidth),
        true,
      );
      await page.screenshot({ path: path.join(screenshots, `${name}-validation.png`) });

      await input.fill('regression.example');
      await input.press('Enter');
      const domainRow = page
        .locator('.allowlist-item')
        .filter({ has: page.getByText('regression.example', { exact: true }) });
      await domainRow.waitFor();
      await input.fill('https://regression.example/another-path');
      await input.press('Enter');
      assert.equal(await domainRow.count(), 1);

      await page
        .getByRole('combobox', { name: 'Что разрешить', exact: true })
        .selectOption('WEB_EXACT');
      const exactInput = page.getByRole('textbox', { name: 'Разрешённая ссылка', exact: true });
      const exactUrl = 'https://regression.example/a%20b?literal=%2525';
      await exactInput.fill(exactUrl);
      await exactInput.press('Enter');
      const exactRow = page
        .locator('.allowlist-item')
        .filter({ has: page.getByText(exactUrl, { exact: true }) });
      await exactRow.waitFor();
      await exactRow
        .getByRole('button', { name: `Задать срок для ${exactUrl}`, exact: true })
        .click();
      await exactRow.locator('.allowlist-item__schedule-editor').waitFor();
      await exactRow.getByRole('button', { name: /^Время удаления:/u }).waitFor();
      await page.getByRole('button', { name: 'Закрыть уведомление' }).evaluateAll((buttons) => {
        for (const button of buttons) button.click();
      });
      await exactRow.scrollIntoViewIfNeeded();
      const bounds = await exactRow.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return {
          fits: rect.left >= 0 && rect.right <= innerWidth,
          overflow: element.scrollWidth > element.clientWidth,
        };
      });
      assert.deepEqual(bounds, { fits: true, overflow: false });
      assert.equal(
        await exactRow
          .locator('.time-field__label, .time-field__value')
          .evaluateAll((elements) =>
            elements.every((element) => element.scrollWidth <= element.clientWidth),
          ),
        true,
      );
      await page.screenshot({ path: path.join(screenshots, `${name}-schedule.png`) });
      await exactRow
        .getByLabel('День удаления', { exact: true })
        .fill(new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10));
      await exactRow.getByRole('button', { name: 'Сохранить', exact: true }).click();
      await exactRow.locator('.allowlist-item__schedule-editor').waitFor({ state: 'detached' });
      assert.match(await exactRow.locator('.allowlist-item__type').textContent(), /до /u);
      await exactRow
        .getByRole('button', { name: `Изменить срок для ${exactUrl}`, exact: true })
        .click();
      await exactRow.getByRole('button', { name: 'Убрать таймер', exact: true }).click();
      await exactRow.locator('.allowlist-item__schedule-editor').waitFor({ state: 'detached' });
      assert.match(await exactRow.locator('.allowlist-item__type').textContent(), /без срока/u);
      await exactRow.getByRole('button', { name: `Удалить ${exactUrl}`, exact: true }).click();
      await exactRow.waitFor({ state: 'detached' });
      assert.equal(await domainRow.count(), 1);
      await domainRow
        .getByRole('button', { name: 'Удалить regression.example', exact: true })
        .click();
      await domainRow.waitFor({ state: 'detached' });
      assert.deepEqual(errors, []);
      console.log(`PASS ${name}: validation, duplicate, exact escaping, schedule, removal, layout`);
    } finally {
      await context.close();
    }
  }
  console.log(`Screenshots: ${screenshots}`);
} finally {
  await browser?.close();
  await stopChildProcess(server);
}
