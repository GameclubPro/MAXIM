import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { installMaxBridgeShimInitScript } from '../../../scripts/miniapp-max-bridge-shim.mjs';

const base = process.env.MINIAPP_TEST_BASE_URL ?? 'http://127.0.0.1:5187/app/';
const output = await mkdtemp(join(tmpdir(), 'maxim-retention-visual-'));
const browser = await chromium.launch();
try {
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 360, height: 800 },
    { width: 1280, height: 900 },
  ]) {
    for (const colorScheme of ['light', 'dark']) {
      const context = await browser.newContext({ viewport, colorScheme });
      await installMaxBridgeShimInitScript(
        context,
        { platform: viewport.width === 390 ? 'ios' : 'android' },
        { colorScheme },
      );
      await context.addInitScript(() => {
        window.__MAXIM_FORCE_NATIVE_VISUAL_MODE__ = true;
      });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      const url = new URL('chat/preview-chat/settings', base);
      url.search = '?preview=1&device=iphone';
      await page.goto(url.href);
      const entry = page.getByRole('button', { name: 'Удаление старых сообщений', exact: true });
      await entry.click();
      const panel = page.getByRole('dialog', { name: 'Удаление старых сообщений' });
      const toggle = panel.getByRole('switch', { name: 'Удаление по сроку' });
      await toggle.check();
      await panel.getByRole('radio', { name: '24 часа' }).check();
      await panel.getByRole('button', { name: 'Сохранить', exact: true }).click();
      await page.waitForFunction(
        () =>
          document.querySelector('#settings-message-retention-title') &&
          [...document.querySelectorAll('[role="dialog"] button')].some(
            (button) => button.textContent === 'Сохранить' && button.disabled,
          ),
      );
      await panel.getByRole('button', { name: 'Закрыть панель', exact: true }).click();
      await entry.click();
      assert.equal(await toggle.isChecked(), true);
      assert.equal(await panel.getByRole('radio', { name: '24 часа' }).isChecked(), true);
      await panel.getByRole('radio', { name: '48 часов' }).check();
      await panel.getByRole('button', { name: 'Сохранить', exact: true }).click();
      await page.waitForFunction(() =>
        [...document.querySelectorAll('[role="dialog"] button')].some(
          (button) => button.textContent === 'Сохранить' && button.disabled,
        ),
      );
      const layout = await panel.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        return {
          width: bounds.width,
          left: bounds.left,
          right: bounds.right,
          viewport: innerWidth,
          overflow: element.scrollWidth > element.clientWidth + 2,
          clippedText: [...element.querySelectorAll('label, dt, dd, button')].some(
            (node) => node.scrollWidth > node.clientWidth + 2,
          ),
        };
      });
      assert.equal(layout.overflow, false, JSON.stringify(layout));
      assert.equal(layout.clippedText, false, JSON.stringify(layout));
      assert.ok(layout.left >= -1 && layout.right <= layout.viewport + 1, JSON.stringify(layout));
      assert.deepEqual(errors, []);
      await page.screenshot({ path: join(output, `${viewport.width}-${colorScheme}.png`) });
      await context.close();
    }
  }
  console.log(`Retention UI: six viewport/theme combinations passed; screenshots: ${output}`);
} finally {
  await browser.close();
}
