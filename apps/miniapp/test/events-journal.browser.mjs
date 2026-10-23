import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, devices, webkit } from 'playwright';
import {
  installNativeVisualModeInitScript,
  applyNativeVisualMode,
} from '../../../scripts/miniapp-native-visual-mode.mjs';
import { installMaxBridgeShimInitScript } from '../../../scripts/miniapp-max-bridge-shim.mjs';
import {
  captureBrowserLaunchOptions,
  settleVisualFrame,
} from '../../../scripts/miniapp-smartphone.mjs';

const base = new URL(process.env.MINIAPP_TEST_BASE_URL ?? 'http://127.0.0.1:3015/app/');
if (!['localhost', '127.0.0.1', '[::1]'].includes(base.hostname))
  throw new Error('Local server required');
const output = mkdtempSync(join(tmpdir(), 'maxim-events-journal-'));

async function checkControls(locator, label, viewportWidth, { separate = false } = {}) {
  const controls = await locator.evaluateAll((nodes) =>
    nodes.map((node) => {
      const { x, y, width, height } = node.getBoundingClientRect();
      return { x, y, width, height, name: node.getAttribute('aria-label') ?? node.textContent };
    }),
  );
  assert.ok(controls.length > 0, `${label}: no controls found`);
  for (const control of controls) {
    assert.ok(
      control.width >= 43.5 && control.height >= 43.5,
      `${label}: ${control.name} target is ${control.width}×${control.height}`,
    );
    assert.ok(
      control.x >= -1 && control.x + control.width <= viewportWidth + 1,
      `${label}: ${control.name} is clipped horizontally`,
    );
  }
  if (separate) {
    for (let index = 0; index < controls.length; index += 1) {
      for (const other of controls.slice(index + 1)) {
        const control = controls[index];
        const overlapWidth =
          Math.min(control.x + control.width, other.x + other.width) - Math.max(control.x, other.x);
        const overlapHeight =
          Math.min(control.y + control.height, other.y + other.height) -
          Math.max(control.y, other.y);
        assert.ok(
          overlapWidth <= 1 || overlapHeight <= 1,
          `${label}: ${control.name} overlaps ${other.name}`,
        );
      }
    }
  }
  return controls;
}

