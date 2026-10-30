import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, devices } from 'playwright';
import {
  allocateMiniappBaseUrl,
  ensureMiniappDevServer,
  stopChildProcess,
} from '../../../scripts/miniapp-local-server.mjs';
import { installMaxBridgeShimInitScript } from '../../../scripts/miniapp-max-bridge-shim.mjs';
import { installNativeVisualModeInitScript } from '../../../scripts/miniapp-native-visual-mode.mjs';
const base =
  process.env.MINIAPP_MARKETPLACE_TEST_BASE_URL ??
  (await allocateMiniappBaseUrl('http://127.0.0.1/app/'));
const server = await ensureMiniappDevServer(base, {
  reuseServer: process.env.MINIAPP_MARKETPLACE_TEST_REUSE_SERVER === '1',
});
const output = await mkdtemp(path.join(tmpdir(), 'maxim-advertising-modules-'));
console.log(`Module screenshots: ${output}`);
let browser;
try {
  browser = await chromium.launch({ headless: true });
  for (const [name, device] of [
    ['iphone', devices['iPhone SE']],
    ['android', devices['Pixel 7']],
  ])
    for (const colorScheme of ['light', 'dark']) {
      const context = await browser.newContext({ ...device, colorScheme });
      await context.route('**/*', (route) =>
        new URL(route.request().url()).origin === new URL(base).origin
          ? route.continue()
          : route.abort(),
      );
      await installMaxBridgeShimInitScript(
        context,
        {},
        { colorScheme, platform: name === 'iphone' ? 'ios' : 'android' },
      );
      await installNativeVisualModeInitScript(context);
      const page = await context.newPage();
      page.setDefaultTimeout(15000);
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(
        `${base}chat/preview-chat/settings?preview=1&profile=moderation&marketplacePilot=1&marketplaceReady=ready`,
      );
      await page.getByRole('button', { name: 'Ссылки', exact: true }).click();
      await page.getByRole('heading', { name: 'Ссылки', exact: true }).waitFor();
      await page.waitForLoadState('networkidle');
      assert.equal(
        await page.locator('.marketplace-module-toggle').count(),
        0,
        'No advertising controls without a public profile',
      );
      await page.goto(
        `${base}chat/preview-chat/settings?preview=1&profile=moderation&marketplacePilot=1&marketplaceReady=ready&marketplacePublished=1`,
      );
      await page.getByRole('button', { name: 'Ссылки', exact: true }).click();
      await page.getByRole('heading', { name: 'Ссылки', exact: true }).waitFor();
      const module = page.locator('.marketplace-module-toggle');
      const toggle = module.getByRole('checkbox', { name: 'Кнопка рекламы', exact: true });
      await toggle.waitFor();
      assert.equal(await toggle.isChecked(), false);
      await toggle.click();
      await page.waitForFunction(
        () =>
          document.querySelector('.marketplace-module-toggle input')?.checked &&
          !document.querySelector('.marketplace-module-toggle input')?.disabled,
      );
      await toggle.scrollIntoViewIfNeeded();
      const box = await toggle.boundingBox();
      assert.ok(box && box.width >= 40 && box.height >= 40);
      await page.screenshot({ path: path.join(output, `${name}-${colorScheme}-links.png`) });
      await page.locator('.settings-drilldown__close:visible').click();
      await page.getByRole('button', { name: 'Рекламная биржа', exact: true }).click();
      const workspace = page.locator('.marketplace-entry');
      await workspace.getByRole('button', { name: 'Кнопка в сообщениях', exact: true }).click();
      await workspace.getByText('Включено 1 из 12', { exact: true }).waitFor();
      await workspace.getByRole('button', { name: 'Выключить все', exact: true }).click();
      await page.waitForFunction(
        () => !document.querySelector('.marketplace-button-policy input[type=checkbox]:checked'),
      );
      await page
        .locator('.marketplace-profile-overlay .settings-drilldown__panel')
        .getByRole('button', { name: 'Закрыть панель', exact: true })
        .click();
      await page.locator('.marketplace-profile-overlay').waitFor({ state: 'detached' });
      await page.getByRole('button', { name: 'Ссылки', exact: true }).click();
      await page.getByRole('heading', { name: 'Ссылки', exact: true }).waitFor();
      await toggle.waitFor();
      assert.equal(await toggle.isChecked(), false);
      await toggle.click();
      await page.waitForFunction(
        () =>
          document.querySelector('.marketplace-module-toggle input')?.checked &&
          !document.querySelector('.marketplace-module-toggle input')?.disabled,
      );
      await page.locator('.settings-drilldown__close:visible').click();
      await page.getByRole('button', { name: 'Рекламная биржа', exact: true }).click();
      await workspace.getByRole('button', { name: 'Настройки карточки', exact: true }).click();
      await workspace.getByRole('button', { name: 'Скрыть профиль', exact: true }).click();
      await workspace.getByRole('button', { name: 'Опубликовать снова', exact: true }).waitFor();
      await page
        .locator('.marketplace-profile-overlay .settings-drilldown__panel')
        .getByRole('button', { name: 'Закрыть панель', exact: true })
        .click();
      await page.locator('.marketplace-profile-overlay').waitFor({ state: 'detached' });
      await page.getByRole('button', { name: 'Ссылки', exact: true }).click();
      await page.getByRole('heading', { name: 'Ссылки', exact: true }).waitFor();
      await page.waitForLoadState('networkidle');
      assert.equal(
        await page.locator('.marketplace-module-toggle').count(),
        0,
        'A hidden profile leaves no advertising toggle or explanatory block in the module',
      );
      await page.getByRole('heading', { name: 'Ссылки', exact: true }).scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(output, `${name}-${colorScheme}-hidden.png`) });
      await page.locator('.settings-drilldown__close:visible').click();
      await page.getByRole('button', { name: 'Рекламная биржа', exact: true }).click();
      await workspace.getByRole('button', { name: 'Кнопка в сообщениях', exact: true }).click();
      await workspace.getByRole('button', { name: 'Выключить все', exact: true }).click();
      await page.waitForFunction(
        () => !document.querySelector('.marketplace-button-policy input[type=checkbox]:checked'),
      );
      assert.deepEqual(errors, []);
      await context.close();
      console.log(`Module scenario passed: ${name}/${colorScheme}`);
    }
} finally {
  await browser?.close();
  await stopChildProcess(server);
}
