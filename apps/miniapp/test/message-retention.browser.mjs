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
    { width: 320, height: 568 },
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
      assert.equal(await page.locator('.message-retention-settings').count(), 0);
      const entry = page.getByRole('button', { name: 'Удаление старых сообщений', exact: true });
      await entry.click();
      const panel = page.getByRole('dialog', { name: 'Удаление старых сообщений' });
      const toggle = panel.getByRole('switch', { name: 'Удаление по сроку' });
      await toggle.check();
      await panel.getByRole('radio', { name: '24 часа' }).check();
      await panel.getByRole('button', { name: 'Сохранить', exact: true }).click();
      await panel.getByText('Сохранено', { exact: true }).waitFor();
      await panel.getByRole('button', { name: 'Закрыть панель', exact: true }).click();
      await entry.click();
      assert.equal(await toggle.isChecked(), true);
      assert.equal(await panel.getByRole('radio', { name: '24 часа' }).isChecked(), true);
      await panel.getByRole('radio', { name: '48 часов' }).check();
      await panel.getByRole('button', { name: 'Сохранить', exact: true }).click();
      await panel.getByText('Сохранено', { exact: true }).waitFor();
      await page.waitForTimeout(250);
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
  for (const scenario of [
    'conflict',
    'load-error',
    'write-error',
    'unavailable',
    'large',
    'paused',
    'slow',
    'dirty-back',
  ]) {
    const context = await browser.newContext({
      viewport: { width: scenario === 'large' ? 320 : 360, height: 800 },
      colorScheme: 'light',
    });
    await installMaxBridgeShimInitScript(
      context,
      { platform: 'android' },
      { colorScheme: 'light' },
    );
    await context.addInitScript(() => {
      window.__MAXIM_FORCE_NATIVE_VISUAL_MODE__ = true;
    });
    const page = await context.newPage();
    const url = new URL('chat/preview-chat/settings', base);
    url.search = `?preview=1&device=android&retentionScenario=${scenario}`;
    await page.goto(url.href);
    await page.getByRole('button', { name: 'Удаление старых сообщений', exact: true }).click();
    const panel = page.getByRole('dialog', { name: 'Удаление старых сообщений' });
    if (scenario === 'load-error') {
      await panel.getByText('Не удалось загрузить настройки', { exact: true }).waitFor();
      for (let attempt = 0; attempt < 2; attempt++) {
        await panel.getByRole('button', { name: 'Повторить', exact: true }).click();
        await page.waitForTimeout(150);
        if (await panel.getByRole('switch', { name: 'Удаление по сроку' }).isVisible()) break;
      }
    }
    const toggle = panel.getByRole('switch', { name: 'Удаление по сроку' });
    await toggle.waitFor();
    if (scenario === 'unavailable') assert.equal(await toggle.isDisabled(), true);
    if (scenario === 'dirty-back') {
      await toggle.check();
      assert.equal(
        await page.evaluate(() => {
          const event = new Event('beforeunload', { cancelable: true });
          window.dispatchEvent(event);
          return event.defaultPrevented;
        }),
        true,
      );
      await page.keyboard.press('Escape');
      const confirm = page.getByRole('dialog', { name: 'Не сохранять изменения?' });
      await confirm.getByRole('button', { name: 'Продолжить настройку', exact: true }).click();
      assert.equal(await toggle.isChecked(), true);
      await page.keyboard.press('Escape');
      await confirm.getByRole('button', { name: 'Не сохранять', exact: true }).click();
      await panel.waitFor({ state: 'hidden' });
      await page.getByRole('button', { name: 'Удаление старых сообщений', exact: true }).click();
      assert.equal(await toggle.isChecked(), false);
    }
    if (scenario === 'conflict' || scenario === 'write-error') {
      await toggle.check();
      await panel.getByRole('radio', { name: '24 часа', exact: true }).check();
      await panel.getByRole('button', { name: 'Обновить состояние', exact: true }).click();
      assert.equal(await toggle.isChecked(), true);
      await panel.getByRole('button', { name: 'Сохранить', exact: true }).click();
      if (scenario === 'conflict') {
        await panel.getByText('Настройки изменены в другом сеансе', { exact: true }).waitFor();
        await page.waitForTimeout(250);
        await page.screenshot({ path: join(output, 'conflict-before-resolution.png') });
        assert.equal(await toggle.isChecked(), true);
        await panel.getByRole('button', { name: 'Сохранить мой вариант', exact: true }).click();
      } else {
        await panel.getByText('Не удалось сохранить изменения.', { exact: true }).waitFor();
        assert.equal(await panel.getByRole('radio', { name: '24 часа' }).isChecked(), true);
        await panel.getByRole('button', { name: 'Сохранить', exact: true }).click();
      }
      await panel.getByText('Сохранено', { exact: true }).waitFor();
    }
    assert.equal(await panel.evaluate((node) => node.scrollWidth > node.clientWidth + 2), false);
    assert.equal(
      await panel
        .locator('.message-retention-stats dd')
        .evaluateAll((nodes) => nodes.some((node) => node.scrollWidth > node.clientWidth + 2)),
      false,
    );
    await page.waitForTimeout(250);
    await page.screenshot({ path: join(output, `scenario-${scenario}.png`) });
    await context.close();
  }
  console.log(
    `Retention UI: responsive, theme, recovery and conflict checks passed; screenshots: ${output}`,
  );
} finally {
  await browser.close();
}
