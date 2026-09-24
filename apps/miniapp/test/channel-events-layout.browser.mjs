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
if (!['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)) {
  throw new Error('Local server required');
}
const output = mkdtempSync(join(tmpdir(), 'maxim-channel-events-layout-'));
const browser = await chromium.launch();

async function settle(page) {
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
}

async function assertFilterGeometry(page) {
  const layout = await page.locator('.membership-feed__toolbar').evaluate((toolbar) => {
    const filters = toolbar.querySelector('.membership-feed__filters');
    const group = filters.getBoundingClientRect();
    return {
      toolbar: toolbar.getBoundingClientRect().toJSON(),
      group: group.toJSON(),
      buttons: [...filters.querySelectorAll('button')].map((button) =>
        button.getBoundingClientRect().toJSON(),
      ),
    };
  });
  assert.ok(layout.toolbar.width - layout.group.width <= 25, JSON.stringify(layout));
  for (const button of layout.buttons) {
    assert.ok(button.width >= (layout.group.width - 8) / 3 - 1, JSON.stringify(layout));
    assert.ok(button.height >= 44);
    assert.ok(button.left >= layout.group.left && button.right <= layout.group.right);
  }
  return layout;
}

async function assertStickyStack(page) {
  const layout = await page.evaluate(() => {
    const rect = (selector) => document.querySelector(selector).getBoundingClientRect().toJSON();
    const toolbar = document.querySelector('.membership-feed__toolbar');
    return {
      header: rect('.managed-entity-workspace-header'),
      tabs: rect('.channel-insights__section-tabs'),
      toolbar: toolbar.getBoundingClientRect().toJSON(),
      day: rect('.membership-feed__day'),
      hitTargets: [...toolbar.querySelectorAll('button')].map((button) => {
        const r = button.getBoundingClientRect();
        return button.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
      }),
    };
  });
  assert.ok(Math.abs(layout.header.bottom - layout.tabs.top) <= 1, JSON.stringify(layout));
  assert.ok(Math.abs(layout.tabs.bottom - layout.toolbar.top) <= 1, JSON.stringify(layout));
  assert.ok(Math.abs(layout.toolbar.bottom - layout.day.top) <= 1, JSON.stringify(layout));
  assert.deepEqual(layout.hitTargets, [true, true, true]);
}

try {
  for (const [width, height, platform, safeTop, safeBottom] of [
    [320, 568, 'ios', 20, 0],
    [360, 800, 'android', 24, 16],
    [393, 852, 'ios', 59, 34],
    [430, 932, 'android', 0, 24],
    [1280, 900, 'desktop', 0, 0],
  ]) {
    for (const theme of ['light', 'dark']) {
      const context = await browser.newContext({ viewport: { width, height }, colorScheme: theme });
      await installNativeVisualModeInitScript(context);
      await installMaxBridgeShimInitScript(context, { platform }, { colorScheme: theme });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(
        new URL('channel/preview-channel/stats?preview=1&section=events&moderationState=slow', base)
          .href,
      );
      await page.locator('.membership-feed__item').first().waitFor();
      await applyNativeVisualMode(page, { safeTop, safeBottom });
      await page.evaluate(() => document.fonts.ready);
      await page.waitForFunction(
        () => !document.querySelector('[aria-label="Обновить события"]').disabled,
      );
      await settle(page);
      const before = await assertFilterGeometry(page);
      await page.screenshot({
        path: join(output, `${width}-${theme}-top.png`),
        animations: 'disabled',
      });

      // Preview requests resolve synchronously. Keep the real loading badge in the DOM
      // long enough to measure its effect on the toolbar's grid.
      await page.locator('.membership-feed__toolbar').evaluate((toolbar) => {
        const badge = document.createElement('span');
        badge.className = 'membership-feed__badge';
        toolbar.append(badge);
      });
      const loading = await assertFilterGeometry(page);
      assert.equal(loading.toolbar.height, before.toolbar.height);
      assert.equal(loading.group.width, before.group.width);
      await page.locator('.membership-feed__badge').evaluate((badge) => badge.remove());
      await page.getByRole('button', { name: 'Обновить события', exact: true }).click();
      await page.waitForFunction(
        () => !document.querySelector('[aria-label="Обновить события"]').disabled,
      );

      for (const scrollTop of [350, 650]) {
        await page.evaluate((y) => window.scrollTo(0, y), scrollTop);
        await settle(page);
        await assertStickyStack(page);
      }
      await page.screenshot({
        path: join(output, `${width}-${theme}-scrolled.png`),
        animations: 'disabled',
      });
      for (const filter of ['Вошли', 'Вышли', 'Все']) {
        const option = page
          .getByRole('radiogroup', { name: 'Фильтр событий входа и выхода' })
          .getByRole('radio', { name: filter, exact: true });
        await option.click();
        await option.and(page.locator('[aria-checked="true"]')).waitFor();
        await page.waitForFunction(
          () => !document.querySelector('[aria-label="Обновить события"]').disabled,
        );
        await page.locator('.membership-feed__item').first().waitFor();
        await assertFilterGeometry(page);
      }

      await page.evaluate(() => {
        document.documentElement.style.fontSize = '20px';
        document.querySelector('.membership-feed__name-link').textContent =
          'ОченьДлинноеИмяПользователяБезПробелов И Длинная Фамилия';
        document.querySelector('.channel-events-section__period-copy span').textContent =
          '29 сентября 2026 — 29 октября 2026';
        document.querySelector('.channel-events-section__metric strong').textContent = '1 234 567';
        window.scrollTo(0, 0);
      });
      await settle(page);
      assert.match(
        await page.locator('.membership-feed__name-link').first().innerText(),
        /^ОченьДлинноеИмяПользователяБезПробелов/,
      );
      const overflow = await page.evaluate(() => {
        const selectors =
          '.channel-events-section__period-copy span, .channel-events-section__metric strong, .membership-feed__name-link, .membership-feed__pill';
        return [...document.querySelectorAll(selectors)]
          .filter((node) => node.scrollWidth > node.clientWidth + 1)
          .map((node) => node.className);
      });
      assert.deepEqual(overflow, []);
      const row = await page
        .locator('.membership-feed__card')
        .first()
        .evaluate((card) => {
          const rect = (selector) => card.querySelector(selector).getBoundingClientRect();
          const avatar = rect('.membership-feed__avatar');
          const name = rect('.membership-feed__name-link');
          const pill = rect('.membership-feed__pill');
          const action = rect('.channel-member-ban');
          return (
            avatar.right <= name.left &&
            name.right <= action.left &&
            name.bottom <= pill.top &&
            action.right <= card.getBoundingClientRect().right
          );
        });
      assert.equal(row, true);
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
        true,
      );
      await page.screenshot({
        path: join(output, `${width}-${theme}-large-text.png`),
        animations: 'disabled',
      });
      await page.evaluate(() => window.scrollTo(0, 650));
      await settle(page);
      await assertStickyStack(page);

      await page.getByRole('radio', { name: 'Обзор', exact: true }).click();
      await page.locator('.channel-summary-table').waitFor();
      await page.getByRole('radio', { name: 'События', exact: true }).click();
      await page.locator('.membership-feed__item').first().waitFor();
      await page.evaluate(() => window.scrollTo(0, 650));
      await settle(page);
      await assertStickyStack(page);
      assert.deepEqual(errors, []);
      console.log(
        `PASS channel events ${width}px ${theme}: sticky stack, loading, filters, large text, route reentry`,
      );
      await context.close();
    }
  }
  console.log(`Channel event screenshots: ${output}`);
} finally {
  await browser.close();
}
