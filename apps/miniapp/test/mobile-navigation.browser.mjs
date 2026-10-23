import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium, webkit } from 'playwright';
import presets from '../src/lib/preview-device-presets.json' with { type: 'json' };
import { resolveCaptureDevice, settleVisualFrame } from '../../../scripts/miniapp-smartphone.mjs';
import { installMaxBridgeShimInitScript } from '../../../scripts/miniapp-max-bridge-shim.mjs';
import {
  applyNativeVisualMode,
  installNativeVisualModeInitScript,
} from '../../../scripts/miniapp-native-visual-mode.mjs';

const base = new URL(process.env.MINIAPP_TEST_BASE_URL ?? 'http://127.0.0.1:3015/app/');
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(base.hostname));
const output = 'artifacts/miniapp-screenshots/home-preserved';
await mkdir(output, { recursive: true });
for (const device of ['iphone-se', 'android']) {
  const capture = resolveCaptureDevice(presets[device]);
  const browser = await { chromium, webkit }[capture.browserName].launch({
    env: { ...process.env, GIO_USE_PROXY_RESOLVER: 'dummy' },
  });
  try {
    for (const theme of ['light', 'dark']) {
      const context = await browser.newContext({ ...capture.contextOptions, colorScheme: theme });
      await installNativeVisualModeInitScript(context);
      await installMaxBridgeShimInitScript(context, capture.profile, { colorScheme: theme });
      await context.route('https://st.max.ru/js/max-web-app.js', (route) =>
        route.fulfill({ contentType: 'text/javascript', body: '/* preview bridge */' }),
      );
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.clock.setFixedTime('2026-07-18T09:00:00.000Z');
      await page.goto(new URL(`?preview=1&view=chat&networks=1&device=${device}`, base).href);
      const homeReady = async () => {
        await page.locator('.chats-home--chat').waitFor();
        await page.getByText('Статус списка: Список обновлён', { exact: true }).waitFor();
        await settleVisualFrame(page);
      };
      await homeReady();
      await applyNativeVisualMode(page, capture.profile);
      await page.evaluate(() => document.fonts.ready);
      await settleVisualFrame(page);
      const labels = () => page.locator('.bottom-nav__label').allTextContents();
      assert.deepEqual(await labels(), ['Чаты', 'Каналы', 'Сетки', 'Публик']);
      const catalogGeometry = () =>
        page.locator('.chat-card').evaluateAll((rows) =>
          rows.map((row) => {
            const bounds = row.getBoundingClientRect();
            const style = getComputedStyle(row);
            return {
              id: row.dataset.entityId,
              width: bounds.width,
              height: bounds.height,
              background: style.backgroundColor,
              radius: style.borderRadius,
              actions: [...row.querySelectorAll('[data-action]')].map((el) => el.dataset.action),
            };
          }),
        );
      const before = await catalogGeometry();
      await page.screenshot({ path: `${output}/${device}-${theme}.png` });
      await page.locator('.chat-card [data-action="statistics"]').first().click();
      await page.locator('.events-primary-tabs').waitFor();
      await page.goBack();
      await homeReady();
      const after = (await catalogGeometry()).filter((row) =>
        before.some((original) => original.id === row.id),
      );
      assert.deepEqual(after, before, 'Statistics CSS must not alter home cards');
      assert.deepEqual(await labels(), ['Чаты', 'Каналы', 'Сетки', 'Публик']);
      await page.locator('.bottom-nav').getByText('Сетки', { exact: true }).click();
      await page.locator('.networks-page').waitFor();
      assert.equal(await page.locator('.bottom-nav__item.is-active').innerText(), 'Сетки');
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      assert.deepEqual(errors, []);
      console.log(
        `PASS navigation ${device} ${theme}: four tabs, Networks, unchanged home after statistics`,
      );
      await context.close();
    }
  } finally {
    await browser.close();
  }
}
