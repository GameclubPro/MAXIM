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
const output = mkdtempSync(join(tmpdir(), 'maxim-channel-stats-'));
const browser = await chromium.launch();
try {
  for (const [width, height] of process.argv.includes('--state-only')
    ? []
    : [
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
      await page.goto(
        new URL(
          'channel/preview-channel/stats?preview=1&device=iphone-se&moderationState=slow',
          base,
        ).href,
      );
      await page.locator('.channel-summary-table tbody tr').first().waitFor();
      await applyNativeVisualMode(page, { safeTop: 20, safeBottom: 0 });
      await page.evaluate(() => document.fonts.ready);
      for (const range of ['24ч', '30д', '7д']) {
        await page
          .getByRole('radiogroup', { name: 'Период статистики канала', exact: true })
          .getByRole('radio', { name: range, exact: true })
          .click();
        await page.locator('.channel-summary-table tbody tr').first().waitFor();
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
          true,
        );
      }
      await page.getByRole('button', { name: 'Обновить статистику', exact: true }).click();
      await page.waitForFunction(
        () => !document.querySelector('[aria-label="Обновить статистику"]').disabled,
      );
      await page.screenshot({
        path: join(output, `${width}-${theme}-overview.png`),
        fullPage: true,
        animations: 'disabled',
      });

      await page.getByRole('radio', { name: 'События', exact: true }).click();
      await page.locator('.membership-feed__item').first().waitFor();
      await page.getByRole('button', { name: 'Обновить события', exact: true }).click();
      await page.waitForFunction(
        () => !document.querySelector('[aria-label="Обновить события"]').disabled,
      );
      for (const filter of ['Вошли', 'Вышли', 'Все']) {
        await page
          .getByRole('radiogroup', { name: 'Фильтр событий входа и выхода' })
          .getByRole('radio', { name: filter, exact: true })
          .click();
        await page.waitForFunction(
          (label) =>
            document.querySelector('.membership-feed__filters [aria-checked="true"]')
              ?.textContent === label,
          filter,
        );
        await page.locator('.membership-feed__item').first().waitFor();
        if (filter !== 'Все')
          assert.equal(
            await page
              .locator(
                filter === 'Вошли'
                  ? '.membership-feed__item--left'
                  : '.membership-feed__item--joined',
              )
              .count(),
            0,
          );
      }
      const trigger = page.locator('.membership-feed__item--joined .channel-member-ban').first();
      const targetName = await trigger.getAttribute('aria-label');
      await trigger.click();
      let dialog = page.getByRole('alertdialog');
      await dialog.waitFor();
      assert.match(await dialog.innerText(), /Только в канале/);
      await dialog.getByRole('button', { name: 'Отмена', exact: true }).click();
      await dialog.waitFor({ state: 'hidden' });
      await page.getByRole('button', { name: targetName, exact: true }).first().click();
      dialog = page.getByRole('alertdialog');
      await dialog.waitFor();
      await page.screenshot({
        path: join(output, `${width}-${theme}-confirm.png`),
        animations: 'disabled',
      });
      const before = await page.locator('.membership-feed__item').count();
      await dialog
        .getByRole('button', { name: 'Заблокировать', exact: true })
        .evaluate((button) => {
          button.click();
          button.click();
        });
      await dialog.getByRole('button', { name: 'Блокируем...', exact: true }).waitFor();
      assert.equal(
        await dialog.getByRole('button', { name: 'Отмена', exact: true }).isDisabled(),
        true,
      );
      await dialog.waitFor({ state: 'hidden' });
      await page.waitForFunction(
        (count) => document.querySelectorAll('.membership-feed__item').length === count + 1,
        before,
      );
      await page.getByRole('button', { name: targetName, exact: true }).first().click();
      dialog = page.getByRole('alertdialog');
      await dialog.getByRole('button', { name: 'Заблокировать', exact: true }).click();
      await dialog.getByRole('alert').waitFor();
      assert.match(await dialog.innerText(), /вышел|удалён/);
      await page.keyboard.press('Escape');
      await dialog.waitFor({ state: 'hidden' });

      await page
        .locator('.membership-feed__name-link')
        .first()
        .evaluate((node) => {
          node.textContent = 'ОченьДлинноеИмяПользователяБезПробелов И Длинная Фамилия';
        });
      await page.locator('.membership-feed__item').first().scrollIntoViewIfNeeded();
      const layout = await page
        .locator('.membership-feed__card')
        .first()
        .evaluate((card) => {
          const avatar = card.querySelector('.membership-feed__avatar').getBoundingClientRect();
          const name = card.querySelector('.membership-feed__name-link').getBoundingClientRect();
          const button = card.querySelector('.channel-member-ban').getBoundingClientRect();
          const row = card.getBoundingClientRect();
          return {
            separated: avatar.right <= name.left + 1 && name.right <= button.left + 1,
            bounded: button.right <= row.right + 1,
            buttonWidth: button.width,
            buttonHeight: button.height,
          };
        });
      assert.equal(layout.separated, true, JSON.stringify(layout));
      assert.equal(layout.bounded, true);
      assert.ok(layout.buttonWidth >= 44 && layout.buttonHeight >= 44);
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
        true,
      );
      await page.screenshot({
        path: join(output, `${width}-${theme}-events.png`),
        fullPage: true,
        animations: 'disabled',
      });
      assert.deepEqual(errors, []);
      console.log(
        `PASS channels ${width}px ${theme}: ranges, refresh, filters, confirmation, single ban, errors, layout`,
      );
      await context.close();
    }
  }

  const page = await browser.newPage();
  page.on('pageerror', (error) => console.error(error.message));
  await page.goto(base.href);
  await page.waitForFunction(() =>
    performance
      .getEntriesByType('resource')
      .some((entry) => entry.name.includes('/react-dom_client.js')),
  );
  await page.evaluate(() => {
    window.channelTestReactUrl = performance
      .getEntriesByType('resource')
      .find((entry) => new URL(entry.name).pathname.endsWith('/react.js')).name;
    window.channelTestReactDomUrl = performance
      .getEntriesByType('resource')
      .find((entry) => new URL(entry.name).pathname.endsWith('/react-dom_client.js')).name;
  });
  await page.evaluate(async () => {
    const {
      default: { createElement, useState },
    } = await import(window.channelTestReactUrl);
    const {
      default: { createRoot },
    } = await import(window.channelTestReactDomUrl);
    const { useEventFeed } = await import('/app/src/lib/use-event-feed.ts');
    const host = document.createElement('div');
    document.body.append(host);
    window.channelFeedCalls = [];
    function Harness() {
      const [scope, setScope] = useState('one');
      const feed = useEventFeed({
        scopeKey: scope,
        enabled: true,
        query: {},
        loadPage: async (query) => {
          window.channelFeedCalls.push({ scope, cursor: query.cursor });
          if (scope === 'empty') return { items: [], hasMore: false, nextCursor: null };
          if (query.cursor) return { items: [{ id: 'second' }], hasMore: false, nextCursor: null };
          return { items: [{ id: 'first' }], hasMore: true, nextCursor: 'first-cursor' };
        },
      });
      window.channelFeed = feed;
      window.channelFeedInitialLoading ??= feed.isReloading;
      window.changeChannelFeedScope = setScope;
      return createElement(
        'div',
        { id: 'channel-feed-harness' },
        feed.items.map((item) => item.id).join(','),
      );
    }
    createRoot(host).render(createElement(Harness));
  });
  await page.waitForFunction(() => window.channelFeed?.firstPage?.nextCursor === 'first-cursor');
  assert.equal(await page.evaluate(() => window.channelFeedInitialLoading), true);
  await page.evaluate(() => window.channelFeed.loadMore());
  await page.waitForFunction(() => window.channelFeed.items.length === 2);
  assert.deepEqual(await page.evaluate(() => window.channelFeed.firstPage), {
    items: [{ id: 'first' }],
    hasMore: true,
    nextCursor: 'first-cursor',
  });
  assert.equal(await page.evaluate(() => window.channelFeed.canAutoRefresh), false);
  await page.evaluate(() => {
    window.previousChannelFeedRetry = window.channelFeed.retry;
    window.changeChannelFeedScope('empty');
  });
  await page.waitForFunction(() => window.channelFeed.firstPage?.items.length === 0);
  assert.deepEqual(await page.evaluate(() => window.channelFeed.firstPage), {
    items: [],
    hasMore: false,
    nextCursor: null,
  });
  const callsBeforeStaleRetry = await page.evaluate(() => window.channelFeedCalls.length);
  await page.evaluate(() => window.previousChannelFeedRetry());
  assert.equal(await page.evaluate(() => window.channelFeedCalls.length), callsBeforeStaleRetry);
  console.log(
    'PASS feed snapshot: first-page cursor survives pagination, empty page replaces stale snapshot',
  );
  await page.evaluate(async () => {
    const {
      default: { createElement },
    } = await import(window.channelTestReactUrl);
    const {
      default: { createRoot },
    } = await import(window.channelTestReactDomUrl);
    const { ChannelStatsOverview } =
      await import('/app/src/components/dashboard/channel-stats-overview.tsx');
    const { createPreviewApiTransport } = await import('/app/src/lib/api/preview-transport.ts');
    const stats = await createPreviewApiTransport().request(
      '/channels/preview-channel/stats?range=7d',
    );
    stats.summary.daily = [{ ...stats.summary.daily[0], joined: null, left: 4 }];
    const host = document.createElement('div');
    document.body.append(host);
    createRoot(host).render(
      createElement(ChannelStatsOverview, { stats, range: '7d', onRangeChange() {} }),
    );
  });
  await page.locator('.channel-summary-table__movement-pill.is-neutral em').waitFor();
  assert.equal(
    await page.locator('.channel-summary-table__movement-pill.is-neutral em').textContent(),
    '—',
  );
  console.log('PASS overview: missing membership count is not displayed as zero');
  await page.close();
  console.log(`Channel screenshots: ${output}`);
} finally {
  await browser.close();
}
