import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import {
  installNativeVisualModeInitScript,
  applyNativeVisualMode,
} from '../../../scripts/miniapp-native-visual-mode.mjs';
import { installMaxBridgeShimInitScript } from '../../../scripts/miniapp-max-bridge-shim.mjs';

const base = new URL(process.env.MINIAPP_TEST_BASE_URL ?? 'http://127.0.0.1:3015/app/');
if (!['localhost', '127.0.0.1', '[::1]'].includes(base.hostname))
  throw new Error('Local server required');
const output = mkdtempSync(join(tmpdir(), 'maxim-events-journal-'));
const browser = await chromium.launch();
try {
  for (const [width, height] of [
    [320, 568],
    [393, 851],
    [1280, 900],
  ]) {
    for (const theme of ['light', 'dark']) {
      const context = await browser.newContext({ viewport: { width, height }, colorScheme: theme });
      await installNativeVisualModeInitScript(context);
      await installMaxBridgeShimInitScript(
        context,
        { platform: width === 393 ? 'android' : 'ios' },
        { colorScheme: theme },
      );
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      for (const section of ['moderation', 'activity']) {
        await page.goto(
          new URL(
            `chat/preview-chat/events?preview=1&device=iphone-se&section=${section}&moderationView=history`,
            base,
          ).href,
        );
        const rows = page.locator(
          section === 'moderation' ? '.event-feed-item' : '.membership-feed__item',
        );
        await rows.first().waitFor();
        await applyNativeVisualMode(page, { safeTop: 20, safeBottom: 0 });
        await page.evaluate(() => document.fonts.ready);
        const refresh = page.getByRole('button', { name: 'Обновить события', exact: true });
        await refresh.click();
        await page.waitForFunction(
          () => !document.querySelector('[aria-label="Обновить события"]').disabled,
        );
        await page.locator('.events-dashboard__skeleton-line').first().waitFor({ state: 'hidden' });
        await page.locator('.managed-entity-workspace-header__busy').waitFor({ state: 'hidden' });
        await page
          .locator('.events-screen')
          .evaluate((node) =>
            Promise.all(
              node.getAnimations().map((animation) => animation.finished.catch(() => {})),
            ),
          );
        assert.ok((await rows.count()) > 0);
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
          true,
        );
        const controls = await page
          .locator('.managed-entity-workspace-header__actions button')
          .evaluateAll((buttons) =>
            buttons.map((button) => {
              const { x, y, width, height } = button.getBoundingClientRect();
              return { x, y, width, height };
            }),
          );
        assert.equal(controls.length, 2);
        assert.ok(controls[0].x + controls[0].width <= controls[1].x + 1);
        for (const rect of controls)
          assert.ok(
            rect.x >= 0 &&
              rect.x + rect.width <= width + 1 &&
              rect.y >= 0 &&
              rect.y + rect.height <= height,
          );
        await page.screenshot({
          path: join(output, `${width}-${theme}-${section}.png`),
          fullPage: true,
          animations: 'disabled',
        });
      }
      assert.deepEqual(errors, []);
      console.log(
        `PASS journal ${width}px ${theme}: refresh, rows, header bounds, no horizontal overflow`,
      );
      await context.close();
    }
  }
  console.log(`Journal screenshots: ${output}`);
} finally {
  await browser.close();
}