const narrowBrowser = await webkit.launch(captureBrowserLaunchOptions('webkit', base.href));
try {
  for (const theme of ['light', 'dark']) {
    const width = 280;
    const height = 603;
    const context = await narrowBrowser.newContext({
      viewport: { width, height },
      screen: { width, height: 667 },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
      userAgent: devices['iPhone SE'].userAgent,
      locale: 'ru-RU',
      timezoneId: 'Europe/Moscow',
      colorScheme: theme,
    });
    try {
      await installNativeVisualModeInitScript(context);
      await installMaxBridgeShimInitScript(context, { platform: 'ios' }, { colorScheme: theme });
      await context.route(/https:\/\/st\.max\.ru\/js\/max-web-app\.js(?:\?.*)?$/u, (route) =>
        route.fulfill({
          contentType: 'application/javascript',
          body: '/* Visual MAX Bridge shim. */',
        }),
      );
      const page = await context.newPage();
      await page.clock.setFixedTime(new Date('2026-07-18T09:00:00.000Z'));
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(new URL('chat/preview-chat/events?preview=1&device=iphone-se', base).href);
      await page.locator('.sanctions-workspace__details-trigger').first().waitFor();
      await applyNativeVisualMode(page, { safeTop: 0, safeBottom: 0 });
      // Follow the public capture flow: open a sanction, visit participants and activity,
      // then return to the journal. A direct history URL misses the grid regression.
      await page.getByRole('radio', { name: 'Ограничения', exact: true }).click();
      await page.locator('.sanctions-workspace__details-trigger').first().click();
      await page.locator('.sanction-details .button--accent').click({ trial: true });
      await page
        .locator('.sanction-details')
        .getByRole('button', { name: 'Закрыть панель', exact: true })
        .click();
      const openHistory = async () => {
        await page.getByRole('radio', { name: 'Журнал', exact: true }).click();
        await page
          .locator('.events-dashboard__body--moderation:not(.events-dashboard__body--loading)')
          .waitFor({ state: 'visible' });
        await page.locator('.event-feed-item, .events-inline-state').first().waitFor();
      };
      await openHistory();
      await page
        .locator('.events-dashboard__range')
        .getByRole('radio', { name: '24ч', exact: true })
        .click();
      const sections = page.getByRole('group', { name: 'Раздел статистики' });
      await sections.getByRole('button', { name: 'Участники', exact: true }).click();
      await page.locator('.participants-roster__list[aria-busy="false"]').waitFor();
      await page
        .getByRole('searchbox', { name: 'Поиск участника' })
        .fill('несуществующий участник');
      await page.getByText('Участники не найдены', { exact: true }).waitFor();
      await page.getByRole('button', { name: 'Сбросить фильтры' }).click();
      await page.locator('.participants-roster__list[aria-busy="false"]').waitFor();
      await sections.getByRole('button', { name: 'События', exact: true }).click();
      await page.locator('.membership-feed__item').first().waitFor();
      await sections.getByRole('button', { name: 'Модерация', exact: true }).click();
      await openHistory();
      await applyNativeVisualMode(page, { safeTop: 0, safeBottom: 0 });
      await page.locator('.events-dashboard__skeleton-line').first().waitFor({ state: 'hidden' });
      await page.locator('.managed-entity-workspace-header__busy').waitFor({ state: 'hidden' });
      await settleVisualFrame(page);
      assert.equal(
        await page.locator('.events-dashboard__range [aria-checked="true"]').innerText(),
        '24ч',
      );
      const geometry = await page.evaluate(() => {
        const rect = (selector) =>
          document.querySelector(selector).getBoundingClientRect().toJSON();
        return {
          viewportWidth: innerWidth,
          header: rect('.events-stage__workspace-header'),
          workspace: rect('.events-screen'),
          content: rect('.shell-content'),
        };
      });
      await page.screenshot({
        path: join(output, `webkit-${width}-${theme}-moderation-history.png`),
        fullPage: true,
        animations: 'disabled',
      });
      assert.ok(
        geometry.header.left >= -1 && geometry.header.right <= width + 1,
        `WebKit ${width}px ${theme}: header exceeds viewport ${JSON.stringify(geometry)}`,
      );
      assert.equal(geometry.viewportWidth, width);
      const metricLabels = await page
        .locator('.events-dashboard__stack .events-dashboard__metric small')
        .evaluateAll((labels) =>
          labels.map((label) => {
            const range = document.createRange();
            range.selectNodeContents(label);
            return { text: label.textContent, lines: range.getClientRects().length };
          }),
        );
      assert.equal(metricLabels.length, 2);
      assert.ok(
        metricLabels.every((label) => label.lines === 1),
        `WebKit ${width}px ${theme}: metric labels break words ${JSON.stringify(metricLabels)}`,
      );
      const controls = await checkControls(
        page.locator('.managed-entity-workspace-header__actions button'),
        `WebKit ${width}px ${theme} header`,
        width,
        { separate: true },
      );
      assert.equal(controls.length, 2);
      assert.ok(
        controls.every((control) => control.y >= 0 && control.y + control.height <= height),
      );
      assert.deepEqual(errors, []);
      console.log(
        `PASS WebKit ${width}px ${theme}: moderation history 24h header and 44px controls`,
      );
    } finally {
      await context.close();
    }
  }
} finally {
  await narrowBrowser.close();
}

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
      for (const section of ['moderation', 'participants', 'activity']) {
        await page.goto(
          new URL(
            `chat/preview-chat/events?preview=1&device=iphone-se&section=${section}&moderationView=history`,
            base,
          ).href,
        );
        const rows = page.locator(
          {
            moderation: '.event-feed-item',
            participants: '.participants-roster__item',
            activity: '.membership-feed__item',
          }[section],
        );
        await rows.first().waitFor();
        await applyNativeVisualMode(page, { safeTop: 20, safeBottom: 0 });
        await page.evaluate(() => document.fonts.ready);
        const refresh = page.getByRole('button', {
          name: section === 'participants' ? 'Обновить участников' : 'Обновить события',
          exact: true,
        });
        await refresh.click();
        await page.waitForFunction(
          (name) => !document.querySelector(`[aria-label="${name}"]`).disabled,
          section === 'participants' ? 'Обновить участников' : 'Обновить события',
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
        const controls = await checkControls(
          page.locator('.managed-entity-workspace-header__actions button'),
          `${section} header`,
          width,
          { separate: true },
        );
        assert.equal(controls.length, section === 'participants' ? 1 : 2);
        for (const rect of controls)
          assert.ok(
            rect.x >= 0 &&
              rect.x + rect.width <= width + 1 &&
              rect.y >= 0 &&
              rect.y + rect.height <= height,
          );
        await checkControls(page.locator('.events-primary-tab'), 'primary tabs', width, {
          separate: true,
        });
        await checkControls(
          page.locator('.events-dashboard__range [role="radio"]'),
          `${section} period`,
          width,
          { separate: true },
        );
        if (section === 'moderation') {
          await checkControls(
            page.getByRole('radiogroup', { name: 'Режим модерации' }).getByRole('radio'),
            'moderation views',
            width,
            { separate: true },
          );
          await checkControls(
            page.getByLabel('Тип события', { exact: true }),
            'event filter',
            width,
          );
        } else if (section === 'participants') {
          const search = page.getByRole('searchbox', { name: 'Поиск участника', exact: true });
          const role = page.getByLabel('Роль участника', { exact: true });
          const activity = page.getByLabel('Активность в MAX', { exact: true });
          await checkControls(
            page.locator('.participants-roster__toolbar > *, .participants-roster__filters select'),
            'participants toolbar and filters',
            width,
            { separate: true },
          );
          await checkControls(search, 'participant search', width);
          await role.selectOption('admins');
          await activity.selectOption('30d');
          await search.fill('несуществующий участник');
          await page.getByText('Участники не найдены', { exact: true }).waitFor();
          const clear = page.getByRole('button', { name: 'Очистить поиск', exact: true });
          await checkControls(clear, 'participant search clear', width);
          await clear.click({ trial: true });
          await page.screenshot({
            path: join(output, `${width}-${theme}-participants-search.png`),
            fullPage: true,
            animations: 'disabled',
          });
          await clear.click();
          assert.equal(await search.inputValue(), '');
          await role.selectOption('all');
          await activity.selectOption('all');
          await rows.first().waitFor();
        } else {
          await checkControls(
            page.locator('.membership-feed__filters [role="radio"]'),
            'activity filters',
            width,
            { separate: true },
          );
        }
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
          true,
          `${section}: horizontal overflow after filtering`,
        );
        await page.screenshot({
          path: join(output, `${width}-${theme}-${section}.png`),
          fullPage: true,
          animations: 'disabled',
        });
      }
      assert.deepEqual(errors, []);
      console.log(
        `PASS journal ${width}px ${theme}: three tabs, refresh, filters, 44px targets, no overlap or horizontal overflow`,
      );
      await context.close();
    }
  }
  console.log(`Journal screenshots: ${output}`);
} finally {
  await browser.close();
}
