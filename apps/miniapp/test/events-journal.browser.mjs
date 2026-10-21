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
