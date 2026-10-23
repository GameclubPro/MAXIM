import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';
import presets from '../src/lib/preview-device-presets.json' with { type: 'json' };
import { resolveCaptureDevice, settleVisualFrame } from '../../../scripts/miniapp-smartphone.mjs';
import { installMaxBridgeShimInitScript } from '../../../scripts/miniapp-max-bridge-shim.mjs';
import {
  applyNativeVisualMode,
  installNativeVisualModeInitScript,
} from '../../../scripts/miniapp-native-visual-mode.mjs';

const base = new URL(process.env.MINIAPP_TEST_BASE_URL ?? 'http://127.0.0.1:3015/app/');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname), 'Local preview required');
for (const device of (process.env.MINIAPP_TEST_DEVICES ?? 'iphone-se,iphone,android').split(',')) {
  const capture = resolveCaptureDevice(presets[device]);
  const browser = await { chromium, webkit }[capture.browserName].launch({
    env: { ...process.env, GIO_USE_PROXY_RESOLVER: 'dummy' },
  });
  try {
    for (const theme of ['light', 'dark']) {
      const context = await browser.newContext({
        ...capture.contextOptions,
        colorScheme: theme,
        locale: 'ru-RU',
        timezoneId: 'Europe/Moscow',
      });
      await installNativeVisualModeInitScript(context);
      await installMaxBridgeShimInitScript(context, capture.profile, { colorScheme: theme });
      await context.route('https://st.max.ru/js/max-web-app.js', (route) =>
        route.fulfill({ contentType: 'text/javascript', body: '/* preview bridge */' }),
      );
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.clock.setFixedTime('2026-07-18T09:00:00.000Z');
      const navigate = async (path) => {
        const url = new URL(path.replace(/^\//u, ''), base);
        url.searchParams.set('preview', '1');
        url.searchParams.set('device', device);
        await page.goto(url.href);
        await page.locator('.app-shell').waitFor();
        await applyNativeVisualMode(page, capture.profile);
        await settleVisualFrame(page);
      };
      await navigate('/channel/preview-channel/stats');
      const svg = page.locator('.channel-stats-graph__svg');
      await svg.waitFor();
      await page.evaluate(() => document.fonts.ready);
      await settleVisualFrame(page);
      const chart = await svg.boundingBox();
      assert.ok(chart.height >= 240, `${device}: chart height ${chart.height}`);
      const plotWidth = await svg
        .locator('.channel-stats-graph__grid:not(.channel-stats-graph__grid--vertical)')
        .first()
        .evaluate((grid) => grid.getBoundingClientRect().width);
      assert.ok(
        plotWidth >= capture.contextOptions.viewport.width * 0.8,
        `${device}: useful graph width ${plotWidth} must cover at least 80% of the screen`,
      );
      assert.ok(
        capture.contextOptions.viewport.height - chart.y - 20 >= 120,
        `${device}: graph must appear on the first screen: ${JSON.stringify(chart)}`,
      );
      const slider = page.getByRole('slider', { name: 'Динамика аудитории' });
      assert.equal(
        await slider.locator('.channel-audience-board__heading, output, details').count(),
        0,
        'Metrics must remain outside slider semantics',
      );
      await slider.scrollIntoViewIfNeeded();
      const bounds = await svg.boundingBox();
      await page.touchscreen.tap(bounds.x + bounds.width * 0.4, bounds.y + 70);
      await page.locator('.channel-stats-graph__tooltip').waitFor();
      const selected = await slider.getAttribute('aria-valuenow');
      await page.waitForTimeout(150);
      assert.equal(await slider.getAttribute('aria-valuenow'), selected);
      assert.equal(
        await page.locator('.channel-stats-graph__tooltip').count(),
        1,
        'Tap selection persists after release',
      );
      assert.match(await page.locator('.channel-audience-selection').innerText(), /\d/u);
      assert.equal(
        await slider.evaluate((element) => getComputedStyle(element).touchAction),
        'pan-y',
      );
      await page.getByRole('radio', { name: '30д', exact: true }).click();
      await page.getByRole('button', { name: /Весь период/u }).waitFor();
      await page.waitForFunction(
        () => document.querySelectorAll('.channel-summary-table tbody tr').length === 9,
      );
      await page.getByRole('button', { name: /Весь период/u }).click();
      await page.waitForFunction(
        () => document.querySelectorAll('.channel-summary-table tbody tr').length > 9,
      );
      await page.getByRole('radio', { name: '7д', exact: true }).click();
      await page
        .getByRole('button', { name: 'Последние 9 дней', exact: true })
        .waitFor({ state: 'hidden' });

      await navigate('/chat/preview-chat/events?section=activity');
      await page.locator('.membership-feed__time').first().waitFor();
      for (const fontSize of ['16px', '24px', '32px']) {
        await page.evaluate((size) => {
          document.documentElement.style.fontSize = size;
        }, fontSize);
        await settleVisualFrame(page);
        if (fontSize !== '16px') {
          await page.locator('.events-primary-tabs.is-expanded-text').waitFor();
          await settleVisualFrame(page);
          const tabs = await page.locator('.events-primary-tabs').boundingBox();
          assert.ok(tabs.height <= 72, `Expanded-text navigation stays compact: ${tabs.height}`);
          const selectedTab = await page.locator('.events-primary-tab.is-active').boundingBox();
          assert.ok(
            selectedTab.x >= tabs.x && selectedTab.x + selectedTab.width <= tabs.x + tabs.width + 1,
            'Selected section remains visible',
          );
        }
        const times = await page.locator('.membership-feed__time').evaluateAll((elements) =>
          elements
            .filter((element) => element.getClientRects().length > 0)
            .map((element) => {
              const range = document.createRange();
              range.selectNodeContents(element);
              return {
                value: element.textContent,
                lines: range.getClientRects().length,
                width: element.clientWidth,
                textWidth: element.scrollWidth,
              };
            }),
        );
        for (const time of times) {
          assert.equal(time.lines, 1, `${device} ${fontSize}: split time ${time.value}`);
          assert.ok(
            time.textWidth <= time.width + 1,
            `${device} ${fontSize}: clipped time ${time.value}`,
          );
        }
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
          true,
        );
      }
      await page.evaluate(() => {
        document.documentElement.style.fontSize = '16px';
      });
      let previousStrip;
      for (const top of [360, 650]) {
        await page.evaluate((top) => window.scrollTo({ top, behavior: 'instant' }), top);
        await settleVisualFrame(page);
        const header = await page.locator('.managed-entity-workspace-header').boundingBox();
        const tabs = await page.locator('.events-primary-tabs').boundingBox();
        assert.ok(
          tabs.y >= header.y + header.height,
          'Sticky controls must not overlap the header',
        );
        const strip = await page.screenshot({
          clip: {
            x: 2,
            y: Math.ceil(header.y + header.height) + 1,
            width: capture.contextOptions.viewport.width - 4,
            height: 4,
          },
        });
        const pixels = await page.evaluate(async (encoded) => {
          const image = new Image();
          image.src = `data:image/png;base64,${encoded}`;
          await image.decode();
          const canvas = document.createElement('canvas');
          canvas.width = image.width;
          canvas.height = image.height;
          const context = canvas.getContext('2d');
          context.drawImage(image, 0, 0);
          return Array.from(context.getImageData(0, 0, canvas.width, canvas.height).data);
        }, strip.toString('base64'));
        if (previousStrip) {
          const maxDifference = pixels.reduce(
            (max, value, index) => Math.max(max, Math.abs(value - previousStrip[index])),
            0,
          );
          assert.ok(
            maxDifference <= 2,
            `Content must not show through sticky panels (${device} ${theme}: pixel difference ${maxDifference})`,
          );
        }
        previousStrip = pixels;
      }
      assert.deepEqual(errors, []);
      console.log(
        `PASS mobile statistics ${device} ${theme}: first screen, tap, whole period, text scaling, opaque sticky stack`,
      );
      await context.close();
    }
  } finally {
    await browser.close();
  }
}
